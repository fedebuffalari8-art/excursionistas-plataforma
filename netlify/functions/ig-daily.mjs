// netlify/functions/ig-daily.mjs
//
// Corre SOLA todos los días a las 06:00 UTC, sin que nadie tenga que
// abrir la plataforma. Hace dos cosas:
//   1. Si el token está cerca de vencer (menos de 5 días), lo renueva.
//   2. Guarda el snapshot de seguidores del día, aunque nadie visite el sitio.

import { getStore } from '@netlify/blobs';

const GRAPH = 'https://graph.facebook.com/v21.0';
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

async function graph(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Error de Graph API');
  return json;
}

export default async () => {
  const store = getStore('ig-data');
  let tokens = await store.get('tokens', { type: 'json' });

  if (!tokens) {
    console.log('[ig-daily] Todavía no hay token guardado. Falta hacer el login inicial.');
    return;
  }

  // Renovar si está cerca de vencer
  if (tokens.expiresAt - Date.now() < FIVE_DAYS_MS) {
    try {
      const renewed = await graph(
        `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokens.pageAccessToken}`
      );
      tokens = {
        ...tokens,
        pageAccessToken: renewed.access_token,
        expiresAt: Date.now() + renewed.expires_in * 1000,
      };
      await store.setJSON('tokens', tokens);
      console.log('[ig-daily] Token renovado. Vence:', new Date(tokens.expiresAt).toISOString());
    } catch (e) {
      console.error('[ig-daily] No se pudo renovar el token:', e.message);
      console.error('[ig-daily] Va a hacer falta repetir el login manual en /.netlify/functions/ig-login');
    }
  }

  // Guardar el snapshot de hoy, sin depender de que alguien visite el sitio
  try {
    const profile = await graph(
      `${GRAPH}/${tokens.igUserId}?fields=followers_count,media_count&access_token=${tokens.pageAccessToken}`
    );

    // Completamos primero con el histórico real que Meta tenga guardado
    try {
      const until = Math.floor(Date.now() / 1000);
      const since = until - 30 * 24 * 60 * 60;
      const insightsRes = await graph(
        `${GRAPH}/${tokens.igUserId}/insights?metric=follower_count&period=day&since=${since}&until=${until}&access_token=${tokens.pageAccessToken}`
      );
      const metric = insightsRes.data?.find((d) => d.name === 'follower_count');
      if (metric && metric.values) {
        let history = (await store.get('history', { type: 'json' })) || [];
        const existingDates = new Set(history.map((h) => h.date));
        metric.values
          .filter((v) => typeof v.value === 'number')
          .forEach((v) => {
            const date = v.end_time.slice(0, 10);
            if (!existingDates.has(date)) {
              history.push({ date, followers_count: v.value });
              existingDates.add(date);
            }
          });
        history.sort((a, b) => (a.date > b.date ? 1 : -1));
        await store.setJSON('history', history.slice(-180));
      }
    } catch (e) {
      // sin histórico real disponible, seguimos solo con el registro propio
    }

    const history = (await store.get('history', { type: 'json' })) || [];
    const today = new Date().toISOString().slice(0, 10);
    const idx = history.findIndex((h) => h.date === today);
    const entry = { date: today, followers_count: profile.followers_count, media_count: profile.media_count };
    if (idx >= 0) history[idx] = entry;
    else history.push(entry);
    history.sort((a, b) => (a.date > b.date ? 1 : -1));
    await store.setJSON('history', history.slice(-180));
    console.log('[ig-daily] Snapshot guardado para', today, '- seguidores:', profile.followers_count);
  } catch (e) {
    console.error('[ig-daily] No se pudo guardar el snapshot de hoy:', e.message);
  }
};

// Todos los días a las 06:00 UTC (≈ 03:00 en Argentina)
export const config = { schedule: '0 6 * * *' };
