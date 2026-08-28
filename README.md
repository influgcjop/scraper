# Base de datos de creadores venezolanos

Pipeline para construir y mantener el pool de creadores de contenido
(Instagram/TikTok) del marketplace: **food, lifestyle y travel, Caracas y
Valencia**. El objetivo son 100 creadores **calificados** — no 100 usernames
en una lista — listos para las primeras campañas.

---

## Cómo funciona

1. **Descubrimiento** (`scripts/discover.mjs`) — mina cuentas de marcas y
   hashtags locales, **imprime en terminal** los usernames candidatos (no
   scrapea perfiles completos, no escribe en Supabase).
2. **Curación manual** — copias los candidatos que valen la pena a
   `scripts/creators.csv` (columnas `instagram,tiktok`, cualquiera puede
   quedar vacía).
3. **Enriquecimiento** (`npm run add-creators-batch`, o `enrich.mjs`
   directo) — scrapea el perfil vía Apify, calcula métricas (mediana de
   engagement sobre los últimos 12 posts, no promedio — un post viral no
   debe inflar a un creador mediocre), detecta ciudad y nicho con
   `claude -p`, y guarda todo en Supabase.
4. **Revisión manual** — un humano pasa la cuenta de `enriched` a
   `qualified` (ver más abajo — no se salta).

## Arquitectura

- **Supabase** (`supabase/schema.sql`) —
  - `creator`: la persona. Separada de `social_account` porque un mismo
    creador puede tener IG y TikTok con métricas muy distintas.
  - `social_account`: una fila por plataforma (`instagram` | `tiktok`).
  - `account_snapshot`: una foto de métricas por día, **nunca se sobrescribe
    entre días distintos** — así se ve crecimiento y se detecta compra de
    seguidores (+30 % de seguidores en una semana con engagement cayendo).
  - `creator.niche`: un solo valor (catálogo fijo en el `check` de la
    columna), lo asigna `claude -p` igual que `city`.
- **Apify** — `apify/instagram-profile-scraper` (perfil + posts) y
  `clockworks/tiktok-scraper` para enriquecer; `apify/instagram-scraper`
  para minar hashtags/marcas en `discover.mjs`.
- **`claude -p`** (`scripts/lib/claude.mjs` + `scripts/lib/classify.mjs`) —
  se invoca como subproceso sobre la bio y captions ya scrapeados (no vuelve
  a llamar a Apify) para clasificar `city` (Caracas/Valencia) y `niche`.
- **`scripts/creators.csv` + `scripts/add-creators-batch.sh`** — la lista de
  creadores a cargar (curada a mano desde `discover.mjs` u otras fuentes) y
  el runner que los procesa uno por uno con `enrich.mjs`, con un resumen al
  final de qué salió bien y qué necesita revisión.

## Requisitos

- Node 20+
- Cuenta de Apify (free tier: ~$5/mes de créditos, alcanza para el arranque)
- Proyecto de Supabase con `supabase/schema.sql` ya corrido en el SQL Editor
- `claude` CLI disponible y autenticado en el entorno (se invoca como
  subproceso desde `enrich.mjs`)

## Setup

```bash
cp .env.example .env   # APIFY_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm install
```

Si corres esto en GitHub Codespaces, mejor guarda `APIFY_TOKEN` y
`SUPABASE_SERVICE_ROLE_KEY` como **Codespaces secrets** del repo, así no
tocas `.env` nunca.

---

## Uso

### Enriquecer cuentas puntuales

```bash
DEBUG_RAW=1 npm run enrich -- instagram usuario1 usuario2
npm run enrich -- tiktok usuario1
```

`DEBUG_RAW=1` vuelca el JSON crudo de Apify a `./tmp/`. **Ábrelo y verifica
el mapeo de campos** la primera vez que agregues una cuenta o cambies de
actor — los actors de Apify cambian nombres de campo entre versiones y el
script falla en silencio con `null` si no se revisa.

Si el mismo creador tiene cuentas en ambas plataformas con **usernames
distintos** (ej. `@foo` en IG, `@foo.oficial` en TikTok), vincúlalas
explícitamente para que caigan bajo un solo `creator` en vez de duplicarlo:

```bash
npm run enrich -- instagram:usuario_ig tiktok:usuario_tiktok
```

Cuando el username sí coincide entre plataformas, `enrich.mjs` los enlaza
solo (Fuente 5 del README) y no hace falta esta sintaxis.

### Descubrir candidatos

```bash
npm run discover -- brand   restaurante_a restaurante_b tienda_c
npm run discover -- hashtag ccsfoodies caracasfood
```

