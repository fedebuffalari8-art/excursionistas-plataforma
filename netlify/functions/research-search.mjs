// netlify/functions/research-search.mjs

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return Response.json({ error: 'GEMINI_API_KEY no configurada.' }, { status: 500 });
  let body;
  try { body = await request.json(); } catch(e) {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const { prompt } = body;
  if (!prompt) return Response.json({ error: 'Falta el prompt' }, { status: 400 });
  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.3 },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return Response.json({ error: `Gemini ${res.status}: ${err.slice(0,300)}` }, { status: 502 });
    }
    const data = await res.json();
    const texto = data.candidates?.[0]?.content?.parts?.filter(p=>p.text)?.map(p=>p.text)?.join('\n')?.trim() || '';
    if (!texto) return Response.json({ error: 'Gemini no devolvió texto.' }, { status: 502 });
    return Response.json({ texto });
  } catch(e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};
