#!/usr/bin/env bash
# =============================================================================
#  SERWER — globalne czyszczenie kopii starszych niż miesiąc
# =============================================================================
#  Dotyczy WSZYSTKICH kopii, nie tylko malinki: dumpy Postgresa, archiwa
#  Nextcloud/Paperless, stare tarballe, snapshoty restic.
#
#  Instalacja:
#     sudo install -m 0750 jarvis-prune-backups.sh /opt/jarvis/scripts/jarvis-prune-backups.sh
#
#  Użycie:
#     jarvis-prune-backups.sh            # PRÓBNIE — tylko pokazuje, co by skasował
#     jarvis-prune-backups.sh --wykonaj  # faktycznie kasuje
#
#  ZASADA BEZPIECZEŃSTWA: w każdym katalogu skrypt zostawia co najmniej
#  MIN_ZOSTAW najnowszych plików, nawet jeśli wszystkie są starsze niż limit.
#  Lepiej trzymać stary backup niż nie mieć żadnego.
# =============================================================================
set -uo pipefail
export LC_ALL=C

RETENCJA_DNI="${RETENCJA_DNI:-30}"
MIN_ZOSTAW="${MIN_ZOSTAW:-3}"

# Katalogi objęte czyszczeniem + wzorce plików, których dotyczy.
# Dopisz swoje. Format:  ścieżka|wzorzec
CELE=(
  "/mnt/data/backups|*.sql.gz"
  "/mnt/data/backups|*.dump"
  "/mnt/data/backups|*.tar.zst"
  "/mnt/data/backups|*.tar.gz"
  "/mnt/data/backups/malinka/images|*.img.zst"
  "/mnt/data/backups/malinka/meta|meta-*.txt"
)

# Repozytoria restic do przycięcia: ścieżka|plik-z-hasłem
RESTIC_REPOS=(
  "/mnt/data/backups/restic|/etc/jarvis/restic-pass"
)

WYKONAJ=0
[ "${1:-}" = "--wykonaj" ] && WYKONAJ=1

printf '=== Czyszczenie kopii starszych niż %s dni (min. %s najnowszych zostaje) ===\n' "$RETENCJA_DNI" "$MIN_ZOSTAW"
[ "$WYKONAJ" -eq 0 ] && printf '*** TRYB PRÓBNY — nic nie zostanie skasowane. Dodaj --wykonaj ***\n'
printf '\n'

SUMA_PLIKOW=0
SUMA_BAJTOW=0

for cel in "${CELE[@]}"; do
  KAT="${cel%%|*}"
  WZ="${cel##*|}"
  [ -d "$KAT" ] || continue

  # Ile plików pasujących w ogóle jest?
  ILE=$(find "$KAT" -maxdepth 1 -type f -name "$WZ" 2>/dev/null | wc -l)
  [ "$ILE" -eq 0 ] && continue

  printf '%s\n' "--- $KAT  (wzorzec $WZ, plików: $ILE)"

  # Lista kandydatów: starsze niż limit, ale z pominięciem MIN_ZOSTAW najnowszych
  KANDYDACI=$(find "$KAT" -maxdepth 1 -type f -name "$WZ" -printf '%T@ %s %p\n' 2>/dev/null \
              | sort -rn | tail -n +$((MIN_ZOSTAW + 1)) \
              | awk -v limit="$(date -d "-$RETENCJA_DNI days" +%s)" '$1 < limit {print}')

  if [ -z "$KANDYDACI" ]; then
    printf '    nic do skasowania\n\n'
    continue
  fi

  while read -r mtime rozmiar sciezka; do
    [ -n "${sciezka:-}" ] || continue
    printf '    %s  %8s  %s\n' "$(date -d "@${mtime%.*}" '+%Y-%m-%d')" \
           "$(numfmt --to=iec "$rozmiar" 2>/dev/null || echo "$rozmiar")" "$sciezka"
    SUMA_PLIKOW=$((SUMA_PLIKOW + 1))
    SUMA_BAJTOW=$((SUMA_BAJTOW + rozmiar))
    if [ "$WYKONAJ" -eq 1 ]; then
      rm -f -- "$sciezka" "$sciezka.sha256"
    fi
  done <<< "$KANDYDACI"
  printf '\n'
done

# --- restic ------------------------------------------------------------------
for rr in "${RESTIC_REPOS[@]}"; do
  REPO="${rr%%|*}"
  PASS="${rr##*|}"
  [ -d "$REPO" ] || continue
  [ -f "$PASS" ] || { printf '%s\n\n' "--- restic $REPO: brak pliku hasła $PASS, pomijam"; continue; }
  export RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD_FILE="$PASS"
  printf '%s\n' "--- restic $REPO"
  if [ "$WYKONAJ" -eq 1 ]; then
    restic forget --keep-within "${RETENCJA_DNI}d" --keep-last 7 --prune 2>&1 | sed 's/^/    /'
  else
    restic forget --keep-within "${RETENCJA_DNI}d" --keep-last 7 --dry-run 2>&1 | sed 's/^/    /'
  fi
  printf '\n'
done

printf '=== Podsumowanie: %s plików, %s ===\n' "$SUMA_PLIKOW" \
       "$(numfmt --to=iec "$SUMA_BAJTOW" 2>/dev/null || echo "$SUMA_BAJTOW B")"
[ "$WYKONAJ" -eq 0 ] && printf 'Tryb próbny — powtórz z --wykonaj, żeby faktycznie skasować.\n'

exit 0
