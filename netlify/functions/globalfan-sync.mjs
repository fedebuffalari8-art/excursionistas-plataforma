// netlify/functions/globalfan-sync.mjs

import { getStore } from '@netlify/blobs';

const GF_API = 'https://excursionistas.api.global.fan/graphql';
const TOKEN_CACHE_KEY = 'gf_token';
const TOKEN_TTL_MS = 55 * 60 * 1000;

async function gql(query, variables = {}, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(GF_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch(e) { return { errors: [{ message: 'Respuesta no-JSON: ' + text.slice(0, 200) }] }; }
}

async function login() {
  const login = process.env.GLOBALFAN_EMAIL;
  const password = process.env.GLOBALFAN_PASSWORD;
  if (!login || !password) throw new Error('Faltan variables GLOBALFAN_EMAIL o GLOBALFAN_PASSWORD en Netlify.');

  const data = await gql(
    `mutation userLogin($login: String!, $password: String!) {
      userLogin(login: $login, password: $password) {
        credentials { accessToken tokenType uid client }
        authenticatable { id roleId role { internalName } }
      }
    }`,
    { login, password }
  );

  const creds = data?.data?.userLogin?.credentials;
  if (creds?.accessToken) return { token: creds.accessToken, uid: creds.uid, client: creds.client, tokenType: creds.tokenType };

  if (data?.errors) throw new Error('Login falló: ' + JSON.stringify(data.errors).slice(0, 300));
  throw new Error('Login no devolvió token: ' + JSON.stringify(data).slice(0, 300));
}

async function getToken(store) {
  try {
    const cached = await store.get(TOKEN_CACHE_KEY, { type: 'json' });
    if (cached?.token && (Date.now() - cached.createdAt) < TOKEN_TTL_MS) return cached;
  } catch (e) {}
  const creds = await login();
  const entry = { ...creds, createdAt: Date.now() };
  await store.setJSON(TOKEN_CACHE_KEY, entry);
  return entry;
}

function authHeaders(creds) {
  return {
    'Content-Type': 'application/json',
    'access-token': creds.token,
    'token-type': creds.tokenType || 'Bearer',
    'uid': creds.uid || process.env.GLOBALFAN_EMAIL,
    'client': creds.client || '',
  };
}

const FANS_QUERY = `
  query fans($page: Int, $per: Int) {
    fans(page: $page, per: $per) {
      totalCount
      nodes {
        id fileNumber firstName lastName email phoneNumber documentNumber
        isMembershipActive isActive membershipName membershipId
        membership { id name price }
        suspensionReason createdAt membershipCreatedAt bornAt gender bloodType points
      }
    }
  }
`;

async function fetchAllSocios(creds) {
  const allSocios = [];
  let page = 1;
  const per = 200;

  while (true) {
    const res = await fetch(GF_API, {
      method: 'POST',
      headers: authHeaders(creds),
      body: JSON.stringify({ query: FANS_QUERY, variables: { page, per } }),
    });
    const data = await res.json();
    if (data.errors) throw new Error('Error al traer socios: ' + JSON.stringify(data.errors).slice(0, 300));
    const result = data?.data?.fans;
    if (!result) throw new Error('Estructura inesperada: ' + JSON.stringify(data).slice(0, 300));
    const items = result.nodes || [];
    if (!items.length) break;
    for (const s of items) {
      allSocios.push({
        numero: s.fileNumber || s.id || '',
        nombre: s.firstName || '',
        apellido: s.lastName || '',
        email: s.email || '',
        telefono: s.phoneNumber || '',
        dni: s.documentNumber || '',
        categoria: s.membershipName || s.membership?.name || '—',
        estado: calcEstado(s),
        ultimaCuota: s.membershipCreatedAt ? s.membershipCreatedAt.slice(0, 10) : '',
        vencimiento: '',
        activo: s.isActive,
        membresiaActiva: s.isMembershipActive,
        puntos: s.points || 0,
      });
    }
    const total = result.totalCount || 0;
    if (allSocios.length >= total || items.length < per) break;
    page++;
    if (page > 20) break;
  }
  return allSocios;
}

function calcEstado(s) {
  if (!s.isActive) return 'Baja';
  if (s.suspensionReason) return 'Suspendido';
  if (s.isMembershipActive) return 'Al día';
  return 'Moroso';
}

export default async (request) => {
  const store = getStore('globalfan-data');
  try {
    const creds = await getToken(store);
    const socios = await fetchAllSocios(creds);
    const syncedAt = new Date().toISOString();
    await store.setJSON('last-sync', { socios, syncedAt, total: socios.length });
    return Response.json({ ok: true, socios, syncedAt, total: socios.length });
  } catch (e) {
    await store.delete(TOKEN_CACHE_KEY).catch(() => {});
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
};
