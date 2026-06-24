// netlify/functions/ig-login.mjs
//
// Se visita UNA SOLA VEZ (o cada vez que Meta obligue a re-autorizar,
// algo poco común). Arranca el login con Facebook y, al aceptar,
// Facebook redirige a ig-callback.mjs, que guarda todo solo.
//
// Uso: https://TU-SITIO.netlify.app/.netlify/functions/ig-login?key=TU_ADMIN_SECRET

export default async (request) => {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (key !== process.env.ADMIN_SECRET) {
    return new Response('Falta o es incorrecta la clave (agregá ?key=TU_ADMIN_SECRET a la URL).', {
      status: 401,
    });
  }

  const redirectUri = `${url.origin}/.netlify/functions/ig-callback`;

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement,business_management',
    display: 'page',
    extras: JSON.stringify({ setup: { channel: 'IG_API_ONBOARDING' } }),
  });

  const oauthUrl = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;

  return new Response(null, {
    status: 302,
    headers: { Location: oauthUrl },
  });
};
