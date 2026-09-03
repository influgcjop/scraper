/**
 * add-companies.mjs — scrapea perfiles de Instagram de marcas/negocios
 * (no creadores) y los guarda en la tabla `company`, para tener a quién
 * contactar después. El "tipo" (restaurante, café, tienda...) sale
 * directo de la categoría que la propia cuenta declara en Instagram. De
 * paso mina quién la etiquetó (igual que `discover.mjs brand`) y guarda
 * los hits por creador en `tagged_by_creators` — así se ve si una marca
 * ya trabajó 3 o 5 veces con el mismo creador.
 *
 *   node scripts/add-companies.mjs donascity.val cafearabica_ccs
 *   node scripts/add-companies.mjs                # sin args: lee scripts/companies.csv
 *
 * Solo Instagram — de una marca solo interesa el nombre/username para
 * poder contactarla después, no hace falta trackear TikTok aparte.
 *
 * Corre con DEBUG_RAW=1 la primera vez para verificar el mapeo de campos,
 * igual que enrich.mjs.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { ApifyClient } from 'apify-client';
import { createClient } from '@supabase/supabase-js';
import { detectCity, isInScopeCity } from './lib/classify.mjs';
import { fromBrands, countCandidates } from './lib/mining.mjs';
import { saveCityLead } from './lib/cityLead.mjs';

// Zonas de Caracas inequívocas — si aparecen en la bio, es Caracas sin
// dudarlo, sin gastar una llamada a claude -p. "Tovar / Chacao" en la bio
// de una cafetería es justo el caso ambiguo que esto resuelve: Tovar
// también es un pueblo real en Mérida, pero Chacao no es de nadie más.
const CARACAS_KEYWORDS =
  /\b(chacao|los palos grandes|el rosal|la candelaria|altamira|las mercedes|baruta|el hatillo|sabana grande)\b/i;

const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const DEBUG_RAW = process.env.DEBUG_RAW === '1';
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

async function scrapeProfiles(usernames) {
  console.log(`→ Apify apify/instagram-profile-scraper · ${usernames.join(', ')}`);
  const run = await apify.actor('apify/instagram-profile-scraper').call({ usernames, resultsLimit: 1 });
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();

  if (DEBUG_RAW) {
    await fs.mkdir('./tmp', { recursive: true });
    const file = `./tmp/raw-company-${Date.now()}.json`;
    await fs.writeFile(file, JSON.stringify(items, null, 2));
    console.log(`  raw → ${file}`);
  }

  return items;
}

/** Pregunta en terminal cuando ni la regla de Chacao ni claude -p resolvieron. */
async function askHuman(rl, username, bioText) {
  console.log(`\n¿Ciudad de @${username}? No se pudo determinar sola.`);
  console.log(`  bio: "${(bioText ?? '(sin bio)').replace(/\n/g, ' ')}"`);
  console.log('  1) Es Valencia');
  console.log('  2) Es Caracas');
  console.log('  3) Es de Venezuela, pero otra ciudad (escribir cuál)');
  console.log('  4) No es de Venezuela — descartar');
  let answer = '';
  try {
    answer = (await rl.question('  Elige [1/2/3/4, Enter = dejar sin decidir]: ')).trim();
  } catch {
    console.log('  (no hay entrada disponible — se deja sin decidir)');
    return {};
  }
  if (answer === '1') return { city: 'Valencia' };
  if (answer === '2') return { city: 'Caracas' };
  if (answer === '4') return { discard: true };
  if (answer === '3') {
    let manualCity = '';
    try {
      manualCity = (await rl.question('  ¿Cuál ciudad?: ')).trim();
    } catch {
      return {};
    }
    return manualCity ? { manualCity } : {};
  }
  return {};
}

