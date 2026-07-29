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
  try { return { ok: true, data: JSON.parse(text) }; }
  catch(e) { return { ok: false, raw: text.slice(0, 500) }; }
}

async function login() {
  const email = process.env.GLOBALFAN_EMAIL;
  const password = process.env.GLOBALFAN_PASSWORD;
  if (!email || !password) throw new Error('Faltan variables GLOBALFAN_EMAIL o GLOBALFAN_PASSWORD en Netlify.');

  const intro = await gql(`{
    __schema {
      mutationType {
        fields {
          name
          args { name type { name kind ofType { name kind } } }
        }
      }
    }
  }`);

  if (intro.ok && intro.data?.data?.__schema?.mutationType?.fields) {
    const mutations = intro.data.data.__schema.mutationType.fields;
    const loginMutation = mutations.find(m =>
      m.name.toLowerCase().includes('login') ||
      m.name.toLowerCase().includes('signin') ||
      m.name.toLowerCase().includes('auth')
    );

    if (loginMutation) {
      const args = loginMutation.args || [];
      const emailArg = args.find(a => a.name.toLowerCase().includes('email') || a.name.toLowerCase().includes('mail') || a.name.toLowerCase().includes('user'));
      const passArg = args.find(a => a.name.toLowerCase().includes('pass') || a.name.toLowerCase().includes('password') || a.name.toLowerCase().includes('pwd'));

      if (emailArg && passArg) {
        const query = `mutation { ${loginMutation.name}(${emailArg.name}: "${email}", ${passArg.name}: "${password}") { token accessToken jwt } }`;
        const result = await gql(query);
        if (result.ok) {
          const d = result.data?.data?.[loginMutation.name];
          const token = d?.token || d?.accessToken || d?.jwt;
          if (token) return token;
        }
        throw new Error(`Mutación ${loginMutation.name} falló: ${JSON.stringify(result).slice(0, 300)}`);
      }
    }
    throw new Error('Mutaciones disponibles: ' + mutations.map(m => m.name).join(', '));
  }

  const attempts = [];
  const queries = [
    { name: 'signIn',       q: `mutation { signIn(email: "${email}", password: "${password}") { token accessToken } }` },
    { name: 'login',        q: `mutation { login(email: "${email}", password: "${password}") { token accessToken } }` },
    { name: 'adminLogin',   q: `mutation { adminLogin(email: "${email}", password: "${password}") { token accessToken } }` },
    { name: 'loginAdmin',   q: `mutation { loginAdmin(email: "${email}", password: "${password}") { token accessToken } }` },
    { name: 'authenticate', q: `mutation { authenticate(email: "${email}", password: "${password}") { token accessToken } }` },
  ];

  for (const q of queries) {
    const r = await gql(q.q);
    const d = r.data?.data?.[q.name];
    const token = d?.token || d?.accessToken;
    if (token) return token;
    attempts.push({ name: q.name, result: JSON.stringify(r).slice(0, 150) });
  }

  throw new Error('Todos los intentos fallaron: ' + JSON.stringify(attempts));
}

async function getToken(store) {
  try {
    const cached = await store.get(TOKEN_CACHE_KEY, { type: 'json' });
    if (cached?.token && (Date.now() - cached.createdAt) < TOKEN_TTL_MS) return cached.token;
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
    let r = await gql(SOCIOS_QUERY, { page, perPage }, token);
    if (!r.ok || r.data?.errors || !r.data?.data?.fans) {
      r = await gql(SOCIOS_QUERY_ALT, { page, limit: perPage }, token);
    }
    const result = r.data?.data?.fans || r.data?.data?.members;
    if (!result) throw new Error('No se pudieron obtener socios: ' + JSON.stringify(r).slice(0,300));
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
  if (['active','activo','al_dia','al día','paid','vigente'].some(x => v.includes(x))) return 'Al día';
  if (['moroso','deudor','overdue','vencido','expired'].some(x => v.includes(x))) return 'Moroso';
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
    await store.delete(TOKEN_CACHE_KEY).catch(() => {});
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
};
