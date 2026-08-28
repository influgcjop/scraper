/**
 * enrich.mjs — dado uno o varios usernames, scrapea el perfil,
 * calcula métricas y hace upsert en Supabase.
 *
 *   node scripts/enrich.mjs instagram sofiaccs otro_user
 *   node scripts/enrich.mjs tiktok    sofiaccs
 *   node scripts/enrich.mjs instagram:sofiaccs tiktok:sofiaccs_tt   # mismo creador, usernames distintos
 *
 * IMPORTANTE la primera vez: corre con DEBUG_RAW=1 para volcar el
 * JSON crudo del actor a ./tmp/. Los nombres de campo de los actors
 * de Apify cambian entre versiones — verifica el mapeo antes de
 * confiar en los números.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import { ApifyClient } from 'apify-client';
import { createClient } from '@supabase/supabase-js';
import { detectCity, detectNiche } from './lib/classify.mjs';

const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const SAMPLE_SIZE = 12; // posts recientes usados para las métricas
const DEBUG_RAW = process.env.DEBUG_RAW === '1';

const ACTORS = {
  instagram: 'apify/instagram-profile-scraper',
  tiktok: 'clockworks/tiktok-scraper',
};

// ------------------------------------------------------------------
// Utilidades de métricas
// ------------------------------------------------------------------
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mean(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Mediana, no media: un solo post viral dispara la media y te hace
 * sobrestimar a un creador mediocre. Los nombres de salida coinciden
 * 1:1 con las columnas de account_snapshot para no tener que mapear
 * dos veces (y equivocarse una).
 */
function computeMetrics(posts, followerCount) {
  const sample = posts.slice(0, SAMPLE_SIZE);
  if (!sample.length) return { posts_analyzed_count: 0 };

  const likes = sample.map((p) => num(p.likes));
  const comments = sample.map((p) => num(p.comments));
  const views = sample.map((p) => num(p.views));

  const medLikes = median(likes);
  const medComments = median(comments);
  const medViews = median(views);

  const dates = sample
    .map((p) => (p.posted_at ? new Date(p.posted_at).getTime() : null))
    .filter(Boolean)
    .sort((a, b) => b - a);

  let postsPerWeek = null;
  let lastPostAt = null;
  if (dates.length >= 2) {
    const spanDays = (dates[0] - dates[dates.length - 1]) / 86_400_000;
    postsPerWeek = spanDays > 0 ? (dates.length / spanDays) * 7 : null;
  }
  if (dates.length) {
    lastPostAt = new Date(dates[0]).toISOString();
  }

  const engagementRateMedian =
    followerCount && medLikes !== null
      ? ((medLikes + (medComments ?? 0)) / followerCount) * 100
      : null;

  return {
    posts_analyzed_count: sample.length,
    likes_median: medLikes,
    comments_median: medComments,
    avg_views: mean(views),
    median_views: medViews,
    engagement_rate_median: engagementRateMedian,
    view_rate: followerCount && medViews ? (medViews / followerCount) * 100 : null,
    comment_like_ratio: medLikes ? ((medComments ?? 0) / medLikes) * 100 : null,
    posts_per_week: postsPerWeek,
    last_post_at: lastPostAt,
  };
}

function tierFor(followerCount) {
  if (!followerCount) return null;
  if (followerCount < 5_000) return 'nano';
  if (followerCount < 50_000) return 'micro';
  if (followerCount < 200_000) return 'mid';
  if (followerCount < 1_000_000) return 'macro';
  return 'mega';
}

// ------------------------------------------------------------------
// Normalizadores por plataforma — solo lo que hace falta para calcular
// métricas (likes/comments/views/fecha por post) y los campos de
// social_account. No se guarda detalle por post porque no hay tabla
// post en el schema actual.
// ------------------------------------------------------------------
function normalizeInstagram(item) {
  const rawPosts = item.latestPosts ?? item.posts ?? [];
  const posts = rawPosts.map((p) => ({
    likes: num(p.likesCount),
    comments: num(p.commentsCount),
    views: num(p.videoViewCount ?? p.videoPlayCount),
    posted_at: p.timestamp ?? null,
  }));
  // Solo para clasificar con claude -p (detectNiche) — no se persiste, no hay tabla post.
  const captions = rawPosts.map((p) => p.caption).filter(Boolean).slice(0, 5);

  return {
    platform: 'instagram',
    username: String(item.username).toLowerCase(),
    profile_url: item.url ?? `https://www.instagram.com/${item.username}/`,
    display_name: item.fullName ?? null,
    bio_text: item.biography ?? null,
    external_url: item.externalUrl ?? null,
    is_verified: item.verified ?? item.isVerified ?? null,
    is_private: item.private ?? item.isPrivate ?? null,
    platform_category: item.businessCategoryName ?? null,
    follower_count: num(item.followersCount),
    following_count: num(item.followsCount),
    post_count: num(item.postsCount),
    posts,
    captions,
    raw: item,
  };
}

