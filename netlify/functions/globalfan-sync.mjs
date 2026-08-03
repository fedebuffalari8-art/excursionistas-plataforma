// netlify/functions/globalfan-sync.mjs

import { getStore } from '@netlify/blobs';

const GF_BASE = 'https://excursionistas.api.global.fan';
const GF_API  = `${GF_BASE}/graphql`;
const TOKEN_CACHE_KEY = 'gf_token';
const TOKEN_TTL_MS = 50 * 60 * 1000;

async function gqlFetch(query, variables, creds) {
  const headers = { 'Content-Type': 'application/json' };
  if (creds) {
    headers['access-token'] = creds.accessToken;
    headers['token-type']   = creds.tokenType || 'Bearer';
    headers['uid']          = creds.uid;
    headers['client']       = creds.client;
  }
  const res = await fetch(GF_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch(e) { return { errors: [{ message: 'No-JSON: ' + text.slice(0,200) }] }; }
}

async function login() {
  const email    = process.env.GLOBALFAN_EMAIL;
  const password = process.env.GLOBALFAN_PASSWORD;
  if (!email || !password) throw new Error('Faltan GLOBALFAN_EMAIL o GLOBALFAN_PASSWORD.');
  const res = await fetch(`${GF_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation userLogin($login: String!, $password: String!) {
        userLogin(login: $login, password: $password) {
          credentials { accessToken tokenType uid client }
        }
      }`,
      variables: { login: email, password },
    }),
  });
  const body = await res.json().catch(() => ({}));
  const creds = body?.data?.userLogin?.credentials;
  if (creds?.accessToken) return { accessToken: creds.accessToken, client: creds.client, uid: creds.uid, tokenType: creds.tokenType || 'Bearer' };
  const at = res.headers.get('access-token');
  if (at) return { accessToken: at, client: res.headers.get('client'), uid: res.headers.get('uid'), tokenType: 'Bearer' };
  throw new Error('Login falló: ' + JSON.stringify(body).slice(0, 300));
}

async function getToken(store) {
  try {
    const c = await store.get(TOKEN_CACHE_KEY, { type: 'json' });
    if (c?.accessToken && (Date.now() - c.createdAt) < TOKEN_TTL_MS) return c;
  } catch(e) {}
  const creds = await login();
  await store.setJSON(TOKEN_CACHE_KEY, { ...creds, createdAt: Date.now() });
  return creds;
}

const FANS_PAGE_QUERY = `
  query fans($first: Int, $after: String) {
    fans(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id fileNumber firstName lastName email phoneNumber documentNumber
        isMembershipActive isActive membershipName suspensionReason
        membershipCreatedAt gender points
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

function mapSocio(s) {
  return {
    numero:   s.fileNumber || s.id || '',
    nombre:   s.firstName || '',
    apellido: s.lastName || '',
    email:    s.email || '',
    telefono: s.phoneNumber || '',
    dni:      s.documentNumber || '',
    categoria: s.membershipName || s.membership?.name || '—',
    estado:   calcEstado(s),
    ultimaCuota: s.membershipCreatedAt ? s.membershipCreatedAt.slice(0,10) : '',
    activo:   s.isActive,
    membresiaActiva: s.isMembershipActive,
    puntos:   s.points || 0,
    precio:   s.membership?.price || null,
  };
}

async function fetchAllSocios(creds) {
  const allSocios = [];
  let after = null;

  for (let page = 0; page < 30; page++) {
    const vars = after ? { first: 100, after } : { first: 100 };
    const data = await gqlFetch(FANS_PAGE_QUERY, vars, creds);

    if (data.errors || !data.data?.fans?.nodes) break;

    const { nodes, pageInfo } = data.data.fans;
    nodes.forEach(s => allSocios.push(mapSocio(s)));

    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    after = pageInfo.endCursor;
  }

  return allSocios;
}

function calcStats(socios) {
  const stats = {
    total: socios.length,
    alDia: socios.filter(s => s.estado === 'Al día').length,
    morosos: socios.filter(s => s.estado === 'Moroso').length,
    bajas: socios.filter(s => s.estado === 'Baja').length,
    suspendidos: socios.filter(s => s.estado === 'Suspendido').length,
    porMembresia: {},
  };
  socios.forEach(s => {
    const cat = s.categoria || '—';
    if (!stats.porMembresia[cat]) stats.porMembresia[cat] = { total:0, alDia:0, morosos:0 };
    stats.porMembresia[cat].total++;
    if (s.estado === 'Al día') stats.porMembresia[cat].alDia++;
    if (s.estado === 'Moroso') stats.porMembresia[cat].morosos++;
  });
  return stats;
}

export default async (request) => {
  const store = getStore('globalfan-data');
  const url = new URL(request.url);
  const fullSync = url.searchParams.get('full') === '1';

  try {
    const creds = await getToken(store);

    if (!fullSync) {
      const cached = await store.get('last-sync', { type: 'json' }).catch(() => null);
      if (cached?.socios?.length > 0) {
        fetchAllSocios(creds).then(socios => {
          const statsLocales = calcStats(socios);
          const syncedAt = new Date().toISOString();
          store.setJSON('last-sync', { socios, statsLocales, syncedAt }).catch(() => {});
        }).catch(() => {});

        return Response.json({
          ok: true,
          socios: cached.socios,
          statsLocales: cached.statsLocales,
          syncedAt: cached.syncedAt,
          total: cached.socios.length,
          fromCache: true,
        });
      }
    }

    const socios = await fetchAllSocios(creds);
    const statsLocales = calcStats(socios);
    const syncedAt = new Date().toISOString();
    await store.setJSON('last-sync', { socios, statsLocales, syncedAt });

    return Response.json({ ok: true, socios, statsLocales, syncedAt, total: socios.length });
  } catch(e) {
    await store.delete(TOKEN_CACHE_KEY).catch(() => {});
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
};