Solo imprime en la terminal los usernames encontrados, con cuántas veces
apareció cada uno (`hits`) y de dónde salió — no llama a `enrich.mjs` ni
toca Supabase. Es una lista para revisar a mano, no una carga automática.

### Cargar creadores en lote

Copia los usernames que valgan la pena (de `discover.mjs`, de una lista de
agencia, de donde sea) a `scripts/creators.csv`:

```csv
instagram,tiktok
sofiaccs,sofiaccs_tt
juanfoodie,
,solo_tiene_tiktok
```

Cualquiera de las dos columnas puede ir vacía. Después:

```bash
npm run add-creators-batch
```

Procesa fila por fila con `enrich.mjs` (vinculando IG+TikTok del mismo
creador aunque el username no coincida) y termina con un resumen: cuántos
salieron bien, y para cada uno con problemas, qué pasó exactamente —
perfil no encontrado, fallo guardando en Supabase, ciudad/nicho en `null`,
etc. Para cargar un creador suelto sin editar el CSV, `npm run add-creator`
hace las mismas preguntas de forma interactiva.

### Revisar la calidad de una corrida

No existe una vista `creator_scorecard` — se decidió no construirla. La
calificación (tabla de criterios abajo) se compara a mano contra este query:

```sql
select c.display_name, c.city, sa.platform, sa.username,
       s.follower_count, s.engagement_rate_median, s.comment_like_ratio,
       s.posts_per_week, s.last_post_at
from creator c
join social_account sa on sa.creator_id = c.id
join account_snapshot s on s.social_account_id = sa.id
order by s.snapshot_date desc;
```

---

## Criterios de calificación

Ajústalos con datos reales después de las primeras 20 cuentas — estos son
puntos de partida, no verdad revelada. Ninguno se aplica automáticamente
(no hay `creator_scorecard`): son la guía para la revisión manual.

| Criterio | Umbral | Por qué |
|---|---|---|
| Seguidores | 3.000 – 150.000 | <3k no tiene alcance vendible; >150k ya tiene agencia y poco incentivo para probar algo nuevo (sección V del doc) |
| Núcleo objetivo | 5.000 – 60.000 | micro/meso: mejor ER, tarifas accesibles, más receptivos |
| Engagement rate | ≥ 1,5 % | referencia de mercado para micro en IG: 1–3 % normal, >3 % bueno |
| Frecuencia | ≥ 2 posts/semana | menos que eso, la campaña se queda sin ventana de publicación |
| Actividad | último post ≤ 30 días | cuentas dormidas ensucian el discovery (sección E) |
| Comment/like ratio | 0,3 % – 8 % | por debajo = seguidores comprados; por encima = engagement pods |
| Follower/following | > 2 | ratio ~1 suele indicar cuenta de follow-back, no de audiencia |
| Mercado de audiencia | VE | **no automatizado** — el filtro que más creadores descarta, ver abajo |
| Marcas previas | ≥ 1 | **no automatizado** — mira el perfil directamente en la revisión (ver "Lo que no está aquí") |

### El filtro de audiencia venezolana

No puedes obtener la demografía de audiencia scrapeando. Ni con Apify, ni
con ninguna herramienta: solo el creador ve sus Insights. Con la diáspora
venezolana esto es el riesgo #1 de esta base de datos — un perfil con 80k
seguidores repartidos entre Madrid, Miami y Santiago no le sirve a un
restaurante de Chacao.

Hoy el único proxy automatizado es la **bio**, vía `claude -p`
(`detectCity`, guarda `Caracas`/`Valencia`/`null` en `creator.city`). El
resto son juicio humano en la revisión manual, mirando el perfil
directamente — no hay columnas dedicadas para esto:

- Geotags de posts recientes.
- Marcas que etiqueta: si etiqueta comercios venezolanos, su audiencia lo es.
- Léxico en captions y comentarios (chamo, pana, arepa, "en Caracas").
- Hashtags locales recurrentes.

**Dato real**: pídelo en el onboarding (captura de "Audiencia" en IG
Insights o Analytics de TikTok) y anótalo en `creator.notes`. Ese dato es el
activo no portable de la sección H del documento: vive en tu plataforma, no
en WhatsApp, y es la razón por la que una marca vuelve a buscarte en vez de
escribirle directo al creador.

---

## Cómo llegar a 100

Necesitas un embudo, no una lista. Ratios estimados: de cada 100 usernames
crudos, ~30 pasan filtros automáticos, ~15 pasan revisión manual, ~10 aceptan
sumarse. Para 100 calificados: **~600–800 candidatos crudos**.

### Fuente 1 — Cuentas de marcas (la de mejor señal)

