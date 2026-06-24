// netlify/functions/ig-callback.mjs
//
// A esta función la llama Facebook automáticamente después de que alguien
// autoriza el login en ig-login.mjs. Acá es donde se hace el canje a token
// de larga duración y se guarda todo en Netlify Blobs - nadie tiene que
// copiar ni pegar ningún token a mano.

import { getStore } from '@netlify/blobs';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Error de Graph API');
  return json;
}

export default async (request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const errorDesc = url.searchParams.get('error_description') || url.searchParams.get('error');

  if (errorDesc) {
    return htmlResponse(`❌ Facebook devolvió un error: ${errorDesc}`, 400);
  }
  if (!code) {
    return htmlResponse('❌ Falta el parámetro "code" en la redirección.', 400);
  }

  const redirectUri = `${url.origin}/.netlify/functions/ig-callback`;
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  try {
    // 1. Code -> token de usuario de corta duración
    const shortLived = await graph(
      `${GRAPH}/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`
    );

    // 2. Token corto -> token de larga duración (60 días)
    const longLived = await graph(
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLived.access_token}`
    );

    // 3. Buscamos la página de Facebook y la cuenta de Instagram conectada
    const accounts = await graph(
      `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${longLived.access_token}`
    );
    const page = accounts.data && accounts.data[0];
    if (!page) {
      throw new Error('No se encontró ninguna página de Facebook administrada por este usuario.');
    }
    if (!page.instagram_business_account) {
      throw new Error(`La página "${page.name}" no tiene una cuenta de Instagram vinculada todavía.`);
    }

    // 4. Guardamos todo en Netlify Blobs (persiste solo, sin que nadie lo toque)
    const store = getStore('ig-data');
    await store.setJSON('tokens', {
      pageAccessToken: page.access_token,
      igUserId: page.instagram_business_account.id,
      pageId: page.id,
      pageName: page.name,
      expiresAt: Date.now() + longLived.expires_in * 1000,
    });

    return htmlResponse(`
      ✅ <b>Conectado correctamente</b><br><br>
      Página: <b>${page.name}</b><br>
      Cuenta de Instagram: <b>${page.instagram_business_account.id}</b><br><br>
      Ya podés cerrar esta pestaña. De ahora en más, la plataforma trae los
      datos sola, y el token se va a renovar solo antes de vencer.
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
