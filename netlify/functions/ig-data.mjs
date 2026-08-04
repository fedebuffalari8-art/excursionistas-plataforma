// netlify/functions/ig-data.mjs

import { getStore } from '@netlify/blobs';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Error de Graph API');
  return json;
}

// Guarda el snapshot de HOY con el número ABSOLUTO de seguidores.
// Solo guarda entradas con valores que parecen cuentas absolutas reales
// (más de 1000 seguidores), así filtra los deltas diarios contaminados
// que se guardaron antes por error.
async function recordSnapshot(store, followersCount, mediaCount) {
  let history = (await store.get('history', { type: 'json' })) || [];

  // Limpiar entradas contaminadas (valores claramente no-absolutos: < 5000)
  // manteniendo solo snapshots razonables para una cuenta de club.
  history = history.filter(h => h.followers_count >= 5000);

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

// Trae el crecimiento diario (DELTA, no absoluto) de los últimos 30 días.
// Lo devolvemos por separado para usarlo solo donde tiene sentido
// (ej: "nuevos seguidores este mes" = suma de deltas del mes).
async function fetchFollowerDeltas(igUserId, token) {
  try {
    const until = Math.floor(Date.now() / 1000);
    const since = until - 35 * 24 * 60 * 60;
    const res = await graph(
      `${GRAPH}/${igUserId}/insights?metric=follower_count&period=day&since=${since}&until=${until}&access_token=${token}`
    );
    const metric = res.data?.find((d) => d.name === 'follower_count');
    if (!metric?.values) return [];
    return metric.values
      .filter((v) => typeof v.value === 'number')
      .map((v) => ({ date: v.end_time.slice(0, 10), delta: v.value }));
  } catch (e) {
    return [];
  }
}

// Trae todos los posts del mes indicado usando paginación.
// Instagram devuelve los posts en orden cronológico inverso.
async function fetchAllPostsForMonth(igUserId, token, yearMonth) {
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
  const allPosts = [];
  let url = `${GRAPH}/${igUserId}/media?fields=${fields}&limit=50&access_token=${token}`;

  while (url) {
    const page = await graph(url);
    if (!page.data?.length) break;

    for (const post of page.data) {
      const postMonth = post.timestamp?.slice(0, 7); // "2026-06"
      if (postMonth === yearMonth) {
        allPosts.push(post);
      } else if (postMonth < yearMonth) {
        // Los posts vienen en orden desc, si ya pasamos el mes buscado no hay más
        return allPosts;
      }
    }

    // Si todavía hay posts del mes o más recientes, seguimos paginando
    url = page.paging?.next || null;
    if (allPosts.length > 200) break; // límite de seguridad
  }

  return allPosts;
}

function sumMetric(insightsData, name) {
  const metric = insightsData?.find((d) => d.name === name);
  if (!metric?.values) return null;
  return metric.values.reduce((acc, v) => acc + (v.value || 0), 0);
}

async function fetchAudience(igUserId, token) {
  const result = { topCities: [], topCountries: [], ageGender: [] };
  try {
    const cityRes = await graph(`${GRAPH}/${igUserId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=city&access_token=${token}`);
    result.topCities = (cityRes.data?.[0]?.total_value?.breakdowns?.[0]?.results || [])
      .map((r) => ({ label: r.dimension_values?.[0] || '—', value: r.value }))
      .sort((a, b) => b.value - a.value).slice(0, 5);
  } catch (e) {}
  try {
    const countryRes = await graph(`${GRAPH}/${igUserId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=country&access_token=${token}`);
    result.topCountries = (countryRes.data?.[0]?.total_value?.breakdowns?.[0]?.results || [])
      .map((r) => ({ label: r.dimension_values?.[0] || '—', value: r.value }))
      .sort((a, b) => b.value - a.value).slice(0, 5);
  } catch (e) {}
  try {
    const ageRes = await graph(`${GRAPH}/${igUserId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=age,gender&access_token=${token}`);
    result.ageGender = (ageRes.data?.[0]?.total_value?.breakdowns?.[0]?.results || [])
      .map((r) => ({ label: (r.dimension_values || []).join(' · '), value: r.value }))
      .sort((a, b) => b.value - a.value).slice(0, 6);
  } catch (e) {}
  return result;
}

const RIVALES = ['defeweb', 'midland.oficial', 'cacolegiales'];

async function fetchCompetitors(igUserId, token) {
  const resultados = [];
  for (const username of RIVALES) {
    try {
      const res = await graph(`${GRAPH}/${igUserId}?fields=business_discovery.username(${username}){username,followers_count,media_count}&access_token=${token}`);
      if (res.business_discovery) resultados.push(res.business_discovery);
    } catch (e) {}
  }
  return resultados;
}

export default async (request) => {
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

    // Últimos 50 posts para el dashboard general (vistas recientes)
    const media = await graph(
      `${GRAPH}/${tokens.igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,video_views,insights.metric(impressions,reach){values}&limit=50&access_token=${tokens.pageAccessToken}`
    );

    // Deltas diarios de los últimos 35 días (para "nuevos seguidores del mes")
    const followerDeltas = await fetchFollowerDeltas(tokens.igUserId, tokens.pageAccessToken);

    const history = await recordSnapshot(store, profile.followers_count, profile.media_count);

    let reachTotal = null;
    let impressionsTotal = null;
    let profileViewsTotal = null;
    const until = Math.floor(Date.now() / 1000);
    const since = until - 30 * 24 * 60 * 60;

    // Separadas en llamadas individuales: si Meta deprecó o rechaza una
    // métrica, antes tumbaba TODA la consulta combinada y las otras dos
    // quedaban en null también sin necesidad.
    try {
      const r = await graph(`${GRAPH}/${tokens.igUserId}/insights?metric=reach&period=day&since=${since}&until=${until}&access_token=${tokens.pageAccessToken}`);
      reachTotal = sumMetric(r.data, 'reach');
    } catch (e) {}
    try {
      const pv = await graph(`${GRAPH}/${tokens.igUserId}/insights?metric=profile_views&period=day&since=${since}&until=${until}&access_token=${tokens.pageAccessToken}`);
      profileViewsTotal = sumMetric(pv.data, 'profile_views');
    } catch (e) {}
    try {
      // "views" reemplazó a "impressions" (deprecada) y Meta exige pedirla
      // con metric_type=total_value en vez de period=day — la respuesta
      // viene como total_value.value, no como un array de values por día.
      const v = await graph(`${GRAPH}/${tokens.igUserId}/insights?metric=views&metric_type=total_value&since=${since}&until=${until}&access_token=${tokens.pageAccessToken}`);
      const found = v.data?.find(d => d.name === 'views');
      impressionsTotal = found?.total_value?.value ?? null;
    } catch (e) {}

    const audience = await fetchAudience(tokens.igUserId, tokens.pageAccessToken);
    const competitors = await fetchCompetitors(tokens.igUserId, tokens.pageAccessToken);

    return Response.json({
      connected: true,
      profile,
      posts: media.data || [],
      history,
      followerDeltas,
      insights: { reach30d: reachTotal, impressions30d: impressionsTotal, profileViews30d: profileViewsTotal },
      audience,
      competitors,
    });
  } catch (e) {
    return Response.json({ connected: false, error: e.message });
  }
};
