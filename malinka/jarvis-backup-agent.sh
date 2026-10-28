#!/usr/bin/env bash
# =============================================================================
#  MALINKA — agent backupu (forced command dla klucza serwera)
# =============================================================================
#  Instalacja na MALINCE:
#     sudo install -m 0755 jarvis-backup-agent.sh /usr/local/bin/jarvis-backup-agent.sh
#     sudo useradd -m -s /bin/bash bkp
#     sudo install -d -m 0700 -o bkp -g bkp /home/bkp/.ssh
#     # wklej klucz PUBLICZNY serwera do /home/bkp/.ssh/authorized_keys w formacie
#     # z pliku authorized_keys.example (obok tego skryptu)
#     echo 'bkp ALL=(root) NOPASSWD: SETENV: /usr/local/bin/jarvis-backup-agent.sh' \
#        | sudo tee /etc/sudoers.d/jarvis-backup
#     sudo chmod 0440 /etc/sudoers.d/jarvis-backup
#     sudo visudo -c        # weryfikacja składni
#
#  MODEL BEZPIECZEŃSTWA (świadomy wybór — patrz audyt P1):
#  Backup jest CIĄGNIONY przez serwer, a nie PCHANY przez malinkę. Dzięki temu
#  malinka nie ma żadnego klucza zapisu do repozytorium kopii — jej przejęcie
#  nie pozwala skasować backupów. Klucz serwera trafia tu na konto 'bkp',
#  które przez forced command potrafi wyłącznie:
#     - oddać dane przez rsync w trybie --sender (TYLKO ODCZYT, zero zapisu),
#     - zatrzymać/wznowić Dockera na czas robienia obrazu,
#     - wystawić strumień obrazu nośnika,
#     - zwrócić metadane systemu.
#  Nie da się przez ten klucz dostać powłoki ani nic nadpisać.
# =============================================================================
set -euo pipefail
export LC_ALL=C

LOGTAG="jarvis-backup-agent"
log() { logger -t "$LOGTAG" -- "$*"; }
die() { log "ODRZUCONO: $*"; printf 'jarvis-backup-agent: odrzucono (%s)\n' "$*" >&2; exit 42; }

# --- podniesienie uprawnień (klucz siedzi na userze 'bkp', nie na roocie) -----
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n --preserve-env=SSH_ORIGINAL_COMMAND /usr/local/bin/jarvis-backup-agent.sh
fi

CMD="${SSH_ORIGINAL_COMMAND:-}"
[ -n "$CMD" ] || die "brak polecenia (powłoka interaktywna jest zablokowana)"
log "żądanie: ${CMD:0:200}"

# Które usługi zatrzymać na czas robienia obrazu nośnika
QUIESCE_SERVICES="docker.socket docker containerd"

# --- 1. rsync w trybie wyłącznie wysyłającym --------------------------------
case "$CMD" in
  "rsync --server --sender "*)
    # --sender = rsync tylko czyta i wysyła. Nie ma fizycznej możliwości zapisu.
    log "rsync (sender) OK"
    exec /usr/bin/rsync ${CMD#rsync }
    ;;
  "rsync --server"*)
    die "rsync bez --sender oznaczałby ZAPIS na malinkę"
    ;;
esac

