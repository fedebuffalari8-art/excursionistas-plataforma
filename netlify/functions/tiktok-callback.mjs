// netlify/functions/tiktok-callback.mjs
//
// A esta función la llama TikTok automáticamente después de que alguien
// autoriza el login en tiktok-login.mjs. Acá se hace el canje del code
// por el access token y se guarda todo en Netlify Blobs — nadie tiene
// que copiar ni pegar ningún token a mano.

import { getStore } from '@netlify/blobs';

const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

export default async (request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const errorDesc = url.searchParams.get('error_description') || url.searchParams.get('error');

  if (errorDesc) {
    return htmlResponse(`❌ TikTok devolvió un error: ${errorDesc}`, 400);
  }
  if (!code) {
    return htmlResponse('❌ Falta el parámetro "code" en la redirección.', 400);
  }

  const redirectUri = `${url.origin}/.netlify/functions/tiktok-callback`;

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    const store = getStore('tiktok-data');
    await store.setJSON('tokens', {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      openId: data.open_id,
      expiresAt: Date.now() + data.expires_in * 1000,
    });

    return htmlResponse(`
      ✅ <b>Conectado correctamente con TikTok</b><br><br>
      Ya podés cerrar esta pestaña. La plataforma va a traer las métricas
      sola, y el token se renueva automáticamente antes de vencer (dura
      24hs, pero el refresh token dura un año).
    `);
  } catch (e) {
    return htmlResponse(`❌ Algo falló durante el login: ${e.message}`, 500);
  }
};

function htmlResponse(message, status = 200) {
  return new Response(
    `<html><body style="font-family:sans-serif; padding:40px; text-align:center; line-height:1.6;">${message}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
