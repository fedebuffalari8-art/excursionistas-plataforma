// netlify/functions/x-data.mjs
//
// Esta es la que llama el HTML de la plataforma. El access token de X
// dura apenas 2 horas, así que en CADA llamada nos fijamos si venció y,
// si es necesario, lo renovamos con el refresh token antes de pedir
// los datos. X rota el refresh token cada vez que se usa, así que
// siempre guardamos el nuevo antes de seguir.

import { getStore } from '@netlify/blobs';

const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API_BASE = 'https://api.x.com/2';

async function refreshAccessToken(store, tokens){
  const basicAuth = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error_description || json.error);

  const updated = {
    ...tokens,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || tokens.refreshToken, // X rota el refresh token
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  await store.setJSON('tokens', updated);
  return updated;
}

async function recordSnapshot(store, followersCount){
  const history = (await store.get('history', { type: 'json' })) || [];
  const today = new Date().toISOString().slice(0, 10);
  const idx = history.findIndex((h) => h.date === today);
  const entry = { date: today, followers_count: followersCount };
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);
  history.sort((a, b) => (a.date > b.date ? 1 : -1));
  const trimmed = history.slice(-180);
  await store.setJSON('history', trimmed);
  return trimmed;
}

export default async () => {
  const store = getStore('x-data');
  let tokens = await store.get('tokens', { type: 'json' });

  if (!tokens) {
    return Response.json({
      connected: false,
      message: 'Todavía no se conectó X. Hay que visitar /.netlify/functions/x-login?key=TU_ADMIN_SECRET una sola vez.',
    });
  }

  try {
    // Si el access token venció (o vence en menos de 2 minutos), lo renovamos
    if (tokens.expiresAt - Date.now() < 2 * 60 * 1000) {
      tokens = await refreshAccessToken(store, tokens);
    }

    const meRes = await fetch(`${API_BASE}/users/me?user.fields=public_metrics,username,name`, {
      headers: { 'Authorization': `Bearer ${tokens.accessToken}` },
    });
    const meJson = await meRes.json();
    if (meJson.errors) throw new Error(meJson.errors[0]?.detail || 'Error leyendo el perfil.');

    const followers = meJson.data.public_metrics?.followers_count ?? 0;
    const history = await recordSnapshot(store, followers);

    // Últimos posts propios (owned read, el más económico)
    let posts = [];
    try {
      const tweetsRes = await fetch(
        `${API_BASE}/users/${tokens.userId}/tweets?max_results=10&tweet.fields=public_metrics,created_at`,
        { headers: { 'Authorization': `Bearer ${tokens.accessToken}` } }
      );
      const tweetsJson = await tweetsRes.json();
      posts = tweetsJson.data || [];
    } catch (e) {
      // si falla, seguimos sin los posts, no es crítico
    }

    return Response.json({
      connected: true,
      profile: {
        username: meJson.data.username,
        name: meJson.data.name,
        followers_count: followers,
        following_count: meJson.data.public_metrics?.following_count ?? null,
        tweet_count: meJson.data.public_metrics?.tweet_count ?? null,
      },
      posts,
      history,
    });
  } catch (e) {
    return Response.json({ connected: false, error: e.message });
  }
};
