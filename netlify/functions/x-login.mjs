// netlify/functions/x-login.mjs
//
// Arranca el login OAuth 2.0 con PKCE contra la API de X.
// Se usa UNA SOLA VEZ (o cuando haya que re-autorizar).
// Uso: https://TU-SITIO.netlify.app/.netlify/functions/x-login?key=TU_ADMIN_SECRET

import { getStore } from '@netlify/blobs';
import crypto from 'crypto';

function base64url(buf){
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export default async (request) => {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (key !== process.env.ADMIN_SECRET) {
    return new Response('Falta o es incorrecta la clave (agregá ?key=...).', { status: 401 });
  }

  const redirectUri = `${url.origin}/.netlify/functions/x-callback`;

  // PKCE: generamos un verifier random y su challenge (SHA-256)
  const codeVerifier = base64url(crypto.randomBytes(40));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));

  // Guardamos el verifier temporalmente para usarlo en el callback
  const store = getStore('x-data');
  await store.setJSON('oauth_pending', { codeVerifier, state, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.X_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'tweet.read users.read offline.access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `https://x.com/i/oauth2/authorize?${params.toString()}`;
  return new Response(null, { status: 302, headers: { Location: authUrl } });
};
