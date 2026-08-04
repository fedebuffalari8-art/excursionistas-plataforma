// netlify/functions/tiktok-data.mjs
//
// A diferencia de Instagram, el access token de TikTok dura solo 24hs,
// así que esta función lo renueva sola con el refresh_token (que dura
// un año) antes de cada consulta si hace falta.

import { getStore } from '@netlify/blobs';

const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count';
const VIDEO_LIST_URL = 'https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,share_url,view_count,like_count,comment_count,share_count,create_time';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

async function refreshIfNeeded(store, tokens) {
  // 5 minutos de margen antes de que venza
  if (Date.now() < tokens.expiresAt - 5 * 60 * 1000) return tokens;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);

  const fresh = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    openId: tokens.openId,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await store.setJSON('tokens', fresh);
  return fresh;
}

async function recordSnapshot(store, followerCount) {
  let history = (await store.get('history', { type: 'json' })) || [];
  const today = new Date().toISOString().slice(0, 10);
  const idx = history.findIndex((h) => h.date === today);
  const entry = { date: today, followers_count: followerCount };
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);
  history.sort((a, b) => (a.date > b.date ? 1 : -1));
  const trimmed = history.slice(-180);
  await store.setJSON('history', trimmed);
  return trimmed;
}

export default async (request) => {
  const store = getStore('tiktok-data');
  let tokens = await store.get('tokens', { type: 'json' });

  if (!tokens) {
    return Response.json({
      connected: false,
      message: 'Todavía no se conectó TikTok. Hay que visitar /.netlify/functions/tiktok-login?key=TU_ADMIN_SECRET una sola vez.',
    });
  }

  try {
    tokens = await refreshIfNeeded(store, tokens);

    const profileRes = await fetch(USER_INFO_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const profileJson = await profileRes.json();
    if (profileJson.error && profileJson.error.code !== 'ok') {
      throw new Error(profileJson.error.message || 'Error consultando el perfil de TikTok');
    }
    const profile = profileJson.data?.user || {};

    const videosRes = await fetch(VIDEO_LIST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_count: 20 }),
    });
    const videosJson = await videosRes.json();
    const videos = videosJson.data?.videos || [];

    const history = await recordSnapshot(store, profile.follower_count || 0);

    return Response.json({ connected: true, profile, videos, history });
  } catch (e) {
    return Response.json({ connected: false, error: e.message });
  }
};
