// netlify/functions/x-daily.mjs
//
// Corre sola todos los días. Para X esto es más importante todavía que
// para Instagram, porque el access token dura solo 2 horas - si nadie
// abre la plataforma en varios días, igual queremos que el refresh
// token se siga usando (y rotando) para que no se invalide por inactividad,
// y que el historial de seguidores se siga completando solo.

import { getStore } from '@netlify/blobs';

const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API_BASE = 'https://api.x.com/2';

export default async () => {
  const store = getStore('x-data');
  let tokens = await store.get('tokens', { type: 'json' });

  if (!tokens) {
    console.log('[x-daily] Todavía no hay token guardado. Falta hacer el login inicial.');
    return;
  }

  try {
    // Siempre renovamos (el access token de X dura 2hs, seguro ya venció)
    const basicAuth = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(TOKEN_URL, {
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
    const tokenJson = await tokenRes.json();
    if (tokenJson.error) throw new Error(tokenJson.error_description || tokenJson.error);

    tokens = {
      ...tokens,
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + tokenJson.expires_in * 1000,
    };
    await store.setJSON('tokens', tokens);
    console.log('[x-daily] Token renovado correctamente.');

    const meRes = await fetch(`${API_BASE}/users/me?user.fields=public_metrics`, {
      headers: { 'Authorization': `Bearer ${tokens.accessToken}` },
    });
    const meJson = await meRes.json();
    if (meJson.errors) throw new Error(meJson.errors[0]?.detail || 'Error leyendo perfil.');

    const followers = meJson.data.public_metrics?.followers_count ?? 0;
    const history = (await store.get('history', { type: 'json' })) || [];
    const today = new Date().toISOString().slice(0, 10);
    const idx = history.findIndex((h) => h.date === today);
    const entry = { date: today, followers_count: followers };
    if (idx >= 0) history[idx] = entry; else history.push(entry);
    history.sort((a, b) => (a.date > b.date ? 1 : -1));
    await store.setJSON('history', history.slice(-180));

    console.log('[x-daily] Snapshot guardado. Seguidores:', followers);
  } catch (e) {
    console.error('[x-daily] Falló la sincronización:', e.message);
    console.error('[x-daily] Si el refresh token se invalidó, hay que repetir el login en /.netlify/functions/x-login');
  }
};

export const config = { schedule: '15 6 * * *' };
