#!/usr/bin/env bash
# =============================================================================
#  SERWER — backup MALINKI (model PULL: to serwer ciągnie dane z Pi)
# =============================================================================
#  Instalacja:
#     sudo install -m 0750 backup-malinka.sh /opt/jarvis/scripts/backup-malinka.sh
#     sudo install -m 0640 backup-malinka.env /etc/jarvis/backup-malinka.env
#     sudo mkdir -p /etc/jarvis && sudo chmod 0750 /etc/jarvis
#
#  Tryby:
#     backup-malinka.sh daily    # rsync rootfs + metadane + snapshot restic  (codziennie)
#     backup-malinka.sh image    # pełny obraz nośnika Pi (raz w tygodniu)
#     backup-malinka.sh prune    # samo czyszczenie retencji (30 dni)
#     backup-malinka.sh verify   # restic check + lista snapshotów
#     backup-malinka.sh test     # sprawdzenie łączności i uprawnień, bez kopiowania
#
#  Wymaga na serwerze: rsync, restic, zstd, ssh, curl.
#     apt install rsync restic zstd curl
# =============================================================================
set -uo pipefail
export LC_ALL=C

# ----------------------------------------------------------------------------
#  KONFIGURACJA — nadpisywana przez /etc/jarvis/backup-malinka.env
# ----------------------------------------------------------------------------
CONF=/etc/jarvis/backup-malinka.env
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

PI_HOST="${PI_HOST:-malinka}"                 # nazwa lub IP malinki
PI_USER="${PI_USER:-bkp}"                     # user z forced command
PI_KEY="${PI_KEY:-/root/.ssh/jarvis_backup}"  # klucz prywatny serwera

DEST_ROOT="${DEST_ROOT:-/mnt/data/backups/malinka}"
MIRROR="${MIRROR:-$DEST_ROOT/rootfs}"         # lustro plików (szybkie odtworzenie)
IMAGES="${IMAGES:-$DEST_ROOT/images}"         # obrazy nośnika
METADIR="${METADIR:-$DEST_ROOT/meta}"

RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/mnt/data/backups/restic}"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/etc/jarvis/restic-pass}"
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE

RETENCJA_DNI="${RETENCJA_DNI:-30}"            # <<< kasujemy wszystko starsze niż miesiąc
RESTIC_KEEP_LAST="${RESTIC_KEEP_LAST:-7}"     # bezpiecznik: zawsze N ostatnich, choćby były stare

DISCORD_WEBHOOK="${DISCORD_WEBHOOK:-}"        # https://discord.com/api/webhooks/...
NTFY_URL="${NTFY_URL:-}"                      # np. https://ntfy.dom/jarvis
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"        # ping start/fail/success

# (dodane 2026-09-06) Uptime Kuma — push URL osobny dla trybu daily i image,
# bo to dwa różne monitory z różnym interwałem bicia serca w Kumie.
KUMA_PUSH_DAILY_URL="${KUMA_PUSH_DAILY_URL:-}"   # monitor "Backup malinka – dzienny"
KUMA_PUSH_IMAGE_URL="${KUMA_PUSH_IMAGE_URL:-}"   # monitor "Backup malinka – obraz tygodniowy"

LOCKFILE_IDLE="${LOCKFILE_IDLE:-/etc/jarvis-no-autoshutdown}"
LOCKFILE_RUN="${LOCKFILE_RUN:-/run/backup-malinka.lock}"
LOG="${LOG:-/var/log/jarvis-backup-malinka.log}"

