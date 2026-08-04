// netlify/functions/tiktok-login.mjs
//
// Se visita UNA SOLA VEZ (o cuando TikTok obligue a re-autorizar).
// Arranca el login con TikTok y, al aceptar, TikTok redirige a
// tiktok-callback.mjs, que guarda todo solo.
//
// Uso: https://TU-SITIO.netlify.app/.netlify/functions/tiktok-login?key=TU_ADMIN_SECRET

export default async (request) => {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (key !== process.env.ADMIN_SECRET) {
    return new Response('Falta o es incorrecta la clave (agregá ?key=TU_ADMIN_SECRET a la URL).', {
      status: 401,
    });
  }

  const redirectUri = `${url.origin}/.netlify/functions/tiktok-callback`;
  const state = Math.random().toString(36).slice(2);

  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: 'user.info.basic,user.info.stats,video.list',
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });

  const oauthUrl = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;

  return new Response(null, {
    status: 302,
    headers: { Location: oauthUrl },
  });
};