function normalizeTiktok(items) {
  // clockworks/tiktok-scraper devuelve un item POR VIDEO, no por perfil
  const first = items[0];
  const meta = first?.authorMeta ?? {};
  const posts = items.map((v) => ({
    likes: num(v.diggCount),
    comments: num(v.commentCount),
    views: num(v.playCount),
    posted_at: v.createTimeISO ?? (v.createTime ? new Date(v.createTime * 1000).toISOString() : null),
  }));
  // Solo para clasificar con claude -p (detectNiche) — no se persiste, no hay tabla post.
  const captions = items.map((v) => v.text).filter(Boolean).slice(0, 5);

  return {
    platform: 'tiktok',
    username: String(meta.name ?? meta.nickName ?? '').toLowerCase(),
    profile_url: meta.name ? `https://www.tiktok.com/@${meta.name}` : null,
    display_name: meta.nickName ?? null,
    bio_text: meta.signature ?? null,
    external_url: meta.bioLink ?? null,
    is_verified: meta.verified ?? null,
    is_private: meta.privateAccount ?? null,
    platform_category: null,
    follower_count: num(meta.fans),
    following_count: num(meta.following),
    post_count: num(meta.video),
    posts,
    captions,
    raw: { authorMeta: meta, videos: items },
  };
}

// ------------------------------------------------------------------
// Scraping
// ------------------------------------------------------------------
async function scrape(platform, usernames) {
  const actorId = ACTORS[platform];
  if (!actorId) throw new Error(`Plataforma no soportada: ${platform}`);

  const input =
    platform === 'instagram'
      ? { usernames, resultsLimit: SAMPLE_SIZE * 2 }
      : { profiles: usernames, resultsPerPage: SAMPLE_SIZE * 2, shouldDownloadVideos: false, shouldDownloadCovers: false };

  console.log(`→ Apify ${actorId} · ${usernames.join(', ')}`);
  const run = await apify.actor(actorId).call(input);
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();

  if (DEBUG_RAW) {
    await fs.mkdir('./tmp', { recursive: true });
    const file = `./tmp/raw-${platform}-${Date.now()}.json`;
    await fs.writeFile(file, JSON.stringify(items, null, 2));
    console.log(`  raw → ${file}  (revisa los nombres de campo antes de confiar en las métricas)`);
  }

  if (platform === 'instagram') {
    // El actor no omite los perfiles inexistentes/privados: devuelve un
    // placeholder {username, error: "not_found", ...} — si se procesa
    // igual, se crea un creator con todo en null. Se descarta acá, antes
    // de que llegue a save().
    const valid = items.filter((item) => !item.error);
    for (const item of items) {
      if (item.error) console.error(`  ✗ @${item.username}: ${item.errorDescription ?? item.error}`);
    }
    return valid.map(normalizeInstagram);
  }

  // TikTok: agrupar los videos por autor
  const byAuthor = new Map();
  for (const v of items) {
    const key = v.authorMeta?.name;
    if (!key) continue;
    if (!byAuthor.has(key)) byAuthor.set(key, []);
    byAuthor.get(key).push(v);
  }
  return [...byAuthor.values()].map(normalizeTiktok);
}

