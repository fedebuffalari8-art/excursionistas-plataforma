// netlify/functions/ig-data.mjs
//
// Esta es la que llama el HTML de la plataforma (sin token, sin nada
// sensible en el navegador). Lee el token guardado en Netlify Blobs,
// pide los datos a Meta del lado del servidor, y devuelve un JSON limpio.
// De paso, cada vez que se consulta, guarda el snapshot de seguidores
// de hoy (si todavía no se guardó), para ir armando el histórico real.

import { getStore } from '@netlify/blobs';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Error de Graph API');
  return json;
}

async function recordSnapshot(store, followersCount, mediaCount) {
  const history = (await store.get('history', { type: 'json' })) || [];
  const today = new Date().toISOString().slice(0, 10);
  const idx = history.findIndex((h) => h.date === today);
  const entry = { date: today, followers_count: followersCount, media_count: mediaCount };
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);
  history.sort((a, b) => (a.date > b.date ? 1 : -1));
  const trimmed = history.slice(-180);
  await store.setJSON('history', trimmed);
  return trimmed;
}

function sumMetric(insightsData, name) {
  const metric = insightsData?.find((d) => d.name === name);
  if (!metric || !metric.values) return null;
  return metric.values.reduce((acc, v) => acc + (v.value || 0), 0);
}

export default async () => {
  const store = getStore('ig-data');
  const tokens = await store.get('tokens', { type: 'json' });

  if (!tokens) {
    return Response.json({
      connected: false,
      message: 'Todavía no se conectó Instagram. Hay que visitar /.netlify/functions/ig-login?key=TU_ADMIN_SECRET una sola vez.',
    });
  }

  try {
    const profile = await graph(
      `${GRAPH}/${tokens.igUserId}?fields=followers_count,media_count,username&access_token=${tokens.pageAccessToken}`
    );

    const media = await graph(
      `${GRAPH}/${tokens.igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=12&access_token=${tokens.pageAccessToken}`
    );

    const history = await recordSnapshot(store, profile.followers_count, profile.media_count);

    // Alcance / visitas al perfil de los últimos 30 días (puede no estar
    // disponible para todas las cuentas - si falla, seguimos sin romper).
    let reachTotal = null;
    let profileViewsTotal = null;
    try {
      const until = Math.floor(Date.now() / 1000);
      const since = until - 30 * 24 * 60 * 60;
      const insights = await graph(
        `${GRAPH}/${tokens.igUserId}/insights?metric=reach,profile_views&period=day&since=${since}&until=${until}&access_token=${tokens.pageAccessToken}`
      );
      reachTotal = sumMetric(insights.data, 'reach');
      profileViewsTotal = sumMetric(insights.data, 'profile_views');
    } catch (e) {
      // sin insights, no pasa nada, seguimos con el resto
    }

    return Response.json({
      connected: true,
      profile,
      posts: media.data || [],
      history,
      insights: { reach30d: reachTotal, profileViews30d: profileViewsTotal },
    });
  } catch (e) {
    return Response.json({ connected: false, error: e.message });
  }
};
