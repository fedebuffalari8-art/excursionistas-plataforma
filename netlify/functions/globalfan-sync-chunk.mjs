// netlify/functions/globalfan-sync-chunk.mjs

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
  const res = await fetch(GF_API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const text = await res.text();
  try { return JSON.parse(text); } catch(e) { return { errors: [{ message: text.slice(0,200) }] }; }
}

async function login() {
  const email = process.env.GLOBALFAN_EMAIL;
  const password = process.env.GLOBALFAN_PASSWORD;
  const res = await fetch(`${GF_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation userLogin($login: String!, $password: String!) { userLogin(login: $login, password: $password) { credentials { accessToken tokenType uid client } } }`,
      variables: { login: email, password },
    }),
  });
  const body = await res.json().catch(() => ({}));
  const creds = body?.data?.userLogin?.credentials;
  if (creds?.accessToken) return { accessToken: creds.accessToken, client: creds.client, uid: creds.uid, tokenType: creds.tokenType || 'Bearer' };
  throw new Error('Login falló');
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

const FANS_QUERY = `
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
    numero: s.fileNumber || s.id || '', nombre: s.firstName || '', apellido: s.lastName || '',
    email: s.email || '', telefono: s.phoneNumber || '', dni: s.documentNumber || '',
    categoria: s.membershipName || s.membership?.name || '—', estado: calcEstado(s),
    ultimaCuota: s.membershipCreatedAt ? s.membershipCreatedAt.slice(0,10) : '',
    activo: s.isActive, membresiaActiva: s.isMembershipActive,
    puntos: s.points || 0, precio: s.membership?.price || null,
  };
}

function calcStats(socios) {
  const stats = { total: socios.length, alDia: 0, morosos: 0, bajas: 0, porMembresia: {} };
  socios.forEach(s => {
    if (s.estado === 'Al día') stats.alDia++;
    if (s.estado === 'Moroso') stats.morosos++;
    if (['Baja','Suspendido'].includes(s.estado)) stats.bajas++;
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
  const cursor    = url.searchParams.get('cursor') || null;
  const reset     = url.searchParams.get('reset') === '1';
  const getResult = url.searchParams.get('getResult') === '1';

  try {
    if (getResult) {
      const data = await store.get('last-sync', { type: 'json' }).catch(() => null);
      return Response.json({ ok: true, socios: data?.socios || [], syncedAt: data?.syncedAt });
    }

    const creds = await getToken(store);

    if (reset) {
      await store.delete('sync-accumulated').catch(() => {});
      return Response.json({ ok: true, reset: true });
    }

    const vars = cursor ? { first: 100, after: cursor } : { first: 100 };
    const data = await gqlFetch(FANS_QUERY, vars, creds);
    if (data.errors || !data.data?.fans) throw new Error('Error: ' + JSON.stringify(data.errors || data).slice(0, 300));

    const { nodes, pageInfo } = data.data.fans;
    const nuevos = (nodes || []).map(mapSocio);

    const prevRaw = await store.get('sync-accumulated', { type: 'json' }).catch(() => null);
    const prevSocios = prevRaw?.socios || [];
    const acumulados = [...prevSocios, ...nuevos];
    const hasMore = pageInfo?.hasNextPage && pageInfo?.endCursor;

    if (!hasMore) {
      const syncedAt = new Date().toISOString();
      await store.setJSON('last-sync', { socios: acumulados, syncedAt, statsLocales: calcStats(acumulados) });
      await store.delete('sync-accumulated').catch(() => {});
      return Response.json({ ok: true, done: true, total: acumulados.length, syncedAt });
    }

    await store.setJSON('sync-accumulated', { socios: acumulados });
    return Response.json({ ok: true, done: false, fetched: acumulados.length, nextCursor: pageInfo.endCursor });

  } catch(e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
};