// ------------------------------------------------------------------
// Persistencia
// ------------------------------------------------------------------
async function save(profile, { creatorId: forcedCreatorId } = {}) {
  const { platform, username, posts } = profile;

  // 1. ¿Ya existe la cuenta? Si sí, reusar el creator.
  const { data: existing } = await db
    .from('social_account')
    .select('id, creator_id')
    .eq('platform', platform)
    .eq('username', username)
    .maybeSingle();

  // forcedCreatorId manda: viene de un vínculo EXPLÍCITO entre plataformas
  // (ver processLinkedAccounts) cuando el username no coincide entre IG y
  // TikTok. Sin eso, se cae a lo que ya se sabe de esta cuenta puntual, y
  // por último a la coincidencia de username (Fuente 5 del README) — que
  // solo sirve cuando el handle es igual en ambas plataformas.
  let creatorId = forcedCreatorId ?? existing?.creator_id;

  if (!creatorId) {
    const { data: sameUsername } = await db
      .from('social_account')
      .select('creator_id')
      .eq('username', username)
      .limit(1)
      .maybeSingle();
    creatorId = sameUsername?.creator_id;
  }

  if (!creatorId) {
    const { data: created, error } = await db
      .from('creator')
      .insert({
        slug: `${platform}:${username}`,
        display_name: profile.display_name,
        tier: tierFor(profile.follower_count),
        pipeline_status: 'enriched',
      })
      .select('id')
      .single();
    if (error) throw error;
    creatorId = created.id;
  } else {
    await db
      .from('creator')
      .update({ tier: tierFor(profile.follower_count), updated_at: new Date().toISOString() })
      .eq('id', creatorId);
  }

  // 1b. Ciudad por claude -p, sobre la bio ya scrapeada (no llama a Apify).
  // Si falla o no hay evidencia, se deja como estaba — no tumba el enrich.
  const cityResult = await detectCity({
    bioText: profile.bio_text,
    displayName: profile.display_name,
    platformCategory: profile.platform_category,
  });
  if (cityResult?.city) {
    await db
      .from('creator')
      .update({ city: cityResult.city, updated_at: new Date().toISOString() })
      .eq('id', creatorId);
    console.log(`  🏙 ciudad: ${cityResult.city} (confianza ${cityResult.confidence}) — "${cityResult.evidence}"`);
  }

  // 1c. Nicho por claude -p, sobre bio + captions ya scrapeados. Mismo
  // patrón que la ciudad: un solo valor en creator.niche, sin tabla aparte.
  const nicheResult = await detectNiche({
    bioText: profile.bio_text,
    displayName: profile.display_name,
    platformCategory: profile.platform_category,
    captions: profile.captions,
  });
  if (nicheResult?.niche) {
    await db
      .from('creator')
      .update({ niche: nicheResult.niche, updated_at: new Date().toISOString() })
      .eq('id', creatorId);
    console.log(`  🏷 nicho: ${nicheResult.niche} (confianza ${nicheResult.confidence})`);
  }

  // 2. Cuenta social
  const { data: account, error: accErr } = await db
    .from('social_account')
    .upsert(
      {
        creator_id: creatorId,
        platform,
        username,
        profile_url: profile.profile_url,
        bio_text: profile.bio_text,
        external_url: profile.external_url,
        is_verified: profile.is_verified,
        is_private: profile.is_private,
        platform_category: profile.platform_category,
        last_scraped_at: new Date().toISOString(),
      },
      { onConflict: 'platform,username' }
    )
    .select('id')
    .single();
  if (accErr) throw accErr;

  // 3. Snapshot de métricas — upsert por día: un rerun el mismo día
  // (calibrando el mapeo) actualiza la fila en vez de fallar.
  const metrics = computeMetrics(posts, profile.follower_count);
  const { error: snapErr } = await db.from('account_snapshot').upsert(
    {
      social_account_id: account.id,
      captured_at: new Date().toISOString(),
      follower_count: profile.follower_count,
      following_count: profile.following_count,
      post_count: profile.post_count,
      ...metrics,
      raw: profile.raw,
    },
    { onConflict: 'social_account_id,snapshot_date' }
  );
  if (snapErr) console.warn('  ⚠ snapshot:', snapErr.message);

  const daysSince = metrics.last_post_at
    ? Math.floor((Date.now() - new Date(metrics.last_post_at).getTime()) / 86_400_000)
    : null;

  console.log(
    `  ✓ @${username} · ${profile.follower_count ?? '?'} seg · ER ${metrics.engagement_rate_median?.toFixed(2) ?? '?'}% · ` +
      `${metrics.posts_per_week?.toFixed(1) ?? '?'} posts/sem · último post hace ${daysSince ?? '?'}d`
  );

  return creatorId;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function processPlatform(platform, usernames) {
  if (!usernames.length) return console.log(`[${platform}] nada que procesar.`);

  const profiles = await scrape(platform, usernames);
  for (const p of profiles) {
    try {
      await save(p);
    } catch (e) {
      console.error(`  ✗ @${p.username}:`, e.message);
    }
  }
}

/**
 * Vincula EXPLÍCITAMENTE varias cuentas al mismo creator, aunque el
 * username no coincida entre plataformas (ej. @foo en IG, @foo.oficial
 * en TikTok) — la coincidencia de username en save() es solo un fallback
 * automático que no sirve en este caso, así que aquí se fuerza el mismo
 * creatorId en cada cuenta de la lista.
 */
async function processLinkedAccounts(pairs) {
  let sharedCreatorId;
  for (const { platform, username } of pairs) {
    if (!ACTORS[platform]) {
      console.error(`Plataforma no soportada: ${platform}`);
      continue;
    }
    try {
      const [profile] = await scrape(platform, [username]);
      if (!profile) {
        console.error(`  ✗ @${username} (${platform}): perfil no encontrado`);
        continue;
      }
      sharedCreatorId = await save(profile, { creatorId: sharedCreatorId });
    } catch (e) {
      console.error(`  ✗ @${username} (${platform}):`, e.message);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('uso: node scripts/enrich.mjs <instagram|tiktok> <user1> [user2 ...]');
    console.error('     node scripts/enrich.mjs instagram:usuario_ig tiktok:usuario_tt   # mismo creador, usernames distintos');
    process.exit(1);
  }

  // Todos los argumentos como "plataforma:username" → mismo creador, se
  // vinculan explícitamente aunque los usernames no coincidan.
  if (args.every((a) => a.includes(':'))) {
    const pairs = args.map((a) => {
      const [platform, ...usernameParts] = a.split(':');
      return { platform, username: usernameParts.join(':') };
    });
    await processLinkedAccounts(pairs);
    return;
  }

  // Modo clásico: una plataforma, uno o varios usernames.
  const [platform, ...rest] = args;
  if (!ACTORS[platform]) {
    console.error(`Plataforma no soportada: ${platform}`);
    process.exit(1);
  }
  await processPlatform(platform, rest);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
