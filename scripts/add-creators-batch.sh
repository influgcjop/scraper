#!/usr/bin/env bash
# add-creators-batch.sh — lee un CSV (instagram,tiktok por fila, cualquiera
# de las dos columnas puede ir vacía) y corre enrich.mjs para cada fila.
# Al final imprime un resumen por creador: OK, o qué advertencia salió
# (perfil no encontrado, fallo guardando en Supabase, ciudad/nicho en
# null, error al guardar la cuenta).
#
#   bash scripts/add-creators-batch.sh                  # usa scripts/creators.csv
#   bash scripts/add-creators-batch.sh otra_lista.csv    # usa otro archivo
set -uo pipefail
cd "$(dirname "$0")/.."

CSV_FILE="${1:-scripts/creators.csv}"

if [[ ! -f "$CSV_FILE" ]]; then
  echo "No existe $CSV_FILE."
  echo "Créalo con este formato (encabezado incluido):"
  echo "  instagram,tiktok"
  echo "  sofiaccs,"
  echo "  ,emiliaperoztt"
  echo "  juanfoodie,juanfoodie_tt"
  exit 1
fi

declare -a SUMMARY=()
OK_COUNT=0
WARN_COUNT=0
ROW=0

while IFS=',' read -r IG TT; do
  ROW=$((ROW + 1))
  IG="$(echo "${IG:-}" | xargs)"
  TT="$(echo "${TT:-}" | xargs)"

  [[ -z "$IG" && -z "$TT" ]] && continue

  LABEL="${IG:-$TT}"
  [[ -n "$IG" && -n "$TT" ]] && LABEL="$IG / $TT"

  if [[ -n "$IG" && -n "$TT" ]]; then
    ARGS=("instagram:$IG" "tiktok:$TT")
  elif [[ -n "$IG" ]]; then
    ARGS=("instagram" "$IG")
  else
    ARGS=("tiktok" "$TT")
  fi

  echo
  echo "════ [$ROW] $LABEL ════"
  echo "→ npm run enrich -- ${ARGS[*]}"

  OUT="$(mktemp)"
  npm run enrich -- "${ARGS[@]}" > "$OUT" 2>&1
  STATUS=$?
  cat "$OUT"

  WARNINGS=()
  [[ $STATUS -ne 0 ]] && WARNINGS+=("terminó con error (exit $STATUS)")
  grep -qiE "profile not found|perfil no encontrado" "$OUT" && WARNINGS+=("perfil no encontrado")
  grep -q "⚠ snapshot:" "$OUT" && WARNINGS+=("no se pudo guardar el snapshot en Supabase")
  grep -q "⚠ detectCity:" "$OUT" && WARNINGS+=("claude -p falló detectando ciudad")
  grep -q "⚠ detectNiche:" "$OUT" && WARNINGS+=("claude -p falló detectando nicho")
  grep -q "🏙 ciudad:" "$OUT" || WARNINGS+=("ciudad quedó en null")
  grep -q "🏷 nicho:" "$OUT" || WARNINGS+=("nicho quedó en null")
  grep -q "✗ @" "$OUT" && WARNINGS+=("perfil no encontrado o error al guardar — ver detalle arriba")

  rm -f "$OUT"

  if [[ ${#WARNINGS[@]} -eq 0 ]]; then
    SUMMARY+=("✓ $LABEL — OK")
    OK_COUNT=$((OK_COUNT + 1))
  else
    JOINED=$(IFS='; '; echo "${WARNINGS[*]}")
    SUMMARY+=("⚠ $LABEL — $JOINED")
    WARN_COUNT=$((WARN_COUNT + 1))
  fi
done < <(tail -n +2 "$CSV_FILE" | grep -vE '^[[:space:]]*(#|$)')

echo
echo "══════════════════════════════"
echo "Resumen (${OK_COUNT} ok, ${WARN_COUNT} con advertencias):"
for line in "${SUMMARY[@]}"; do
  echo "  $line"
done
