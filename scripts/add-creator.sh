#!/usr/bin/env bash
# add-creator.sh — pregunta por el username de Instagram y de TikTok (uno de
# los dos puede quedar en blanco), corre enrich.mjs, y al final da un
# resumen legible de cualquier cosa que haya salido mal y que el script no
# pudo arreglar solo (perfil no encontrado, fallo guardando en Supabase,
# ciudad o nicho que quedaron en null, etc).
set -uo pipefail
cd "$(dirname "$0")/.."

read -rp "Usuario de Instagram (déjalo en blanco si no tiene): " IG_USER
read -rp "Usuario de TikTok    (déjalo en blanco si no tiene): " TT_USER

IG_USER="$(echo "$IG_USER" | xargs)"
TT_USER="$(echo "$TT_USER" | xargs)"

if [[ -z "$IG_USER" && -z "$TT_USER" ]]; then
  echo "No diste ningún username. Nada que hacer."
  exit 1
fi

if [[ -n "$IG_USER" && -n "$TT_USER" ]]; then
  ARGS=("instagram:$IG_USER" "tiktok:$TT_USER")
elif [[ -n "$IG_USER" ]]; then
  ARGS=("instagram" "$IG_USER")
else
  ARGS=("tiktok" "$TT_USER")
fi

echo
echo "→ npm run enrich -- ${ARGS[*]}"
echo

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT

npm run enrich -- "${ARGS[@]}" 2>&1 | tee "$OUTPUT_FILE"
STATUS=${PIPESTATUS[0]}

echo
echo "── Resumen ──"

WARNINGS=()

[[ $STATUS -ne 0 ]] && WARNINGS+=("el script terminó con error (exit $STATUS)")

grep -qiE "profile not found|perfil no encontrado" "$OUTPUT_FILE" &&
  WARNINGS+=("no se encontró el perfil en la plataforma (revisa el username)")

grep -q "⚠ snapshot:" "$OUTPUT_FILE" &&
  WARNINGS+=("no se pudo guardar el snapshot de métricas en Supabase")

grep -q "⚠ detectCity:" "$OUTPUT_FILE" &&
  WARNINGS+=("claude -p falló detectando la ciudad (quedó como estaba)")

grep -q "⚠ detectNiche:" "$OUTPUT_FILE" &&
  WARNINGS+=("claude -p falló detectando el nicho (quedó como estaba)")

grep -q "🏙 ciudad:" "$OUTPUT_FILE" ||
  WARNINGS+=("no se encontró ciudad en la bio — quedó en null")

grep -q "🏷 nicho:" "$OUTPUT_FILE" ||
  WARNINGS+=("no se encontró nicho en bio/captions — quedó en null")

grep -q "✗ @" "$OUTPUT_FILE" &&
  WARNINGS+=("hubo un problema con alguna cuenta (no encontrada, o error al guardar) — revisa el detalle arriba")

if [[ ${#WARNINGS[@]} -eq 0 ]]; then
  echo "Todo bien, sin advertencias."
else
  echo "Cosas a revisar:"
  for w in "${WARNINGS[@]}"; do
    echo "  ⚠ $w"
  done
fi