# --- 2. pozostałe dozwolone polecenia ---------------------------------------
case "$CMD" in

  image-device)
    # Zwraca urządzenie blokowe, na którym stoi root (np. /dev/sda)
    SRC=$(findmnt -no SOURCE /)
    PK=$(lsblk -no PKNAME "$SRC" | head -1)
    echo "/dev/$PK"
    ;;

  image-size)
    # Rozmiar w bajtach do końca ostatniej partycji (nie dumpujemy pustego ogona)
    SRC=$(findmnt -no SOURCE /)
    PK=$(lsblk -no PKNAME "$SRC" | head -1)
    DEV="/dev/$PK"
    SS=$(blockdev --getss "$DEV")
    LAST=$(sfdisk -l -o End "$DEV" 2>/dev/null | grep -E '^\s*[0-9]+' | awk '{print $1}' | sort -n | tail -1)
    echo $(( (LAST + 1) * SS ))
    ;;

  image-begin)
    # Wyciszenie zapisów przed obrazem: stop Dockera, flush cache
    log "image-begin: zatrzymuję $QUIESCE_SERVICES"
    for s in $QUIESCE_SERVICES; do systemctl stop "$s" 2>/dev/null || true; done
    sleep 3
    sync; sync
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
    echo "quiesced"
    ;;

  image-stream)
    # Surowy strumień obrazu na stdout (serwer kompresuje po swojej stronie)
    SRC=$(findmnt -no SOURCE /)
    PK=$(lsblk -no PKNAME "$SRC" | head -1)
    DEV="/dev/$PK"
    SS=$(blockdev --getss "$DEV")
    LAST=$(sfdisk -l -o End "$DEV" 2>/dev/null | grep -E '^\s*[0-9]+' | awk '{print $1}' | sort -n | tail -1)
    BYTES=$(( (LAST + 1) * SS ))
    log "image-stream: $DEV, $BYTES bajtów"
    dd if="$DEV" bs=4M count=$(( (BYTES + 4194303) / 4194304 )) status=none
    ;;

  image-end)
    log "image-end: wznawiam $QUIESCE_SERVICES"
    systemctl start docker 2>/dev/null || true
    echo "resumed"
    ;;

  meta)
    # Metadane potrzebne przy odtwarzaniu — tanie, a ratują życie
    echo "### hostname";      hostname
    echo "### date";          date -Is
    echo "### os";            cat /etc/os-release
    echo "### kernel";        uname -a
    echo "### lsblk";         lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID,PARTUUID
    echo "### fstab";         cat /etc/fstab
    echo "### cmdline";       cat /boot/firmware/cmdline.txt 2>/dev/null || cat /boot/cmdline.txt 2>/dev/null || true
    echo "### dpkg";          dpkg --get-selections
    echo "### docker";        docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || true
    echo "### docker-volumes"; docker volume ls 2>/dev/null || true
    echo "### crontab-root";  crontab -l 2>/dev/null || true
    echo "### timers";        systemctl list-timers --all --no-pager 2>/dev/null || true
    echo "### ip";            ip -o addr show
    ;;

  freeze-docker)
    # Pauza kontenerów na czas rsynca wolumenów.
    # ZMIANA (2026-10-28): pojedynczo i tylko "running". Wcześniej `docker ps -q | xargs docker pause`
    # + set -e: jeden kontener, którego nie dało się zapauzować (np. w trakcie restartu), przerywał
    # skrypt kodem błędu PO zapauzowaniu reszty -> backup.sh uznawał, że pauzy nie było, i nie
    # odpauzowywał. Efekt 28.10: wszystkie kontenery (z AdGuardem) stały do ręcznego unpause.
    BLEDY=0
    for c in $(docker ps -q --filter status=running); do
      docker pause "$c" >/dev/null 2>&1 || { BLEDY=$((BLEDY + 1)); log "freeze: nie zapauzowano $(docker inspect -f '{{.Name}}' "$c" 2>/dev/null)"; }
    done
    echo "paused (bledy: $BLEDY)"
    ;;

  unfreeze-docker)
    BLEDY=0
    for c in $(docker ps -q --filter status=paused); do
      docker unpause "$c" >/dev/null 2>&1 || { BLEDY=$((BLEDY + 1)); log "unfreeze: nie odpauzowano $(docker inspect -f '{{.Name}}' "$c" 2>/dev/null)"; }
    done
    [ "$BLEDY" -eq 0 ] || { echo "unpaused (bledy: $BLEDY)"; exit 1; }
    echo "unpaused"
    ;;

  ping)
    echo "pong $(hostname) $(date -Is)"
    ;;

  *)
    die "polecenie spoza białej listy: ${CMD:0:120}"
    ;;
esac
