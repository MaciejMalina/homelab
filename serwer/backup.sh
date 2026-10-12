#!/usr/bin/env bash
# =============================================================================
#  SERWER — dzienny backup KONFIGURACJI obu node'ów JARVIS-a
#  /opt/jarvis/scripts/backup.sh
# =============================================================================
#  Wywoływany przez jarvis-server-backup-agent.sh ("run"), który wyzwala
#  malinka: ~/scripts/nightly-backup.sh z crona o 7:30. Alerty Discord/Kuma
#  wysyła agent na podstawie kodu wyjścia tego skryptu.
#
#  ZMIANA (2026-10-10): zastępuje backup-malinka.sh (obraz SSD malinki
#  w niedzielę ~200 min z zatrzymanym Dockerem/AdGuardem + codzienny rsync
#  całego rootfs + restic) i stary backup.sh usług serwera. Teraz JEDEN
#  codzienny backup samej konfiguracji, z którego da się postawić system
#  od zera skryptem jarvis-restore.sh:
#    - serwer:  /etc /root /home /opt/jarvis /usr/local/bin /usr/share/keyrings
#               crontaby, stan Tailscale, lista pakietów, metadane,
#               dumpy baz (Postgres n8n, Nextcloud, Vikunja, Paperless) + config n8n
#    - malinka: to samo + /opt (AdGuard, Kuma) + wolumeny Dockera + /boot/firmware/*.txt
#               (malinka NIE ma RAID-u — Trot/NPM/Homepage/mountain siedzą w /home)
#  CELOWO POMIJANE (dane serwera leżą na RAID1 /mnt/data): media, pliki
#  Nextcloud, oryginały Paperless, Qdrant, modele Ollamy, obrazy Dockera
#  (z rejestru = docker compose pull, lokalne = build ze źródeł z /home).
#
#  Wynik: /mnt/telemetry/backups/jarvis-config/<RRRR-MM-DD_GGMM>/
#    serwer-config.tar.gz  serwer-dpkg.txt  serwer-meta.txt
#    malinka-config.tar.gz malinka-meta.txt
#    db/*.sql.gz db/*.tar.gz
#    jarvis-restore.sh backup.sh STATUS
#  Retencja: 30 dni, ale zawsze zostaje min. 7 najnowszych katalogów.
# =============================================================================
set -uo pipefail
export LC_ALL=C

CONF=/etc/jarvis/backup-malinka.env      # PI_HOST / PI_USER / PI_KEY (+ webhook dla agenta)
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

PI_HOST="${PI_HOST:-malinka}"
PI_USER="${PI_USER:-bkp}"
PI_KEY="${PI_KEY:-/root/.ssh/jarvis_backup}"

BACKUP_ROOT=/mnt/telemetry/backups/jarvis-config
STAGING_PI=/mnt/telemetry/backups/staging/malinka   # lustro wybranych ścieżek malinki (rsync przyrostowy)
KEEP_DAYS="${RETENCJA_DNI:-30}"
KEEP_MIN=7
LOCK=/run/jarvis-no-shutdown                        # honorowany przez idle-shutdown.sh
LOGFILE=/var/log/jarvis-backup.log
RESTORE_SCRIPT=/opt/jarvis/scripts/jarvis-restore.sh

