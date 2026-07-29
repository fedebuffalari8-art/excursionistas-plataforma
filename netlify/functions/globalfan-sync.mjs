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
  try { return JSON.parse(text); } catch(e) { return { _raw: text.slice(0, 300) }; }
}

async function login() {
  const email = process.env.GLOBALFAN_EMAIL;
  const password = process.env.GLOBALFAN_PASSWORD;
  if (!email || !password) throw new Error('Variables GLOBALFAN_EMAIL o GLOBALFAN_PASSWORD no configuradas.');

  const attempts = [];

  const mutations = [
    { name: 'login', query: `mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { token accessToken } }`, getToken: d => d?.data?.login?.token || d?.data?.login?.accessToken },
    { name: 'signIn', query: `mutation SignIn($email: String!, $password: String!) { signIn(email: $email, password: $password) { token accessToken } }`, getToken: d => d?.data?.signIn?.token || d?.data?.signIn?.accessToken },
    { name: 'adminLogin', query: `mutation AdminLogin($email: String!, $password: String!) { adminLogin(email: $email, password: $password) { token accessToken } }`, getToken: d => d?.data?.adminLogin?.token || d?.data?.adminLogin?.accessToken },
    { name: 'userLogin', query: `mutation UserLogin($email: String!, $password: String!) { userLogin(email: $email, password: $password) { token accessToken } }`, getToken: d => d?.data?.userLogin?.token || d?.data?.userLogin?.accessToken },
  ];

  for (const m of mutations) {
    try {
      const data = await gql(m.query, { email, password });
      const token = m.getToken(data);
      if (token) return token;
      attempts.push({ mutation: m.name, response: JSON.stringify(data).slice(0, 200) });
    } catch (e) {
      attempts.push({ mutation: m.name, error: e.message });
    }
  }

  throw new Error('Intentos fallidos: ' + JSON.stringify(attempts));
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

async function introspect(token) {
  const data = await gql(`{ __schema { mutationType { fields { name } } } }`, {}, token);
  return data;
}

export default async (request) => {
  const store = getStore('globalfan-data');
  try {
    const token = await getToken(store);
    const schema = await introspect(token);
    return Response.json({ ok: true, debug: 'login_ok', schema: JSON.stringify(schema).slice(0, 2000) });
  } catch (e) {
    await store.delete(TOKEN_CACHE_KEY).catch(() => {});
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
};