async function save(item, rl) {
  if (item.error) {
    console.error(`  ✗ @${item.username}: ${item.errorDescription ?? item.error}`);
    return null;
  }

  const username = String(item.username).toLowerCase();
  const bioText = item.biography;

  let city = null;
  let resolved = false; // true si ya hay CUALQUIER respuesta: en alcance, fuera de alcance (city_lead), o descarte

  if (CARACAS_KEYWORDS.test(bioText ?? '')) {
    city = 'Caracas';
    resolved = true;
  } else {
    // Misma detección que enrich.mjs para creadores: no hay campo de
    // dirección estructurado en el actor, la ubicación sale de la bio.
    const cityResult = await detectCity({
      bioText,
      displayName: item.fullName,
      platformCategory: item.businessCategoryName,
    });
    if (cityResult?.city && isInScopeCity(cityResult.city)) {
      city = cityResult.city;
      resolved = true;
    } else if (cityResult?.city) {
      // Ciudad venezolana real, pero no Caracas/Valencia — no se pregunta
      // al humano, ya hay una respuesta concreta, solo que fuera de alcance.
      await saveCityLead(db, {
        kind: 'company',
        platform: 'instagram',
        username,
        city: cityResult.city,
        followerCount: num(item.followersCount),
      });
      console.log(`  🏙 @${username}: ${cityResult.city} (fuera de Caracas/Valencia) — guardado en city_lead`);
      resolved = true;
    }
  }

  if (!resolved) {
    const human = await askHuman(rl, username, bioText);
    if (human.discard) {
      await db.from('company').delete().eq('username', username);
      console.log(`  ⊘ @${username}: descartada (no es de Venezuela)`);
      return null;
    }
    if (human.city) {
      city = human.city;
    } else if (human.manualCity) {
      if (isInScopeCity(human.manualCity)) {
        city = human.manualCity;
      } else {
        await saveCityLead(db, {
          kind: 'company',
          platform: 'instagram',
          username,
          city: human.manualCity,
          followerCount: num(item.followersCount),
        });
        console.log(`  🏙 @${username}: ${human.manualCity} (fuera de Caracas/Valencia) — guardado en city_lead`);
      }
    }
  }

  // Quién la etiquetó/mencionó y cuántas veces — mismo minado que
  // `discover.mjs brand`, pero acá se guarda en vez de solo imprimirse.
  let taggedByCreators = [];
  try {
    const rows = await fromBrands([username]);
    taggedByCreators = countCandidates(rows).map((c) => ({ username: c.username, hits: c.hits }));
  } catch (e) {
    console.warn(`  ⚠ tagged_by_creators @${username}:`, e.message);
  }

  const payload = {
    username,
    display_name: item.fullName ?? null,
    profile_url: item.url ?? `https://www.instagram.com/${username}/`,
    type: item.businessCategoryName ?? null,
    follower_count: num(item.followersCount),
    bio_text: item.biography ?? null,
    tagged_by_creators: taggedByCreators,
    last_scraped_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Solo se manda si se resolvió — así un rerun sin nueva evidencia no
  // borra una ciudad ya detectada o confirmada antes.
  if (city) payload.city = city;

  const { error } = await db.from('company').upsert(payload, { onConflict: 'username' });

  if (error) {
    console.error(`  ✗ @${username}:`, error.message);
    return null;
  }
  console.log(
    `  ✓ @${username} · ${item.businessCategoryName ?? 'sin categoría'} · ${num(item.followersCount) ?? '?'} seg · ` +
      `${city ?? 'ciudad sin decidir'} · ${taggedByCreators.length} creadores la etiquetaron`
  );
  return taggedByCreators;
}

/**
 * Cruza todos los creadores encontrados en tagged_by_creators de esta
 * corrida contra social_account (instagram) — imprime solo los que NO
 * están todavía en la base, para saber a quién le falta cargar.
 */
async function printNewCreators(allTagged) {
  if (!allTagged.size) return;

  const usernames = [...allTagged.keys()];
  const { data: existing, error } = await db
    .from('social_account')
    .select('username')
    .eq('platform', 'instagram')
    .in('username', usernames);

  if (error) {
    console.warn('\n⚠ no se pudo cruzar contra creadores existentes:', error.message);
    return;
  }

  const existingSet = new Set((existing ?? []).map((r) => r.username));
  const newOnes = usernames
    .filter((u) => !existingSet.has(u))
    .map((u) => ({ username: u, hits: allTagged.get(u) }))
    .sort((a, b) => b.hits - a.hits);

  if (!newOnes.length) {
    console.log('\nTodos los creadores que etiquetaron estas marcas ya están en la base.');
    return;
  }

  const width = Math.max(...newOnes.map((c) => c.username.length));
  console.log(`\n${newOnes.length} creadores que etiquetaron estas marcas y NO están en la base todavía:\n`);
  for (const c of newOnes) {
    console.log(`  ${c.username.padEnd(width)}  hits=${c.hits}`);
  }
  console.log('\nCopia los que valgan la pena a scripts/creators.csv y corre npm run add-creators-batch.');
}

const CSV_FILE = 'scripts/companies.csv';

async function readUsernamesFromCsv(path) {
  let content;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
  return content
    .split('\n')
    .slice(1) // encabezado
    .map((l) => l.split(',')[0].trim()) // por si queda una coma de sobra (ej. pegado desde creators.csv)
    .filter((l) => l && !l.startsWith('#'));
}

async function main() {
  let usernames = process.argv.slice(2);

  if (!usernames.length) {
    const fromCsv = await readUsernamesFromCsv(CSV_FILE);
    if (fromCsv === null) {
      console.error('uso: node scripts/add-companies.mjs usuario1 usuario2 ...');
      console.error(`     o agrega usernames a ${CSV_FILE} y corre sin argumentos`);
      process.exit(1);
    }
    usernames = fromCsv;
    console.log(`[${CSV_FILE}] ${usernames.length} marcas por procesar`);
  }

  if (!usernames.length) return console.log('Nada que procesar.');

  const items = await scrapeProfiles(usernames);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const allTagged = new Map(); // username -> hits acumulados en toda la corrida
  try {
    for (const item of items) {
      const taggedByCreators = await save(item, rl);
      for (const t of taggedByCreators ?? []) {
        allTagged.set(t.username, (allTagged.get(t.username) ?? 0) + t.hits);
      }
    }
  } finally {
    rl.close();
  }

  await printNewCreators(allTagged);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
