-- Base de datos de creadores venezolanos — Paso 1: schema.
-- Pega esto en el SQL Editor de Supabase y corre. Ver README.md para el
-- pipeline completo; este archivo solo crea la estructura.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- creator: la persona. Separada de social_account porque un mismo
-- creador puede tener IG y TikTok con métricas muy distintas.
-- ---------------------------------------------------------------------
create table creator (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique,
  display_name     text,
  full_name        text,
  country_code     text default 'VE',
  -- Caracas, Valencia, u otra — sin default: se llena con lo que digan
  -- bio/geotags o el humano en revisión, no se asume una ciudad.
  city             text,
  -- lo asigna claude -p (detectNiche) igual que city — un solo nicho,
  -- sin tabla aparte ni tracking de confianza por fila.
  niche            text check (niche in (
                     'food', 'lifestyle', 'fitness', 'beauty', 'fashion',
                     'travel', 'tech', 'finance', 'humor', 'family', 'auto', 'gaming'
                   )),
  email            text,
  whatsapp         text,
  contact_source   text,
  creator_type     text check (creator_type in ('influencer', 'ugc', 'ambos')),
  tier             text check (tier in ('nano', 'micro', 'mid', 'macro', 'mega')),
  pipeline_status  text not null default 'discovered'
                     check (pipeline_status in
                       ('discovered', 'enriched', 'qualified', 'contacted', 'onboarded', 'rejected')),
  rejected_reason  text,
  discovered_via   text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index creator_pipeline_status_idx on creator (pipeline_status);
create index creator_city_idx on creator (city);

-- ---------------------------------------------------------------------
-- social_account: una cuenta (IG o TikTok) ligada a un creador. Un
-- creador con ambas plataformas tiene dos filas aquí, mismo creator_id.
-- ---------------------------------------------------------------------
create table social_account (
  id                uuid primary key default gen_random_uuid(),
  creator_id        uuid not null references creator (id) on delete cascade,
  platform          text not null check (platform in ('instagram', 'tiktok')),
  username          text not null,
  profile_url       text,
  is_primary        boolean not null default false,
  is_verified       boolean,
  is_private        boolean,
  platform_category text, -- categoría que la propia plataforma declara, ej. "Restaurant"
  bio_text          text,
  external_url      text,
  first_seen_at     timestamptz not null default now(),
  last_scraped_at   timestamptz,
  scrape_error      text, -- última falla de Apify (privada, borrada, rate-limit) para no perder la cuenta en silencio
  created_at        timestamptz not null default now(),
  unique (platform, username)
);

create index social_account_creator_id_idx on social_account (creator_id);

-- ---------------------------------------------------------------------
-- account_snapshot: una foto de métricas por día. Se inserta, nunca se
-- sobrescribe entre días distintos — así se ve crecimiento y se detecta
-- compra de seguidores (+30% en una semana con engagement cayendo). Un
-- rerun el mismo día (típico calibrando el mapeo en Paso 2) sí actualiza
-- la fila del día, para no ensuciar el historial con corridas de prueba.
-- ---------------------------------------------------------------------
create table account_snapshot (
  id                     bigserial primary key,
  social_account_id      uuid not null references social_account (id) on delete cascade,
  snapshot_date          date not null default current_date,
  captured_at            timestamptz not null default now(),
  follower_count         integer,
  following_count        integer,
  post_count             integer,
  -- cuántos posts recientes entraron en la mediana (meta: 12)
  posts_analyzed_count   integer,
  -- mediana, no media: un post viral no debe inflar el ER de un creador mediocre
  engagement_rate_median numeric(6, 3),
  likes_median           numeric,
  comments_median        numeric,
  avg_views              numeric, -- reels / tiktok
  median_views           numeric,
  view_rate              numeric(6, 3),
  comment_like_ratio     numeric(6, 3),
  posts_per_week         numeric(5, 2),
  last_post_at           timestamptz,
  -- payload crudo del actor de Apify: los actors cambian nombres de campo
  -- entre versiones (ver README, Paso 2) — con esto se puede re-derivar
  -- cualquier métrica después sin volver a pagar el scrape
  raw                    jsonb,
  created_at             timestamptz not null default now(),
  unique (social_account_id, snapshot_date)
);

create index account_snapshot_social_account_id_idx on account_snapshot (social_account_id, snapshot_date desc);

-- ---------------------------------------------------------------------
-- company: marcas/negocios (no creadores) — para tener a quién contactar
-- después. `type` sale directo de la categoría que la propia cuenta
-- declara en Instagram (businessCategoryName, ej. "Restaurant", "Coffee
-- Shop") — no se inventa un catálogo aparte, se usa lo que la plataforma
-- ya clasifica. Sin historial de snapshots: acá solo importa la foto
-- actual para decidir a quién contactar, no la evolución en el tiempo.
-- ---------------------------------------------------------------------
create table company (
  id              uuid primary key default gen_random_uuid(),
  username        text not null unique,
  display_name    text,
  profile_url     text,
  type            text, -- ej. "Restaurant", "Coffee Shop", "Clothing Store" (tal cual lo declara IG)
  follower_count  integer,
  bio_text        text,
  city            text,
  whatsapp        text,
  email           text,
  contact_status  text not null default 'not_contacted'
                    check (contact_status in ('not_contacted', 'contacted', 'responded', 'partnered', 'declined')),
  -- quién la etiquetó/mencionó y cuántas veces: [{"username":"...", "hits": 6}, ...]
  -- ordenado por hits desc. Se recalcula cada vez que se corre
  -- add-companies.mjs sobre esta cuenta, no es histórico acumulado.
  tagged_by_creators jsonb,
  discovered_via  text,
  notes           text,
  last_scraped_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index company_contact_status_idx on company (contact_status);
create index company_follower_count_idx on company (follower_count desc);

-- ---------------------------------------------------------------------
-- city_lead: creadores o marcas donde SÍ se identificó una ciudad
-- venezolana real, pero no es Caracas/Valencia (fuera del alcance actual).
-- No se descartan ni se fuerzan a Caracas/Valencia — quedan acá para si
-- algún día se expande a otras ciudades. Deliberadamente chica: no tiene
-- las columnas de trabajo activo (tier, engagement, contact_status, etc.)
-- de creator/company, solo lo mínimo para retomarlos después.
-- ---------------------------------------------------------------------
create table city_lead (
  id             bigserial primary key,
  kind           text not null check (kind in ('creator', 'company')),
  platform       text not null default 'instagram' check (platform in ('instagram', 'tiktok')),
  username       text not null,
  city           text not null,
  follower_count integer,
  notes          text,
  created_at     timestamptz not null default now(),
  unique (kind, platform, username)
);

create index city_lead_city_idx on city_lead (city);

-- ---------------------------------------------------------------------
-- RLS: el pipeline corre con la service_role key (Codespaces / GitHub
-- Actions), que ignora RLS de todas formas. Se activa igual como red de
-- seguridad gratis: si algún día se usa la anon key en algo (dashboard,
-- formulario), por defecto no expone nada hasta que se defina una policy.
-- ---------------------------------------------------------------------
alter table creator          enable row level security;
alter table social_account   enable row level security;
alter table account_snapshot enable row level security;
alter table company          enable row level security;
alter table city_lead        enable row level security;