SSH_OPTS=(-i "$PI_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new
          -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
PI="$PI_USER@$PI_HOST"

# --- serwer: co wchodzi do archiwum (ścieżki względem /) ---------------------
SRV_PATHS=(etc root home opt/jarvis usr/local/bin usr/share/keyrings
           var/spool/cron/crontabs var/lib/tailscale)
SRV_EXCLUDES=(
  --exclude=opt/jarvis/ollama          # 1,6 GB, stara kopia — Ollama czyta z /mnt/data/ollama
  --exclude=home/macmal/utorent/data   # stary katalog danych sprzed przeniesienia na RAID, nieużywany
  --exclude=.cache --exclude=node_modules
)

# --- malinka: co ciągniemy (tylko odczyt, rsync --sender przez agenta 'bkp') --
PI_PATHS=(/etc /root /home /opt /usr/local/bin /usr/share/keyrings
          /var/spool/cron/crontabs /var/lib/docker/volumes /var/lib/tailscale
          /boot/firmware/config.txt /boot/firmware/cmdline.txt)
PI_EXCLUDES=(--exclude=.cache/ --exclude=node_modules/ --exclude=backingFsBlockDev)

# ----------------------------------------------------------------------------
TS=$(date +%F_%H%M)
DEST="$BACKUP_ROOT/$TS"
START_TS=$(date +%s)
FAILS=()

log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOGFILE"; }
ok()   { log "  OK   $*"; }
bad()  { FAILS+=("$*"); log "  BLAD $*"; }
pi()   { ssh "${SSH_OPTS[@]}" "$PI" "$@"; }

PI_FROZEN=0
sprzataj() {
  if [ "$PI_FROZEN" -eq 1 ]; then
    pi unfreeze-docker >/dev/null 2>&1 || log "UWAGA: nie udało się odpauzować kontenerów na malince — sprawdź RĘCZNIE (docker ps)"
  fi
  rm -f "$LOCK"
}
# flock PRZED trapem — inaczej drugi przebieg w trapie skasowałby lock idle-shutdown pierwszego
exec 9>/run/jarvis-backup.lock
flock -n 9 || { echo "Inny backup już trwa — kończę."; exit 0; }
trap sprzataj EXIT INT TERM

umask 077
mkdir -p "$DEST/db" "$STAGING_PI"
chmod 700 "$BACKUP_ROOT"
touch "$LOCK"
log "===== START backup konfiguracji -> $DEST ====="

# ============================================================================
#  1. SERWER — konfiguracja
# ============================================================================
srv_tar() {
  local rc
  tar -C / --numeric-owner --warning=no-file-changed --ignore-failed-read \
      "${SRV_EXCLUDES[@]}" -czf "$DEST/serwer-config.tar.gz" "${SRV_PATHS[@]}" 2>>"$LOGFILE"
  rc=$?
  # 1 = "plik zmienił się podczas czytania" — normalne na żywym systemie
  if [ "$rc" -le 1 ]; then ok "serwer-config.tar.gz ($(du -h "$DEST/serwer-config.tar.gz" | cut -f1))"
  else bad "tar konfiguracji serwera (kod $rc)"; fi
}

srv_meta() {
  dpkg --get-selections > "$DEST/serwer-dpkg.txt" 2>/dev/null || bad "lista pakietów serwera"
  {
    echo "### hostname";        hostname
    echo "### date";            date -Is
    echo "### os";              cat /etc/os-release
    echo "### kernel";          uname -a
    echo "### lsblk";           lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID
    echo "### fstab";           cat /etc/fstab
    echo "### mdstat";          cat /proc/mdstat
    echo "### mdadm";           mdadm --detail --scan 2>/dev/null || true
    echo "### df";              df -h
    echo "### docker";          docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
    echo "### docker-images";   docker image ls --digests --format '{{.Repository}}:{{.Tag}}\t{{.Digest}}'
    echo "### docker-mounts";   docker inspect --format '{{.Name}}{{range .Mounts}} | {{.Source}} -> {{.Destination}}{{end}}' $(docker ps -aq) 2>/dev/null
    echo "### compose-files";   find /opt/jarvis /home -maxdepth 4 -name 'docker-compose.y*ml' -not -path '*/ollama/*' 2>/dev/null
    echo "### crontab-root";    crontab -l 2>/dev/null || true
    echo "### timers";          systemctl list-timers --all --no-pager
    echo "### ip";              ip -o addr show
  } > "$DEST/serwer-meta.txt" 2>&1
  ok "serwer-meta.txt + serwer-dpkg.txt"
}

# ============================================================================
#  2. SERWER — bazy (dane same leżą na RAID1, dump = ochrona przed
#     skasowaniem/zepsuciem danych, czego RAID nie daje; to kilka MB)
# ============================================================================
dump() { # dump <plik> <komenda...>
  local plik="$1"; shift
  if "$@" | gzip > "$DEST/db/$plik" && [ -s "$DEST/db/$plik" ]; then
    ok "db/$plik ($(du -h "$DEST/db/$plik" | cut -f1))"
  else
    bad "db/$plik"
  fi
}
srv_db() {
  dump postgres_jarvis_db.sql.gz docker exec backend_postgres pg_dump -U jarvis -d jarvis_db
  # klucz szyfrujący n8n — bez niego credentiale z dumpa są bezużyteczne
  if tar -C /mnt/data -czf "$DEST/db/n8n_config.tar.gz" --exclude=n8n/binaryData n8n 2>>"$LOGFILE"; then
    ok "db/n8n_config.tar.gz"; else bad "db/n8n_config.tar.gz"; fi
  # MariaDB 11 nie ma już "mysqldump" (tylko mariadb-dump) — stary backup.sh przez to
  # po cichu (|| true) zapisywał PUSTY dump Nextcloud; bierzemy to, co jest w obrazie
  dump nextcloud_db.sql.gz docker exec nextcloud_db sh -c \
    'exec "$(command -v mariadb-dump || command -v mysqldump)" -uroot -p"${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" --single-transaction nextcloud'
  if tar -C /mnt/data/nextcloud/html -czf "$DEST/db/nextcloud_config.tar.gz" config 2>>"$LOGFILE"; then
    ok "db/nextcloud_config.tar.gz"; else bad "db/nextcloud_config.tar.gz"; fi
  if tar -C /mnt/data/vikunja -czf "$DEST/db/vikunja_db.tar.gz" db 2>>"$LOGFILE"; then
    ok "db/vikunja_db.tar.gz"; else bad "db/vikunja_db.tar.gz"; fi
  dump paperless_db.sql.gz docker exec paperless_db pg_dump -U paperless paperless
}

# ============================================================================
#  3. MALINKA — konfiguracja + małe dane usług
# ============================================================================
pi_rsync() { # pi_rsync <opis>
  local srcs=() p rc
  for p in "${PI_PATHS[@]}"; do srcs+=("$PI:$p"); done
  rsync -aHAX --relative --numeric-ids --delete --delete-excluded \
        "${PI_EXCLUDES[@]}" -e "ssh ${SSH_OPTS[*]}" \
        "${srcs[@]}" "$STAGING_PI/" >>"$LOGFILE" 2>&1
  rc=$?
  # 24 = pliki zniknęły w trakcie — normalne na żywym systemie
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 24 ]; then ok "rsync malinki: $1 (kod $rc)"; return 0; fi
  bad "rsync malinki: $1 (kod $rc, szczegóły w $LOGFILE)"; return 1
}

