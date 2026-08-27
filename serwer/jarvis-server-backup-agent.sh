#!/usr/bin/env bash
# =============================================================================
#  SERWER — agent wyzwalania backupu (forced command dla klucza malinki)
# =============================================================================
#  Instalacja na SERWERZE:
#     sudo install -m 0755 jarvis-server-backup-agent.sh /usr/local/bin/jarvis-server-backup-agent.sh
#     sudo useradd -m -s /bin/bash bkptrigger
#     sudo install -d -m 0700 -o bkptrigger -g bkptrigger /home/bkptrigger/.ssh
#     # wklej klucz PUBLICZNY malinki do /home/bkptrigger/.ssh/authorized_keys
#     # w formacie z pliku authorized_keys-backup-trigger.example (obok tego skryptu)
#     echo 'bkptrigger ALL=(root) NOPASSWD: SETENV: /usr/local/bin/jarvis-server-backup-agent.sh' \
#        | sudo tee /etc/sudoers.d/jarvis-server-backup-trigger
#     sudo chmod 0440 /etc/sudoers.d/jarvis-server-backup-trigger
#     sudo visudo -c        # weryfikacja składni
#
#  DLACZEGO TO ISTNIEJE (2026-08-27):
#  Wcześniej `nightly-backup.sh` na malince łączył się jako root@serwer tym
#  samym kluczem, którego używa bot Discorda. Po SSH hardeningu
#  (PermitRootLogin no) to logowanie przestało działać. Zamiast robić wyjątek
#  na PermitRootLogin, backup dostaje WŁASNY, jednofunkcyjny klucz na koncie
#  bez roota — przez forced command potrafi WYŁĄCZNIE:
#     - odpowiedzieć "pong" (sprawdzenie łączności),
#     - uruchomić /opt/jarvis/scripts/backup.sh (przez sudo, bo backup
#       potrzebuje roota do pg_dump/docker exec) — i nic więcej.
#  Nie da się przez ten klucz dostać powłoki ani odpalić dowolnej komendy.
# =============================================================================
set -euo pipefail
export LC_ALL=C

LOGTAG="jarvis-server-backup-agent"
log() { logger -t "$LOGTAG" -- "$*"; }
die() { log "ODRZUCONO: $*"; printf 'jarvis-server-backup-agent: odrzucono (%s)\n' "$*" >&2; exit 42; }

# --- podniesienie uprawnień (klucz siedzi na userze 'bkptrigger', nie na roocie) ---
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n --preserve-env=SSH_ORIGINAL_COMMAND /usr/local/bin/jarvis-server-backup-agent.sh
fi

CMD="${SSH_ORIGINAL_COMMAND:-}"
[ -n "$CMD" ] || die "brak polecenia (powłoka interaktywna jest zablokowana)"
log "żądanie: ${CMD:0:200}"

case "$CMD" in
  ping)
    echo "pong $(hostname) $(date -Is)"
    ;;

  run)
    log "run: startuję /opt/jarvis/scripts/backup.sh"
    exec /opt/jarvis/scripts/backup.sh
    ;;

  *)
    die "polecenie spoza białej listy: ${CMD:0:120}"
    ;;
esac
