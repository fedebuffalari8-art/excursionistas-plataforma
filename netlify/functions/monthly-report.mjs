// netlify/functions/monthly-report.mjs

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    const text = await request.text();
    if (!text) return Response.json({ error: 'Body vacío.' }, { status: 400 });
    body = JSON.parse(text);
  } catch (e) {
    return Response.json({ error: 'JSON inválido: ' + e.message }, { status: 400 });
  }

  const { mes, datos } = body;
  if (!mes || !datos) {
    return Response.json({ error: 'Faltan los campos "mes" o "datos".' }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'Variable ANTHROPIC_API_KEY no configurada en Netlify.' }, { status: 500 });
  }

  const resumenDatos = {
    mes,
    postsPublicados: datos.posts,
    likesTotales: datos.totalLikes,
    comentariosTotales: datos.totalComents,
    promedioInteraccionPorPost: datos.avgEngagement,
    nuevosSeguidores: datos.newFollowers,
    alcanceMes: datos.reachMes,
    seguidoresActuales: datos.seguidoresActuales,
    mejorPost: datos.mejorPost
      ? `"${(datos.mejorPost.caption || '').slice(0, 60)}…" — ${datos.mejorPost.likes} likes, ${datos.mejorPost.comentarios} comentarios`
      : null,
  };

  const prompt = `Sos el community manager del Club Atlético Excursionistas.
Escribí un RESUMEN EJECUTIVO del desempeño de Instagram en ${mes}:

${JSON.stringify(resumenDatos, null, 2)}

Reglas:
- Español, tono profesional y cálido, entre 150 y 220 palabras.
- Destacá logros, el mejor contenido y qué tipo funcionó más.
- Cerrá con UNA recomendación concreta para el mes siguiente.
- No repitas los números literalmente, interpretarlos.
- Solo el texto del resumen, sin títulos ni viñetas.`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `Anthropic devolvió ${res.status}: ${errText.slice(0, 200)}` }, { status: 502 });
    }

    const json = await res.json();
    if (json.error) return Response.json({ error: json.error.message || 'Error de Anthropic' }, { status: 502 });

    const resumen = json.content?.[0]?.text?.trim() || '';
    if (!resumen) return Response.json({ error: 'La IA devolvió una respuesta vacía.' }, { status: 502 });

    return Response.json({ resumen });
  } catch (e) {
    return Response.json({ error: 'Error de red al contactar Anthropic: ' + e.message }, { status: 500 });
  }
};