malinka() {
  local out
  out=$(pi ping 2>&1)
  if ! printf '%s' "$out" | grep -q '^pong'; then bad "brak łączności z malinką: $out"; return; fi

  # przebieg 1: hurt, kontenery działają
  pi_rsync "przebieg wstępny" || return
  # przebieg 2: na zapauzowanych kontenerach (SQLite Trota/Kumy/NPM spójne),
  # sama różnica — trwa sekundy, AdGuard stoi tylko przez ten czas
  if pi freeze-docker >/dev/null 2>&1; then
    PI_FROZEN=1
    pi_rsync "przebieg spójny (kontenery zapauzowane)"
    pi unfreeze-docker >/dev/null 2>&1 && PI_FROZEN=0 || bad "odpauzowanie kontenerów na malince — sprawdź RĘCZNIE"
  else
    bad "pauza kontenerów na malince — kopia SQLite może być niespójna"
  fi

  pi meta > "$DEST/malinka-meta.txt" 2>/dev/null && [ -s "$DEST/malinka-meta.txt" ] \
    && ok "malinka-meta.txt" || bad "metadane malinki"

  local rc
  tar -C "$STAGING_PI" --numeric-owner -czf "$DEST/malinka-config.tar.gz" . 2>>"$LOGFILE"; rc=$?
  if [ "$rc" -eq 0 ]; then ok "malinka-config.tar.gz ($(du -h "$DEST/malinka-config.tar.gz" | cut -f1))"
  else bad "tar konfiguracji malinki (kod $rc)"; fi
}

# ============================================================================
#  4. Retencja — 30 dni, ale zawsze min. 7 najnowszych
# ============================================================================
retencja() {
  local dirs i n=0
  mapfile -t dirs < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort -r)
  for i in "${!dirs[@]}"; do
    [ "$i" -lt "$KEEP_MIN" ] && continue
    if [ -n "$(find "$BACKUP_ROOT/${dirs[$i]}" -maxdepth 0 -mtime +"$KEEP_DAYS")" ]; then
      rm -rf "${BACKUP_ROOT:?}/${dirs[$i]}" && n=$((n+1))
    fi
  done
  ok "retencja: usunięto $n katalogów starszych niż $KEEP_DAYS dni (zajętość: $(du -sh "$BACKUP_ROOT" | cut -f1))"
}

# ============================================================================
srv_tar
srv_meta
srv_db
malinka

cp -f "$0" "$DEST/backup.sh" 2>/dev/null
if [ -f "$RESTORE_SCRIPT" ]; then cp -f "$RESTORE_SCRIPT" "$DEST/jarvis-restore.sh"
else bad "brak $RESTORE_SCRIPT — skopiuj go na serwer"; fi

CZAS=$(( $(date +%s) - START_TS ))
if [ "${#FAILS[@]}" -eq 0 ]; then
  echo "OK $(date -Is) ${CZAS}s" > "$DEST/STATUS"
else
  { echo "BLEDY $(date -Is) ${CZAS}s"; printf -- '- %s\n' "${FAILS[@]}"; } > "$DEST/STATUS"
fi
retencja

log "===== KONIEC — błędy: ${#FAILS[@]}, czas: ${CZAS}s, rozmiar: $(du -sh "$DEST" | cut -f1) ====="
if [ "${#FAILS[@]}" -gt 0 ]; then
  printf 'Błędy:\n'; printf -- '- %s\n' "${FAILS[@]}"
  exit 1
fi
exit 0
