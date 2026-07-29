// netlify/functions/globalfan-sync.mjs

import { getStore } from '@netlify/blobs';

const GF_BASE = 'https://excursionistas.api.global.fan';
const GF_API  = `${GF_BASE}/graphql`;
const TOKEN_CACHE_KEY = 'gf_token';
const TOKEN_TTL_MS = 55 * 60 * 1000;

async function login() {
  const email    = process.env.GLOBALFAN_EMAIL;
  const password = process.env.GLOBALFAN_PASSWORD;
  if (!email || !password) throw new Error('Faltan GLOBALFAN_EMAIL o GLOBALFAN_PASSWORD en Netlify.');

  const res = await fetch(`${GF_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation userLogin($login: String!, $password: String!) {
        userLogin(login: $login, password: $password) {
          credentials { accessToken tokenType uid client }
          authenticatable { id firstName lastName email }
        }
      }`,
      variables: { login: email, password },
    }),
  });

  const body = await res.json().catch(() => ({}));

  const creds = body?.data?.userLogin?.credentials;
  if (creds?.accessToken) {
    return { accessToken: creds.accessToken, client: creds.client, uid: creds.uid, tokenType: creds.tokenType || 'Bearer' };
  }

  const accessToken = res.headers.get('access-token');
  if (accessToken) {
    return { accessToken, client: res.headers.get('client'), uid: res.headers.get('uid'), tokenType: res.headers.get('token-type') || 'Bearer' };
  }

  throw new Error(`Login falló (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
}

async function getToken(store) {
  try {
    const cached = await store.get(TOKEN_CACHE_KEY, { type: 'json' });
    if (cached?.accessToken && (Date.now() - cached.createdAt) < TOKEN_TTL_MS) return cached;
  } catch (e) {}
  const creds = await login();
  await store.setJSON(TOKEN_CACHE_KEY, { ...creds, createdAt: Date.now() });
  return creds;
}

function authHeaders(creds) {
  return {
    'Content-Type': 'application/json',
    'access-token': creds.accessToken,
    'token-type':   creds.tokenType || 'Bearer',
    'uid':          creds.uid,
    'client':       creds.client,
  };
}

const FANS_QUERY = `
  query fans {
    fans {
      totalCount
      nodes {
        id fileNumber firstName lastName email phoneNumber documentNumber
        isMembershipActive isActive membershipName suspensionReason
        membershipCreatedAt bornAt gender points
        membership { id name price }
      }
    }
  }
`;

function calcEstado(s) {
  if (!s.isActive) return 'Baja';
  if (s.suspensionReason) return 'Suspendido';
  if (s.isMembershipActive) return 'Al día';
  return 'Moroso';
}

async function fetchAllSocios(creds) {
  const res = await fetch(GF_API, {
    method: 'POST',
    headers: authHeaders(creds),
    body: JSON.stringify({ query: FANS_QUERY }),
  });
  const data = await res.json();
  if (data.errors) throw new Error('Error socios: ' + JSON.stringify(data.errors).slice(0, 300));
  const result = data?.data?.fans;
  if (!result) throw new Error('Sin datos: ' + JSON.stringify(data).slice(0, 300));
  const items = result.nodes || [];
  return items.map(s => ({
    numero:          s.fileNumber || s.id || '',
    nombre:          s.firstName || '',
    apellido:        s.lastName || '',
    email:           s.email || '',
    telefono:        s.phoneNumber || '',
    dni:             s.documentNumber || '',
    categoria:       s.membershipName || s.membership?.name || '—',
    estado:          calcEstado(s),
    ultimaCuota:     s.membershipCreatedAt ? s.membershipCreatedAt.slice(0, 10) : '',
    vencimiento:     '',
    activo:          s.isActive,
    membresiaActiva: s.isMembershipActive,
    puntos:          s.points || 0,
  }));
}

export default async (request) => {
  const store = getStore('globalfan-data');
  try {
    const creds  = await getToken(store);
    const socios = await fetchAllSocios(creds);
    const syncedAt = new Date().toISOString();
    await store.setJSON('last-sync', { socios, syncedAt, total: socios.length });
    return Response.json({ ok: true, socios, syncedAt, total: socios.length });
  } catch (e) {
    await store.delete(TOKEN_CACHE_KEY).catch(() => {});
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
};
