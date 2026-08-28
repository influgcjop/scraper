import { askClaude, parseJsonResponse } from './claude.mjs';

const VALID_CITIES = ['Caracas', 'Valencia'];

const VALID_NICHES = [
  'food', 'lifestyle', 'fitness', 'beauty', 'fashion',
  'travel', 'tech', 'finance', 'humor', 'family', 'auto', 'gaming',
];

/**
 * Detecta la ciudad del creador a partir de la bio (texto libre, ya
 * scrapeado — no vuelve a llamar a Apify). Devuelve null si claude -p
 * falla o no hay evidencia clara, para no tumbar el enrich de un
 * creador por esto.
 */
export async function detectCity({ bioText, displayName, platformCategory }) {
  if (!bioText) return null;

  const prompt = `Eres un clasificador. Analiza esta bio de un perfil de Instagram/TikTok y determina si el creador vive en Caracas o en Valencia (Venezuela). Si no hay evidencia clara de ninguna de las dos ciudades, responde con city: null.

Nombre: ${displayName ?? '(sin nombre)'}
Categoría: ${platformCategory ?? '(sin categoría)'}
Bio: """${bioText}"""

Responde SOLO con un objeto JSON, sin texto adicional ni explicación, con este formato exacto:
{"city": "Caracas" | "Valencia" | null, "confidence": 0.0-1.0, "evidence": "cita corta de la bio que lo justifica"}`;

  try {
    const raw = await askClaude(prompt);
    const parsed = parseJsonResponse(raw);
    if (parsed.city && !VALID_CITIES.includes(parsed.city)) parsed.city = null;
    return parsed;
  } catch (e) {
    console.warn('  ⚠ detectCity:', e.message);
    return null;
  }
}

/**
 * Detecta el nicho más relevante (creator.niche, un solo valor — igual que
 * detectCity, sin tabla aparte) a partir de bio + captions recientes.
 * Devuelve null si claude -p falla o no hay evidencia clara.
 */
export async function detectNiche({ bioText, displayName, platformCategory, captions = [] }) {
  if (!bioText && captions.length === 0) return null;

  const prompt = `Eres un clasificador. Analiza este perfil de creador de contenido y determina CUÁL de estos nichos encaja mejor (uno solo, el más relevante): ${VALID_NICHES.join(', ')}. Si no hay evidencia suficiente, responde con niche: null.

Nombre: ${displayName ?? '(sin nombre)'}
Categoría declarada: ${platformCategory ?? '(sin categoría)'}
Bio: """${bioText ?? ''}"""
Captions recientes:
${captions.map((c, i) => `${i + 1}. ${c}`).join('\n') || '(sin captions)'}

Responde SOLO con un objeto JSON, sin texto adicional, con este formato exacto:
{"niche": "food" | null, "confidence": 0.0-1.0}`;

  try {
    const raw = await askClaude(prompt);
    const parsed = parseJsonResponse(raw);
    if (parsed.niche && !VALID_NICHES.includes(parsed.niche)) parsed.niche = null;
    return parsed;
  } catch (e) {
    console.warn('  ⚠ detectNiche:', e.message);
    return null;
  }
}
