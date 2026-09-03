/**
 * discover.mjs — imprime en terminal los usernames encontrados minando
 * hashtags, cuentas de marca, o los posts de un creador. No escribe nada
 * en Supabase ni scrapea perfiles completos (eso lo hace enrich.mjs) — es
 * solo para mirar la lista y copiar lo que vale la pena a
 * scripts/creators.csv o scripts/companies.csv.
 *
 *   node scripts/discover.mjs hashtag ccsfoodies caracasfood
 *   node scripts/discover.mjs brand   restaurante_x tienda_y
 *   node scripts/discover.mjs creator sofiaccs            # marcas que ESE creador ya etiquetó
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
import { fromHashtags, fromBrands, fromCreators, countCandidates } from './lib/mining.mjs';

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

const MODES = {
  hashtag: fromHashtags,
  brand: fromBrands,
  creator: fromCreators,
};

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const fn = MODES[mode];
  if (!fn || !args.length) {
    console.error('uso: node scripts/discover.mjs <hashtag|brand|creator> <arg1> [arg2 ...]');
    process.exit(1);
  }
  const rows = await fn(args);
  const candidates = countCandidates(rows);
  printCandidates(candidates);

  if (mode === 'creator') {
    console.log('\nEsto son marcas que el creador ya etiquetó — copia las que valgan la pena a scripts/companies.csv y corre npm run add-companies.');
  } else {
    console.log('\nCopia los que valgan la pena a scripts/creators.csv y corre npm run add-creators-batch.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
