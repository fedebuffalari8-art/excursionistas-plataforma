// netlify/functions/x-callback.mjs
//
// X redirige acá después del login. Canjeamos el "code" por tokens
// (access + refresh) y los guardamos en Netlify Blobs. Nadie copia
// ni pega ningún token a mano.

import { getStore } from '@netlify/blobs';

const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API_BASE = 'https://api.x.com/2';

function htmlResponse(message, status = 200){
  return new Response(
    `<html><body style="font-family:sans-serif; padding:40px; text-align:center; line-height:1.6;">${message}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export default async (request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return htmlResponse(`❌ X devolvió un error: ${error}`, 400);
  if (!code) return htmlResponse('❌ Falta el parámetro "code".', 400);

  const store = getStore('x-data');
  const pending = await store.get('oauth_pending', { type: 'json' });
  if (!pending || pending.state !== state) {
    return htmlResponse('❌ El "state" no coincide o expiró. Repetí el login desde /.netlify/functions/x-login.', 400);
  }

  const redirectUri = `${url.origin}/.netlify/functions/x-callback`;
  const basicAuth = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: pending.codeVerifier,
      }),
    });
    const tokenJson = await tokenRes.json();
    if (tokenJson.error) throw new Error(tokenJson.error_description || tokenJson.error);

    // Pedimos el perfil propio para guardar el ID/username y confirmar que anda
    const meRes = await fetch(`${API_BASE}/users/me?user.fields=public_metrics,username,name`, {
      headers: { 'Authorization': `Bearer ${tokenJson.access_token}` },
    });
    const meJson = await meRes.json();
    if (meJson.errors) throw new Error(meJson.errors[0]?.detail || 'No se pudo leer el perfil.');

    await store.setJSON('tokens', {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      expiresAt: Date.now() + tokenJson.expires_in * 1000,
      userId: meJson.data.id,
      username: meJson.data.username,
      name: meJson.data.name,
    });
    await store.delete('oauth_pending');

    return htmlResponse(`
      ✅ <b>Conectado correctamente</b><br><br>
      Cuenta: <b>@${meJson.data.username}</b><br>
      Seguidores: <b>${meJson.data.public_metrics?.followers_count ?? '—'}</b><br><br>
      Ya podés cerrar esta pestaña. La plataforma trae los datos sola de ahora en más.
    `);
  } catch (e) {
    return htmlResponse(`❌ Algo falló: ${e.message}`, 500);
  }
};
