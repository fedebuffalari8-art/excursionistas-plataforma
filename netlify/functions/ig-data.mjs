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

// Trae el histórico REAL de seguidores que Meta ya tenía guardado de
// antes (normalmente los últimos ~30 días). Esto evita el "empezamos a
// registrar hoy" - rellena el pasado reciente con datos de verdad, no
// inventados. Si la cuenta no tiene este dato habilitado, no rompe nada.
async function fetchHistoricalFollowers(igUserId, token) {
  try {
    const until = Math.floor(Date.now() / 1000);
    const since = until - 30 * 24 * 60 * 60;
    const res = await graph(
      `${GRAPH}/${igUserId}/insights?metric=follower_count&period=day&since=${since}&until=${until}&access_token=${token}`
    );
    const metric = res.data?.find((d) => d.name === 'follower_count');
    if (!metric || !metric.values) return [];
    return metric.values
      .filter((v) => typeof v.value === 'number')
      .map((v) => ({ date: v.end_time.slice(0, 10), followers_count: v.value }));
  } catch (e) {
    return []; // sin esto, seguimos solo con el registro propio, sin romper nada
  }
}

// Mezcla el histórico real de Meta con el que venimos guardando nosotros.
// El propio (recordSnapshot) tiene prioridad para la fecha de hoy, porque
// es el dato más fresco; para fechas pasadas, completa los huecos.
async function mergeHistoricalData(store, historical) {
  if (!historical.length) return await store.get('history', { type: 'json' }) || [];
  let history = (await store.get('history', { type: 'json' })) || [];
  const existingDates = new Set(history.map((h) => h.date));
  historical.forEach((h) => {
    if (!existingDates.has(h.date)) {
      history.push(h);
      existingDates.add(h.date);
    }
  });
  history.sort((a, b) => (a.date > b.date ? 1 : -1));
  history = history.slice(-180);
  await store.setJSON('history', history);
  return history;
}

function sumMetric(insightsData, name) {
  const metric = insightsData?.find((d) => d.name === name);
  if (!metric || !metric.values) return null;
  return metric.values.reduce((acc, v) => acc + (v.value || 0), 0);
}

// De dónde son los seguidores: ciudades, países y franja de edad/género.
// Requiere cuenta con 100+ seguidores. Si algo falla, devolvemos arrays
// vacíos en vez de romper el resto del dashboard.
async function fetchAudience(igUserId, token) {
  const result = { topCities: [], topCountries: [], ageGender: [] };

  try {
    const cityRes = await graph(
      `${GRAPH}/${igUserId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=city&access_token=${token}`
    );
    const cityResults = cityRes.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    result.topCities = cityResults
      .map((r) => ({ label: r.dimension_values?.[0] || '—', value: r.value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  } catch (e) { /* sin dato, seguimos */ }

  try {
    const countryRes = await graph(
      `${GRAPH}/${igUserId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=country&access_token=${token}`
    );
    const countryResults = countryRes.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    result.topCountries = countryResults
      .map((r) => ({ label: r.dimension_values?.[0] || '—', value: r.value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  } catch (e) { /* sin dato, seguimos */ }

  try {
    const ageRes = await graph(
      `${GRAPH}/${igUserId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=age,gender&access_token=${token}`
    );
    const ageResults = ageRes.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    result.ageGender = ageResults
      .map((r) => ({ label: (r.dimension_values || []).join(' · '), value: r.value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  } catch (e) { /* sin dato, seguimos */ }

  return result;
}

// Comparación con clubes rivales. EDITAR esta lista con los @ reales que
// quieran seguir — solo necesitan ser cuentas públicas de Instagram
// Business o Creator, no hace falta que autoricen nada de nuestro lado.
const RIVALES = ['platense', 'sportivoitaliano', 'caarmenio', 'cadeportivomerlo'];

async function fetchCompetitors(igUserId, token) {
  const resultados = [];
  for (const username of RIVALES) {
    try {
      const res = await graph(
        `${GRAPH}/${igUserId}?fields=business_discovery.username(${username}){username,followers_count,media_count}&access_token=${token}`
      );
      if (res.business_discovery) {
        resultados.push({
          username: res.business_discovery.username,
          followers_count: res.business_discovery.followers_count,
          media_count: res.business_discovery.media_count,
        });
      }
    } catch (e) {
      // esa cuenta puede no ser Business/Creator pública, o no existir con ese @ - seguimos con las demás
    }
  }
  return resultados;
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

    // Primero completamos con el histórico real que Meta ya tenía guardado
    const historical = await fetchHistoricalFollowers(tokens.igUserId, tokens.pageAccessToken);
    await mergeHistoricalData(store, historical);

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

    const audience = await fetchAudience(tokens.igUserId, tokens.pageAccessToken);
    const competitors = await fetchCompetitors(tokens.igUserId, tokens.pageAccessToken);

    return Response.json({
      connected: true,
      profile,
      posts: media.data || [],
      history,
      insights: { reach30d: reachTotal, profileViews30d: profileViewsTotal },
      audience,
      competitors,
    });
  } catch (e) {
    return Response.json({ connected: false, error: e.message });
  }
};
