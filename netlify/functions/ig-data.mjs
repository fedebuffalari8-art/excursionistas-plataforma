// netlify/functions/ig-data.mjs

import { getStore } from '@netlify/blobs';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Error de Graph API');
  return json;
}

async function recordSnapshot(store, followersCount, mediaCount) {
  let history = (await store.get('history', { type: 'json' })) || [];
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

    const media = await graph(
      `${GRAPH}/${tokens.igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=50&access_token=${tokens.pageAccessToken}`
    );

    const followerDeltas = await fetchFollowerDeltas(tokens.igUserId, tokens.pageAccessToken);

    const history = await recordSnapshot(store, profile.followers_count, profile.media_count);

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
    } catch (e) {}

    const audience = await fetchAudience(tokens.igUserId, tokens.pageAccessToken);
    const competitors = await fetchCompetitors(tokens.igUserId, tokens.pageAccessToken);

    return Response.json({
      connected: true,
      profile,
      posts: media.data || [],
      history,
      followerDeltas,
      insights: { reach30d: reachTotal, profileViews30d: profileViewsTotal },
      audience,
      competitors,
    });
  } catch (e) {
    return Response.json({ connected: false, error: e.message });
  }
};
