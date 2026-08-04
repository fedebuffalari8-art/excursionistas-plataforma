// netlify/functions/fixture-excursionistas.mjs
//
// Trae el próximo partido, los últimos resultados oficiales y la posición
// en la tabla del Club Atlético Excursionistas (Primera B Metropolitana).
// Reusa el mismo patrón que research-search.mjs: Gemini con grounding de
// Google Search, para no depender de un scraper frágil contra un sitio
// puntual. Cachea la respuesta en Netlify Blobs para no pegarle a Gemini
// en cada carga de página — se refresca sola cada 6 horas, o al toque
// si se llama con ?force=1 (botón "Actualizar" en el panel).

import { getStore } from '@netlify/blobs';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

export default async (request) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return Response.json({ error: 'GEMINI_API_KEY no configurada.' }, { status: 500 });

  const url = new URL(request.url);
  const forzar = url.searchParams.get('force') === '1';
  const store = getStore('fixture-data');

  if (!forzar) {
    try {
      const cached = await store.get('excursionistas', { type: 'json' });
      if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return Response.json(cached);
      }
    } catch (e) { /* si no hay caché todavía, seguimos y la creamos */ }
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const prompt = `Buscá en la web información ACTUAL y oficial sobre el Club Atlético Excursionistas (fútbol masculino, Primera B Metropolitana de Argentina, temporada 2026). Hoy es ${hoy}.

Devolvé EXCLUSIVAMENTE un JSON válido, sin texto adicional, sin markdown ni backticks, con esta forma EXACTA:
{
  "proximoPartido": { "rival": "", "fecha": "YYYY-MM-DD", "hora": "HH:MM", "condicion": "Local", "cancha": "", "competencia": "" },
  "ultimosResultados": [
    { "rival": "", "fecha": "YYYY-MM-DD", "golesExcursionistas": 0, "golesRival": 0, "condicion": "Local", "competencia": "" }
  ],
  "posicionTabla": { "puesto": 0, "puntos": 0, "actualizadoAl": "YYYY-MM-DD" }
}

Reglas:
- "condicion" es "Local" o "Visitante" según de quién es la cancha.
- En "ultimosResultados" incluí hasta los últimos 5 partidos oficiales ya jugados y confirmados, del más reciente al más viejo.
- Si no encontrás algún dato puntual con certeza (por ejemplo la hora exacta), poné null en ESE campo en particular — no inventes valores.
- Si no hay ningún próximo partido confirmado, "proximoPartido" puede ser null.
- No agregues comentarios ni explicación, solo el JSON.`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.1 },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return Response.json({ error: `Gemini ${res.status}: ${err.slice(0, 300)}` }, { status: 502 });
    }

    const data = await res.json();
    let texto = data.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('\n')?.trim() || '';
    texto = texto.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(texto);
    } catch (e) {
      return Response.json({ error: 'No se pudo interpretar la respuesta como JSON.', raw: texto.slice(0, 500) }, { status: 502 });
    }

    const result = { ...parsed, fetchedAt: Date.now() };
    try { await store.setJSON('excursionistas', result); } catch (e) { /* si falla el guardado, igual devolvemos el dato fresco */ }
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};
