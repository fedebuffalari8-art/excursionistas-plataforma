// netlify/functions/research-search.mjs

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Response.json({ error: 'ANTHROPIC_API_KEY no configurada.' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch(e) {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const { prompt } = body;
  if (!prompt) return Response.json({ error: 'Falta el prompt' }, { status: 400 });

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return Response.json({ error: `Error ${res.status}: ${err.slice(0,200)}` }, { status: 502 });
    }

    const data = await res.json();
    const texto = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!texto) return Response.json({ error: 'Sin respuesta' }, { status: 502 });
    return Response.json({ texto });
  } catch(e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};
