/**
 * discover.mjs — imprime en terminal los usernames encontrados minando
 * hashtags o cuentas de marcas. No escribe nada en Supabase ni scrapea
 * perfiles completos (eso lo hace enrich.mjs) — es solo para mirar la
 * lista, copiar los que valen la pena a scripts/creators.csv, y correr
 * `npm run add-creators-batch` sobre esos.
 *
 *   node scripts/discover.mjs hashtag ccsfoodies caracasfood
 *   node scripts/discover.mjs brand   restaurante_x tienda_y
 *
 * Cuenta cuántas veces aparece cada username: si sale en 3 fuentes
 * distintas, es mucho mejor señal que uno que salió una sola vez en un
 * hashtag genérico.
 *
 * Corre con DEBUG_RAW=1 la primera vez: depende de nombres de campo de
 * Apify (ownerUsername, taggedUsers, hashtags) que pueden cambiar entre
 * versiones del actor.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import { ApifyClient } from 'apify-client';

const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });

const RESULTS_PER_SOURCE = 100;
const DEBUG_RAW = process.env.DEBUG_RAW === '1';

async function runInstagramScraper(input, label) {
  const run = await apify.actor('apify/instagram-scraper').call(input);
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();

  if (DEBUG_RAW) {
    await fs.mkdir('./tmp', { recursive: true });
    const file = `./tmp/raw-discover-${label}-${Date.now()}.json`;
    await fs.writeFile(file, JSON.stringify(items, null, 2));
    console.log(`  raw → ${file}  (revisa ownerUsername/taggedUsers/hashtags antes de confiar en la cola)`);
  }

  return items;
}

/** Posts recientes de un hashtag → autores + gente etiquetada */
async function fromHashtags(tags) {
  const items = await runInstagramScraper(
    {
      search: tags.join(' '),
      searchType: 'hashtag',
      resultsType: 'posts',
      resultsLimit: RESULTS_PER_SOURCE,
      addParentData: true,
    },
    'hashtag'
  );
  return items.flatMap((p) => {
    const src = `hashtag:#${(p.hashtags?.[0] ?? tags[0]).toLowerCase()}`;
    return [
      p.ownerUsername && { username: p.ownerUsername.toLowerCase(), source: src },
      ...(p.taggedUsers ?? []).map((u) => ({
        username: (u.username ?? u).toString().toLowerCase(),
        source: src,
      })),
    ].filter(Boolean);
  });
}

/**
 * Posts DONDE LA MARCA ETIQUETÓ a alguien, o donde alguien etiquetó
 * a la marca. Es la fuente de mayor señal: prueba que esa persona
 * ya hace colaboraciones comerciales.
 */
async function fromBrands(handles) {
  const items = await runInstagramScraper(
    {
      directUrls: handles.map((h) => `https://www.instagram.com/${h}/`),
      resultsType: 'posts',
      resultsLimit: RESULTS_PER_SOURCE,
    },
    'brand'
  );
  return items.flatMap((p) => {
    // El actor mezcla posts propios de la marca con posts de OTRAS cuentas
    // que la mencionaron/etiquetaron. inputUrl dice qué handle buscado
    // generó este item; ownerUsername dice quién publicó — cuando difieren,
    // el dueño del post es el candidato (etiquetó/mencionó a la marca).
    const searchedHandle = (p.inputUrl ?? '')
      .replace(/^https?:\/\/www\.instagram\.com\//, '')
      .replace(/\/$/, '')
      .toLowerCase();
    const postOwner = (p.ownerUsername ?? '').toLowerCase();
    const src = `brand:@${searchedHandle || postOwner}`;

    if (postOwner && postOwner !== searchedHandle) {
      return [{ username: postOwner, source: src }];
    }

    // Post propio de la marca: a quién etiquetó/mencionó ahí.
    const captionMentions = [...String(p.caption ?? '').matchAll(/@([A-Za-z0-9._]+)/g)].map((m) =>
      m[1].toLowerCase()
    );
    return [...(p.taggedUsers ?? []).map((u) => (u.username ?? u).toString().toLowerCase()), ...captionMentions]
      .filter((u) => u && u !== postOwner && u !== searchedHandle)
      .map((username) => ({ username, source: src }));
  });
}

const USERNAME_RE = /^[a-z0-9._]{2,30}$/;

/** Agrupa las filas crudas por username y cuenta hits — sin tocar Supabase. */
function countCandidates(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!USERNAME_RE.test(r.username)) continue;
    const cur = counts.get(r.username) ?? { username: r.username, source: r.source, hits: 0 };
    cur.hits += 1;
    counts.set(r.username, cur);
  }
  return [...counts.values()].sort((a, b) => b.hits - a.hits);
}

function printCandidates(candidates) {
  if (!candidates.length) {
    console.log('Nada encontrado.');
    return;
  }
  const width = Math.max(...candidates.map((c) => c.username.length));
  console.log(`\n${candidates.length} candidatos encontrados (ordenados por hits):\n`);
  for (const c of candidates) {
    console.log(`  ${c.username.padEnd(width)}  hits=${c.hits}  ${c.source}`);
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!mode || !args.length) {
    console.error('uso: node scripts/discover.mjs <hashtag|brand> <arg1> [arg2 ...]');
    process.exit(1);
  }
  const rows = mode === 'hashtag' ? await fromHashtags(args) : await fromBrands(args);
  const candidates = countCandidates(rows);
  printCandidates(candidates);
  console.log('\nCopia los que valgan la pena a scripts/creators.csv y corre npm run add-creators-batch.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
