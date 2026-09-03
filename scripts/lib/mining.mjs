/**
 * mining.mjs — minar candidatos en Instagram: hashtags, cuentas de marca,
 * o posts de un creador. Compartido entre discover.mjs (imprime en
 * terminal, no persiste) y add-companies.mjs (persiste tagged_by_creators
 * en cada company).
 */
import fs from 'node:fs/promises';
import { ApifyClient } from 'apify-client';

const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });

const RESULTS_PER_SOURCE = 100;
const CREATOR_POSTS_LIMIT = 24;
const DEBUG_RAW = process.env.DEBUG_RAW === '1';

export const USERNAME_RE = /^[a-z0-9._]{2,30}$/;

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
export async function fromHashtags(tags) {
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
export async function fromBrands(handles) {
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

/**
 * Posts propios de UN creador → marcas que etiquetó o mencionó. Es el
 * espejo de fromBrands(): allá pasas una marca y salen creadores, acá
 * pasas un creador y salen marcas. Usa apify/instagram-profile-scraper
 * (no instagram-scraper) porque necesitamos el perfil completo con sus
 * posts, no una búsqueda — mismo actor que enrich.mjs. Solo Instagram.
 */
export async function fromCreators(usernames) {
  console.log(`→ Apify apify/instagram-profile-scraper · ${usernames.join(', ')}`);
  const run = await apify
    .actor('apify/instagram-profile-scraper')
    .call({ usernames, resultsLimit: CREATOR_POSTS_LIMIT });
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();

  if (DEBUG_RAW) {
    await fs.mkdir('./tmp', { recursive: true });
    const file = `./tmp/raw-discover-creator-${Date.now()}.json`;
    await fs.writeFile(file, JSON.stringify(items, null, 2));
    console.log(`  raw → ${file}`);
  }

  return items.flatMap((profile) => {
    if (profile.error) {
      console.error(`  ✗ @${profile.username}: ${profile.errorDescription ?? profile.error}`);
      return [];
    }
    const owner = String(profile.username).toLowerCase();
    const src = `creator:@${owner}`;
    const posts = profile.latestPosts ?? profile.posts ?? [];

    return posts.flatMap((p) => {
      const tagged = (p.taggedUsers ?? []).map((u) => (u.username ?? u).toString().toLowerCase());
      const mentions = (p.mentions ?? []).map((m) => m.toString().toLowerCase());
      const captionMentions = [...String(p.caption ?? '').matchAll(/@([A-Za-z0-9._]+)/g)].map((m) =>
        m[1].toLowerCase()
      );
      return [...tagged, ...mentions, ...captionMentions]
        .filter((u) => u && u !== owner)
        .map((username) => ({ username, source: src }));
    });
  });
}

/** Agrupa las filas crudas por username y cuenta hits. */
export function countCandidates(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!USERNAME_RE.test(r.username)) continue;
    const cur = counts.get(r.username) ?? { username: r.username, source: r.source, hits: 0 };
    cur.hits += 1;
    counts.set(r.username, cur);
  }
  return [...counts.values()].sort((a, b) => b.hits - a.hits);
}
