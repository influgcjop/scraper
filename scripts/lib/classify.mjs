import { askClaude, parseJsonResponse } from './claude.mjs';

// Las únicas dos "en alcance" para el pipeline activo hoy. Cualquier otra
// ciudad venezolana que detectCity identifique cuenta como out-of-scope
// (va a city_lead), no se descarta ni se fuerza a una de estas dos.
export const IN_SCOPE_CITIES = ['Caracas', 'Valencia'];
export function isInScopeCity(city) {
  return !!city && IN_SCOPE_CITIES.some((c) => c.toLowerCase() === city.toLowerCase());
}

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

  const prompt = `Eres un clasificador estricto. Analiza esta bio de un perfil de Instagram/TikTok y determina en qué ciudad de VENEZUELA está, basándote SOLO en evidencia real dentro de la BIO (dirección, zona/municipio, ciudad mencionada explícitamente, código +58, etc.). Puede ser cualquier ciudad venezolana, no te limites a Caracas o Valencia (ej: Maracaibo, Barquisimeto, Mérida, Morrocoy, Puerto La Cruz).

IMPORTANTE: el campo Nombre NO es evidencia de ubicación — un negocio puede llamarse "Cafés Caracas" o algo similar sin estar físicamente ahí (nombres de ciudad como marca son comunes). Ignóralo para decidir, úsalo solo como contexto secundario. Si la bio menciona un lugar que NO es de Venezuela, o no hay evidencia real y verificable, responde city: null — no adivines por el nombre de la cuenta.

Nombre: ${displayName ?? '(sin nombre)'}
Categoría: ${platformCategory ?? '(sin categoría)'}
Bio: """${bioText}"""

Responde SOLO con un objeto JSON, sin texto adicional ni explicación, con este formato exacto. "city" es el nombre de la ciudad venezolana tal cual se menciona/infiere (ej: "Caracas", "Maracaibo"), o null. "evidence" debe ser una cita textual de la BIO, no del nombre:
{"city": "<ciudad>" | null, "confidence": 0.0-1.0, "evidence": "cita corta de la bio que lo justifica"}`;

  try {
    const raw = await askClaude(prompt);
    return parseJsonResponse(raw);
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