SSH_OPTS=(-i "$PI_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new
          -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
PI="$PI_USER@$PI_HOST"

# Czego NIE kopiujemy z malinki (pseudo-fs, cache, śmieci)
EXCLUDES=(
  --exclude=/proc/ --exclude=/sys/ --exclude=/dev/ --exclude=/run/
  --exclude=/tmp/ --exclude=/mnt/ --exclude=/media/ --exclude=/lost+found/
  --exclude=/swapfile --exclude=/var/swap --exclude=/var/cache/apt/archives/
  --exclude=/var/lib/docker/overlay2/ --exclude=/var/lib/docker/tmp/
  --exclude=/var/lib/containerd/
  --exclude=/home/*/.cache/ --exclude=/root/.cache/
  --exclude=/var/log/journal/
)
# UWAGA: /var/lib/docker/volumes/ ZOSTAJE — tam są dane usług.
# Wyrzucamy tylko warstwy obrazów (overlay2), bo te odtworzy `docker compose pull`.

# ----------------------------------------------------------------------------
#  Infrastruktura skryptu
# ----------------------------------------------------------------------------
START_TS=$(date +%s)
STEPS_OK=()
STEPS_FAIL=()

ts()  { date '+%Y-%m-%d %H:%M:%S'; }
say() { printf '[%s] %s\n' "$(ts)" "$*" | tee -a "$LOG"; }
ok()  { STEPS_OK+=("$*");   say "  OK   $*"; }
bad() { STEPS_FAIL+=("$*"); say "  BLAD $*"; }

jsonstr() { # jsonstr <tekst> -> bezpieczny string JSON (bez zależności od jq/pythona)
  local s="$1"
  s=${s//\\/\\\\}      # backslash
  s=${s//\"/\\\"}      # cudzysłów
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}    # nowe linie
  printf '"%s"' "${s:0:3900}"
}

powiadom() { # powiadom <tytul> <tresc> <ok|err>
  local tytul="$1" tresc="$2" typ="${3:-ok}" kolor
  [ "$typ" = "err" ] && kolor=15158332 || kolor=3066993
  if [ -n "$DISCORD_WEBHOOK" ]; then
    curl -fsS -m 15 -H 'Content-Type: application/json' -X POST "$DISCORD_WEBHOOK" \
      -d "{\"embeds\":[{\"title\":$(jsonstr "$tytul"),\"description\":$(jsonstr "$tresc"),\"color\":$kolor}]}" \
      >/dev/null 2>&1 || true
  fi
  if [ -n "$NTFY_URL" ]; then
    curl -fsS -m 15 -H "Title: $tytul" -H "Priority: $([ "$typ" = err ] && echo high || echo default)" \
      -d "$tresc" "$NTFY_URL" >/dev/null 2>&1 || true
  fi
}

hc() { # hc <start|fail|""> — ping do healthchecks
  [ -n "$HEALTHCHECK_URL" ] || return 0
  curl -fsS -m 10 "${HEALTHCHECK_URL}${1:+/$1}" >/dev/null 2>&1 || true
}

kuma_push() { # kuma_push <up|down> <komunikat> — dead man's switch w Uptime Kumie
  local url=""
  case "$TRYB" in
    daily) url="$KUMA_PUSH_DAILY_URL" ;;
    image) url="$KUMA_PUSH_IMAGE_URL" ;;
    *) return 0 ;;   # full/prune/verify/test — bez osobnego monitora Kumy
  esac
  [ -n "$url" ] || return 0
  curl -fsS -m 10 -G "$url" --data-urlencode "status=$1" --data-urlencode "msg=$2" >/dev/null 2>&1 || true
}

sprzataj() {
  local rc=$?
  # zawsze odblokuj Dockera na malince, gdyby skrypt padł w środku obrazu
  if [ "${IMAGE_IN_PROGRESS:-0}" -eq 1 ]; then
    say "Awaryjne wznowienie Dockera na malince"
    ssh "${SSH_OPTS[@]}" "$PI" image-end >/dev/null 2>&1 || true
  fi
  [ "${LOCK_MINE:-0}" -eq 1 ] && rm -f "$LOCKFILE_IDLE"
  exit $rc
}
trap sprzataj EXIT INT TERM

pi() { ssh "${SSH_OPTS[@]}" "$PI" "$@"; }

# ----------------------------------------------------------------------------
#  Kroki
# ----------------------------------------------------------------------------
krok_przygotuj() {
  mkdir -p "$MIRROR" "$IMAGES" "$METADIR" "$(dirname "$LOG")"
  # Lockfile: idle-shutdown ma NIE uciąć backupu (roadmapa #3 z audytu)
  if [ ! -e "$LOCKFILE_IDLE" ]; then touch "$LOCKFILE_IDLE" && LOCK_MINE=1; else LOCK_MINE=0; fi
  if [ "${LOCK_MINE:-0}" = 1 ]; then
    say "Lockfile idle-shutdown założony przez backup: $LOCKFILE_IDLE"
  else
    say "Lockfile idle-shutdown już istniał: $LOCKFILE_IDLE (nie ruszam go)"
  fi
}

krok_lacznosc() {
  local out
  out=$(pi ping 2>&1)
  if printf '%s' "$out" | grep -q '^pong'; then
    ok "Łączność z malinką: $out"
  else
    bad "Brak łączności z malinką: $out"
    return 1
  fi
}

krok_meta() {
  local f="$METADIR/meta-$(date +%F).txt"
  if pi meta > "$f" 2>/dev/null && [ -s "$f" ]; then
    ln -sfn "$(basename "$f")" "$METADIR/meta-latest.txt"
    ok "Metadane systemu zapisane ($(wc -l < "$f") linii): $f"
  else
    bad "Nie udało się pobrać metadanych"
  fi
}

krok_rsync() {
  say "rsync: ciągnę rootfs malinki -> $MIRROR"
  local rc
  rsync -aHAX --numeric-ids --delete --delete-excluded \
        --info=stats2 --human-readable \
        "${EXCLUDES[@]}" \
        -e "ssh ${SSH_OPTS[*]}" \
        "$PI:/" "$MIRROR/" 2>&1 | tee -a "$LOG"
  rc=${PIPESTATUS[0]}
  # 24 = "some files vanished during transfer" — normalne na żywym systemie
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 24 ]; then
    ok "rsync zakończony (kod $rc), lustro: $(du -sh "$MIRROR" 2>/dev/null | cut -f1)"
  else
    bad "rsync zwrócił kod $rc"
    return 1
  fi
}

krok_restic_init() {
  if ! restic cat config >/dev/null 2>&1; then
    say "Repozytorium restic nie istnieje — inicjalizuję $RESTIC_REPOSITORY"
    if restic init 2>&1 | tee -a "$LOG"; then ok "restic init"; else bad "restic init"; return 1; fi
  fi
}

krok_restic_snapshot() {
  say "restic: snapshot lustra malinki"
  if restic backup "$MIRROR" "$METADIR" \
        --tag malinka --tag rootfs \
        --host malinka \
        --exclude-caches \
        2>&1 | tee -a "$LOG"; then
    ok "Snapshot restic utworzony"
  else
    bad "restic backup nie powiódł się"
    return 1
  fi
}

krok_obraz() {
  local dev rozmiar plik
  dev=$(pi image-device 2>/dev/null | tr -d '\r')
  rozmiar=$(pi image-size 2>/dev/null | tr -d '\r')
  if [ -z "$dev" ] || [ -z "$rozmiar" ]; then bad "Nie ustaliłem nośnika malinki"; return 1; fi
  plik="$IMAGES/malinka-$(date +%F).img.zst"
  say "Obraz: $dev, $(numfmt --to=iec "$rozmiar" 2>/dev/null || echo "$rozmiar B") -> $plik"

  IMAGE_IN_PROGRESS=1
  if ! pi image-begin >/dev/null 2>&1; then bad "image-begin (wyciszenie usług) nie powiodło się"; IMAGE_IN_PROGRESS=0; return 1; fi
  ok "Docker na malince zatrzymany na czas obrazu"

  # Strumień: dd na malince -> zstd na serwerze (Pi nie marnuje CPU na kompresję)
  if pi image-stream 2>/dev/null | zstd -T0 -3 -o "$plik" -f 2>>"$LOG"; then
    ok "Obraz zapisany: $plik ($(du -h "$plik" | cut -f1))"
    sha256sum "$plik" > "$plik.sha256"
  else
    bad "Strumieniowanie obrazu nie powiodło się"
    rm -f "$plik"
  fi

  pi image-end >/dev/null 2>&1 && ok "Docker na malince wznowiony" || bad "NIE UDAŁO SIĘ wznowić Dockera na malince — sprawdź RĘCZNIE!"
  IMAGE_IN_PROGRESS=0
}

restic_forget_raz() {
  restic forget --tag malinka \
        --keep-within "${RETENCJA_DNI}d" \
        --keep-last "$RESTIC_KEEP_LAST" \
        --prune
}

restic_forget_z_samonaprawa() {
  # (dodane 2026-09-06) Widzieliśmy serię awarii: stary, osierocony lock
  # (proces, który padł w środku poprzedniego przebiegu — reboot/OOM/kill)
  # blokował KAŻDY kolejny forget/prune, aż do ręcznej interwencji.
  # `restic unlock` bez --remove-all sam sprawdza, czy proces trzymający
  # lock jeszcze żyje — bezpieczne do automatycznego wywołania, bo flock
  # na tym skrypcie i tak nie dopuszcza dwóch backupów naraz.
  local out rc
  out=$(restic_forget_raz 2>&1); rc=$?
  printf '%s\n' "$out" >> "$LOG"

  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'already locked'; then
    say "restic forget/prune: repo zablokowane przez osierocony lock — probuje 'restic unlock' i ponawiam raz"
    if restic unlock 2>&1 | tee -a "$LOG"; then
      out=$(restic_forget_raz 2>&1); rc=$?
      printf '%s\n' "$out" >> "$LOG"
    fi
  fi

  printf '%s\n' "$out"
  return $rc
}

krok_retencja() {
  say "Retencja: kasuję kopie starsze niż $RETENCJA_DNI dni"

  # 1) restic — snapshoty malinki
  if restic cat config >/dev/null 2>&1; then
    if restic_forget_z_samonaprawa; then
      ok "restic forget/prune (keep-within ${RETENCJA_DNI}d, keep-last $RESTIC_KEEP_LAST)"
    else
      bad "restic forget/prune"
    fi
  fi

  # 2) obrazy nośnika — ale ZAWSZE zostaw przynajmniej jeden, choćby był stary
  local n zostaje
  zostaje=$(find "$IMAGES" -maxdepth 1 -type f -name '*.img.zst' -newermt "-${RETENCJA_DNI} days" 2>/dev/null | wc -l)
  if [ "${zostaje:-0}" -ge 1 ]; then
    n=$(find "$IMAGES" -maxdepth 1 -type f \( -name '*.img.zst' -o -name '*.img.zst.sha256' \) -mtime "+$RETENCJA_DNI" -print -delete 2>/dev/null | wc -l)
    ok "Obrazy: usunięto ${n:-0} plików starszych niż $RETENCJA_DNI dni (świeżych obrazów: $zostaje)"
  else
    ok "Obrazy: NIC nie kasuję — nie ma ani jednego obrazu młodszego niż $RETENCJA_DNI dni"
  fi

  # 3) metadane
  n=$(find "$METADIR" -maxdepth 1 -type f -name 'meta-*.txt' -mtime "+$RETENCJA_DNI" -print -delete 2>/dev/null | wc -l)
  ok "Metadane: usunięto ${n:-0} plików starszych niż $RETENCJA_DNI dni"

  say "Zajętość po czyszczeniu: $(du -sh "$DEST_ROOT" 2>/dev/null | cut -f1) w $DEST_ROOT"
}

krok_verify() {
  say "restic check (integralność repozytorium)"
  restic check --read-data-subset=2% 2>&1 | tee -a "$LOG" && ok "restic check" || bad "restic check"
  say "Snapshoty malinki:"
  restic snapshots --tag malinka 2>&1 | tee -a "$LOG"
}

# ----------------------------------------------------------------------------
#  Główna logika
# ----------------------------------------------------------------------------
TRYB="${1:-daily}"

# Nie pozwól na dwa równoległe przebiegi
exec 9>"$LOCKFILE_RUN"
if ! flock -n 9; then
  say "Inny backup malinki już trwa — kończę."
  exit 0
fi

say "===== START backup-malinka.sh tryb=$TRYB ====="
hc start

case "$TRYB" in
  test)
    krok_przygotuj
    krok_lacznosc || true
    say "Test rsync (dry-run, pierwsze 20 pozycji):"
    rsync -aHAX --numeric-ids --dry-run --itemize-changes "${EXCLUDES[@]}" \
          -e "ssh ${SSH_OPTS[*]}" "$PI:/" "$MIRROR/" 2>&1 | head -20 | tee -a "$LOG"
    say "Metadane (pierwsze 15 linii):"
    pi meta 2>&1 | head -15 | tee -a "$LOG"
    ;;
  daily)
    krok_przygotuj
    krok_lacznosc && { krok_meta; krok_rsync && { krok_restic_init && krok_restic_snapshot; }; }
    krok_retencja
    ;;
  image)
    krok_przygotuj
    krok_lacznosc && krok_obraz
    krok_retencja
    ;;
  full)
    krok_przygotuj
    krok_lacznosc && { krok_meta; krok_rsync; krok_restic_init && krok_restic_snapshot; krok_obraz; }
    krok_retencja
    ;;
  prune)
    krok_przygotuj
    krok_retencja
    ;;
  verify)
    krok_przygotuj
    krok_verify
    ;;
  *)
    echo "Nieznany tryb: $TRYB (użyj: daily | image | full | prune | verify | test)" >&2
    exit 2
    ;;
esac

# ----------------------------------------------------------------------------
#  Raport
# ----------------------------------------------------------------------------
CZAS=$(( $(date +%s) - START_TS ))
PODSUM="Tryb: $TRYB
Czas: $((CZAS/60)) min $((CZAS%60)) s
Sukcesy: ${#STEPS_OK[@]}
Błędy: ${#STEPS_FAIL[@]}"
[ "${#STEPS_FAIL[@]}" -gt 0 ] && PODSUM="$PODSUM

Co poszło źle:
$(printf -- '- %s\n' "${STEPS_FAIL[@]}")"

say "===== KONIEC — sukcesy: ${#STEPS_OK[@]}, błędy: ${#STEPS_FAIL[@]}, czas: ${CZAS}s ====="

if [ "${#STEPS_FAIL[@]}" -gt 0 ]; then
  powiadom "JARVIS: backup malinki NIE POWIÓDŁ SIĘ" "$PODSUM" err
  hc fail
  kuma_push down "bledy: ${#STEPS_FAIL[@]}, czas: ${CZAS}s"
  exit 1
else
  # Sukces raportujemy tylko dla obrazu/full — codzienny sukces to szum
  case "$TRYB" in image|full|verify) powiadom "JARVIS: backup malinki OK" "$PODSUM" ok ;; esac
  hc
  kuma_push up "OK, czas: ${CZAS}s"
  exit 0
fi
