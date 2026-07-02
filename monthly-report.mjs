// netlify/functions/monthly-report.mjs
//
// Recibe los datos del mes (posts, seguidores, alcance, etc.) y pide a
// Claude Haiku que escriba un resumen ejecutivo en español, listo para
// copiar en un mail o presentar en una reunión de Comisión Directiva.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ error: 'JSON inválido.' }, { status: 400 });
  }

  const { mes, datos } = body;

  const prompt = `Sos el community manager del Club Atlético Excursionistas.
Escribí un RESUMEN EJECUTIVO del desempeño de Instagram en ${mes}, usando estos datos:

${JSON.stringify(datos, null, 2)}

El resumen debe:
- Estar en español, tono profesional pero cálido.
- Tener entre 150 y 250 palabras.
- Destacar los logros más importantes (crecimiento, mejor contenido, alcance).
- Mencionar qué tipo de contenido funcionó mejor y por qué.
- Cerrar con una recomendación puntual para el mes siguiente.
- NO repetir todos los números literalmente — interpretarlos y darles contexto.
- Respondé ÚNICAMENTE con el texto del resumen, sin títulos ni viñetas.`;

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
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return Response.json({ resumen: json.content?.[0]?.text?.trim() || '' });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};
