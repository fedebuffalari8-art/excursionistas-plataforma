// netlify/functions/ig-posts-month.mjs
//
// Trae TODOS los posts de un mes concreto, con paginación automática.
// El informe mensual lo llama directamente en vez de filtrar los 50
// que trae ig-data (que pueden no incluir todos los del mes buscado).

import { getStore } from '@netlify/blobs';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Error de Graph API');
  return json;
}

export default async (request) => {
  const url = new URL(request.url);
  const yearMonth = url.searchParams.get('month'); // "2026-06"

  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    return Response.json({ error: 'Falta el parámetro ?month=YYYY-MM' }, { status: 400 });
  }

  const store = getStore('ig-data');
  const tokens = await store.get('tokens', { type: 'json' });
  if (!tokens) return Response.json({ error: 'No conectado' }, { status: 412 });

  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
  const allPosts = [];
  let nextUrl = `${GRAPH}/${tokens.igUserId}/media?fields=${fields}&limit=50&access_token=${tokens.pageAccessToken}`;

  try {
    while (nextUrl) {
      const page = await graph(nextUrl);
      if (!page.data?.length) break;

      let doneWithMonth = false;
      for (const post of page.data) {
        const postMonth = post.timestamp?.slice(0, 7);
        if (postMonth === yearMonth) {
          allPosts.push(post);
        } else if (postMonth < yearMonth) {
          doneWithMonth = true;
          break;
        }
      }
      if (doneWithMonth) break;
      nextUrl = page.paging?.next || null;
      if (allPosts.length > 300) break;
    }

    const [y, m] = yearMonth.split('-');
    const monthStart = Math.floor(new Date(`${y}-${m}-01T00:00:00Z`).getTime() / 1000);
    const nextM = String(parseInt(m) + 1).padStart(2, '0');
    const nextY = parseInt(m) === 12 ? String(parseInt(y) + 1) : y;
    const nextMonth = parseInt(m) === 12 ? '01' : nextM;
    const monthEnd = Math.floor(new Date(`${nextY}-${nextMonth}-01T00:00:00Z`).getTime() / 1000);

    let newFollowers = null;
    try {
      const deltaRes = await graph(
        `${GRAPH}/${tokens.igUserId}/insights?metric=follower_count&period=day&since=${monthStart}&until=${monthEnd}&access_token=${tokens.pageAccessToken}`
      );
      const metric = deltaRes.data?.find(d => d.name === 'follower_count');
      if (metric?.values) {
        newFollowers = metric.values.reduce((a, v) => a + (v.value || 0), 0);
      }
    } catch (e) {}

    let reachMes = null;
    try {
      const reachRes = await graph(
        `${GRAPH}/${tokens.igUserId}/insights?metric=reach&period=day&since=${monthStart}&until=${monthEnd}&access_token=${tokens.pageAccessToken}`
      );
      const metric = reachRes.data?.find(d => d.name === 'reach');
      if (metric?.values) reachMes = metric.values.reduce((a, v) => a + (v.value || 0), 0);
    } catch (e) {}

    return Response.json({ posts: allPosts, newFollowers, reachMes });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};
