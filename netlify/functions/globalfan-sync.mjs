// netlify/functions/globalfan-sync.mjs
//
// Se loguea a Global Fan con las credenciales del club y trae los
// datos de socios y cuotas en tiempo real. Las credenciales viven
// SOLO como variables de entorno en Netlify — nunca en el código.

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
  return res.json();
}

async function login() {
  const email = process.env.GLOBALFAN_EMAIL;
  const password = process.env.GLOBALFAN_PASSWORD;
  if (!email || !password) throw new Error('Variables GLOBALFAN_EMAIL o GLOBALFAN_PASSWORD no configuradas en Netlify.');

  const mutations = [
    {
      query: `mutation Login($email: String!, $password: String!) {
        login(email: $email, password: $password) { token accessToken }
      }`,
      getToken: d => d?.data?.login?.token || d?.data?.login?.accessToken,
    },
    {
      query: `mutation SignIn($email: String!, $password: String!) {
        signIn(email: $email, password: $password) { token accessToken }
      }`,
      getToken: d => d?.data?.signIn?.token || d?.data?.signIn?.accessToken,
    },
    {
      query: `mutation AdminLogin($email: String!, $password: String!) {
        adminLogin(email: $email, password: $password) { token accessToken }
      }`,
      getToken: d => d?.data?.adminLogin?.token || d?.data?.adminLogin?.accessToken,
    },
  ];

  for (const m of mutations) {
    try {
      const data = await gql(m.query, { email, password });
      const token = m.getToken(data);
      if (token) return token;
    } catch (e) {}
  }
  throw new Error('No se pudo autenticar con Global Fan. Verificá email y contraseña en las variables de entorno.');
}

async function getToken(store) {
  try {
    const cached = await store.get(TOKEN_CACHE_KEY, { type: 'json' });
    if (cached && cached.token && (Date.now() - cached.createdAt) < TOKEN_TTL_MS) {
      return cached.token;
    }
  } catch (e) {}
  const token = await login();
  await store.setJSON(TOKEN_CACHE_KEY, { token, createdAt: Date.now() });
  return token;
}

const SOCIOS_QUERY = `
  query GetFans($page: Int, $perPage: Int) {
    fans(page: $page, perPage: $perPage) {
      total
      data {
        id fanNumber firstName lastName email phone dni status
        membershipType { name }
        lastPayment { date amount }
        nextDueDate
        category { name }
      }
    }
  }
`;

const SOCIOS_QUERY_ALT = `
  query GetMembers($page: Int, $limit: Int) {
    members(page: $page, limit: $limit) {
      totalCount
      nodes {
        id memberNumber name surname email phone document status
        plan { name }
        lastPaymentDate expirationDate
      }
    }
  }
`;

async function fetchAllSocios(token) {
  const allSocios = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    let data = await gql(SOCIOS_QUERY, { page, perPage }, token);
    if (data.errors || !data.data?.fans) {
      data = await gql(SOCIOS_QUERY_ALT, { page, limit: perPage }, token);
    }
    const result = data.data?.fans || data.data?.members;
    if (!result) throw new Error('No se pudieron obtener los socios.');
    const items = result.data || result.nodes || [];
    if (!items.length) break;
    for (const s of items) {
      allSocios.push({
        numero: s.fanNumber || s.memberNumber || s.id || '',
        nombre: s.firstName || s.name || '',
        apellido: s.lastName || s.surname || '',
        email: s.email || '',
        telefono: s.phone || '',
        dni: s.dni || s.document || '',
        categoria: s.membershipType?.name || s.plan?.name || s.category?.name || '—',
        estado: normalizeEstado(s.status),
        ultimaCuota: s.lastPayment?.date || s.lastPaymentDate || '',
        montoCuota: s.lastPayment?.amount || null,
        vencimiento: s.nextDueDate || s.expirationDate || '',
      });
    }
    const total = result.total || result.totalCount || 0;
    if (allSocios.length >= total || items.length < perPage) break;
    page++;
    if (page > 20) break;
  }
  return allSocios;
}

function normalizeEstado(raw) {
  if (!raw) return 'Sin datos';
  const v = raw.toLowerCase();
  if (['active','activo','al_dia','al día','aldía','paid','vigente'].some(x => v.includes(x))) return 'Al día';
  if (['moroso','deudor','overdue','debt','vencido','expired'].some(x => v.includes(x))) return 'Moroso';
  if (['suspended','suspendido','inactive','inactivo','baja'].some(x => v.includes(x))) return 'Baja';
  if (['por_vencer','por vencer','upcoming','pending'].some(x => v.includes(x))) return 'Por vencer';
  return raw;
}

export default async (request) => {
  const store = getStore('globalfan-data');
  try {
    const token = await getToken(store);
    const socios = await fetchAllSocios(token);
    await store.setJSON('last-sync', { socios, syncedAt: new Date().toISOString(), total: socios.length });
    return Response.json({ ok: true, socios, syncedAt: new Date().toISOString(), total: socios.length });
  } catch (e) {
    if (e.message?.includes('401') || e.message?.includes('autenti')) {
      await store.delete(TOKEN_CACHE_KEY).catch(() => {});
    }
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
};
