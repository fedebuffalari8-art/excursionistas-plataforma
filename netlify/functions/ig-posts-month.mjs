// netlify/functions/ig-posts-month.mjs
//
// Trae TODOS los posts de un mes concreto, con paginación automática.
// El informe mensual lo llama directamente en vez de filtrar los 50
// que trae ig-data (que pueden no incluir todos los del mes buscado).

import { getStore } from '@netlify/blobs';

const GRAPH = 'https://graph.facebook.com/v22.0';

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

  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,video_views,insights.metric(impressions,reach){values}';
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
        // postMonth > yearMonth: son más recientes, seguimos
      }
      if (doneWithMonth) break;
      nextUrl = page.paging?.next || null;
      if (allPosts.length > 300) break;
    }

    // También traemos los deltas del mes para "nuevos seguidores"
    const [y, m] = yearMonth.split('-');
    const monthStart = Math.floor(new Date(`${y}-${m}-01T00:00:00Z`).getTime() / 1000);
    const monthEnd = Math.floor(new Date(`${y}-${String(parseInt(m)+1).padStart(2,'0')}-01T00:00:00Z`).getTime() / 1000);

    const debug = {};

    // Meta no deja pedir más de 30 días (2.592.000s) en una sola consulta
    // period=day, y los meses de 31 días se pasan por 1 día. Partimos el
    // rango en ventanas de máximo 30 días y sumamos.
    const MAX_RANGE = 30 * 24 * 60 * 60;
    function splitRange(since, until) {
      const chunks = [];
      let s = since;
      while (s < until) {
        const e = Math.min(s + MAX_RANGE, until);
        chunks.push([s, e]);
        s = e;
      }
      return chunks;
    }

    async function sumTimeSeries(metric) {
      let total = 0;
      let huboDatos = false;
      for (const [s, e] of splitRange(monthStart, monthEnd)) {
        const res = await graph(
          `${GRAPH}/${tokens.igUserId}/insights?metric=${metric}&period=day&since=${s}&until=${e}&access_token=${tokens.pageAccessToken}`
        );
        const found = res.data?.find(d => d.name === metric);
        if (found?.values) { total += found.values.reduce((a, v) => a + (v.value || 0), 0); huboDatos = true; }
      }
      return huboDatos ? total : null;
    }

    async function sumTotalValue(metric) {
      let total = 0;
      let huboDatos = false;
      for (const [s, e] of splitRange(monthStart, monthEnd)) {
        const res = await graph(
          `${GRAPH}/${tokens.igUserId}/insights?metric=${metric}&metric_type=total_value&since=${s}&until=${e}&access_token=${tokens.pageAccessToken}`
        );
        const found = res.data?.find(d => d.name === metric);
        if (found?.total_value?.value != null) { total += found.total_value.value; huboDatos = true; }
      }
      return huboDatos ? total : null;
    }

    let newFollowers = null;
    try {
      newFollowers = await sumTimeSeries('follower_count');
      if (newFollowers === null) debug.newFollowers = 'La respuesta no trajo la métrica follower_count.';
    } catch (e) { debug.newFollowers = e.message; }

    let reachMes = null;
    try {
      reachMes = await sumTotalValue('reach');
      if (reachMes === null) debug.reachMes = 'La respuesta no trajo la métrica reach.';
    } catch (e) { debug.reachMes = e.message; }

    // "views" reemplazó a "impressions" (deprecada por Meta) y se pide
    // con metric_type=total_value en vez de la partición por día.
    let impressionsMes = null;
    try {
      impressionsMes = await sumTotalValue('views');
      if (impressionsMes === null) debug.impressionsMes = 'La respuesta no trajo la métrica views.';
    } catch (e) { debug.impressionsMes = e.message; }

    return Response.json({ posts: allPosts, newFollowers, reachMes, impressionsMes, _debug: Object.keys(debug).length ? debug : undefined });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};