Reúne 25–40 handles de Caracas y Valencia: restaurantes, cafés, tiendas de
ropa, gimnasios, hoteles, marcas de consumo. Scrapea sus posts y quédate con
quién etiquetan y quién los etiqueta. Todo el que aparezca ahí **ya hace
colaboraciones**: no tienes que educarlo sobre qué es una campaña.

Rendimiento esperado: 200–350 candidatos, calidad alta.

### Fuente 2 — Hashtags locales

`#ccsfoodies` `#caracasfood` `#comidavenezolana` `#caracas` `#ccs` `#venezuela`
`#lifestylevenezuela` `#emprendimientovenezolano` — combinados con el filtro
de seguidores. Volumen alto, señal media (muchos usuarios normales).

Rendimiento: 200–300 candidatos, ~15 % útiles.

### Fuente 3 — Bola de nieve

Por cada creador que califica, mira a quién SIGUE (los creadores se siguen
entre sí) y las "cuentas sugeridas" que Instagram muestra en su perfil. Esto
es lo que te lleva de 60 a 100 cuando las otras fuentes se agotan. Anota el
origen como `discovered_via = 'similar:@username'` para saber qué semillas
rinden más.

Rendimiento: 100–200 candidatos, calidad alta si las semillas eran buenas.

### Fuente 4 — Humano

La entrevistada de agencia/PR del documento tiene una lista mental de 30–50
creadores que ya funcionan. Vale más que 500 filas scrapeadas. Cárgalos a
mano con `discovered_via = 'manual:agencia'` y compáralos contra tus
métricas: si tu criterio no los pone arriba, tu criterio está mal calibrado.

### Fuente 5 — TikTok, después

Cruza por el link de bio o por coincidencia de username. Muchos creadores VE
tienen ambas cuentas con métricas muy distintas — de ahí el diseño de
`social_account` separado de `creator`.

### Orden recomendado

Semana 1: fuente 4 + fuente 1 → primeros 40–60 candidatos, valida el pipeline.
Semana 2: fuente 2 + fuente 3 → llegar a ~600 crudos.
Semana 3: revisión manual y contacto.

---

## Revisión manual (no la saltes)

El script mueve a `enriched` y ya deja `city`/`niche` con lo que detectó
`claude -p`. El paso a `qualified` es humano, ~90 segundos por cuenta: abrir
el perfil, mirar 5 comentarios (¿son reales o "nice pic 🔥"?), confirmar o
corregir a mano la ciudad y el nicho asignados automáticamente, y marcar
`creator_type` (influencer / UGC / ambos).

Con 100 cuentas son ~3 horas. Es exactamente lo que dice la sección E del
documento: en el MVP el operador humano detecta fraude mejor que cualquier
herramienta, con menos falsos positivos.

---

## Costos aproximados

| Concepto | Coste |
|---|---|
| Supabase | Free tier de sobra |
| Codespaces | 60 h/mes gratis |
| Apify · 5 perfiles | céntimos |
| Apify · 100 perfiles + posts | ~$1–3 |
| Apify · descubrimiento (~800 posts de hashtags/marcas) | ~$2–5 |

Los créditos gratis de Apify ($5/mes) cubren el arranque completo.

---

## Notas de privacidad

- Solo datos públicos.
- Llena `creator.discovered_via` a mano al cargar cada fila (`brand:@handle`,
  `hashtag:#tag`, `manual:agencia`, etc.): si un creador pregunta de dónde
  saliste, tienes respuesta.
- No hagas scraping de emails de bio para outreach masivo. El contacto es
  manual y dirigido, como dice la sección E del documento.
- Un perfil no se muestra a ninguna marca hasta que el creador confirmó sus
  datos y aceptó estar en el pool (`pipeline_status = 'onboarded'`).
- Ese momento de confirmación es también cuando pides los Insights de
  audiencia reales — anótalos en `notes`. Dos pájaros de un tiro.

---

## Lo que NO está aquí a propósito

`post`, `brand_mention`, `creator_niche` y `creator_scorecard` se diseñaron
y se descartaron a propósito para mantener el schema simple mientras el
pool es chico — la señal de "marcas con las que ya colaboró" y el filtro
automático de calificación no existen todavía, se evalúan a mano en la
revisión manual. `discovery_candidate` (la cola en Supabase) también se
descartó: la curación de candidatos vive en `scripts/creators.csv`, no en
la base de datos — un archivo de texto es suficiente para este volumen y
no hay que sincronizar dos fuentes de verdad.

Matching automático, scoring con IA, pricing engine, detección de fraude
automatizada, refresco programado (cron/GitHub Actions), app — todo eso
está explícitamente fuera del MVP en tu documento (secciones F y M) y con
100 filas no tendrías datos para entrenar nada. Primero que la tabla tenga
100 filas correctas.
