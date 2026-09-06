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

    # --- powiadomienie Discord: sukces/porazka backupu serwera (weryfikacja) ---
    # (dodane 2026-08-31) Webhook czytany z tego samego configu co backup
    # malinki (/etc/jarvis/backup-malinka.env) — jeden sekret, dwa skrypty.
    CONF_NOTIFY=/etc/jarvis/backup-malinka.env
    DISCORD_WEBHOOK=""
    KUMA_PUSH_URL=""   # (dodane 2026-09-06) monitor "Backup serwera (nightly)" w Uptime Kumie
    if [ -f "$CONF_NOTIFY" ]; then
      DISCORD_WEBHOOK=$(grep -m1 '^DISCORD_WEBHOOK=' "$CONF_NOTIFY" 2>/dev/null | cut -d= -f2- || true)
      KUMA_PUSH_URL=$(grep -m1 '^KUMA_PUSH_SERVER_URL=' "$CONF_NOTIFY" 2>/dev/null | cut -d= -f2- || true)
    fi

    jsonstr() { # jsonstr <tekst> -> bezpieczny string JSON
      local s="$1"
      s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/\\t}; s=${s//$'\r'/}; s=${s//$'\n'/\\n}
      printf '"%s"' "${s:0:3900}"
    }
    powiadom() { # powiadom <tytul> <tresc> <ok|err>
      local tytul="$1" tresc="$2" typ="${3:-ok}" kolor
      [ "$typ" = err ] && kolor=15158332 || kolor=3066993
      [ -n "$DISCORD_WEBHOOK" ] || return 0
      curl -fsS -m 15 -H 'Content-Type: application/json' -X POST "$DISCORD_WEBHOOK" \
        -d "{\"embeds\":[{\"title\":$(jsonstr "$tytul"),\"description\":$(jsonstr "$tresc"),\"color\":$kolor}]}" \
        >/dev/null 2>&1 || true
    }
    kuma_push() { # kuma_push <up|down> <komunikat> — dead man's switch w Uptime Kumie
      [ -n "$KUMA_PUSH_URL" ] || return 0
      curl -fsS -m 10 -G "$KUMA_PUSH_URL" --data-urlencode "status=$1" --data-urlencode "msg=$2" \
        >/dev/null 2>&1 || true
    }

    START_TS=$(date +%s)
    RC=0
    /opt/jarvis/scripts/backup.sh || RC=$?
    CZAS=$(( $(date +%s) - START_TS ))
    PODSUM="Czas: $((CZAS/60)) min $((CZAS%60)) s"

    if [ "$RC" -eq 0 ]; then
      log "run: backup.sh zakonczony OK (${CZAS}s)"
      powiadom "JARVIS: backup serwera OK" "$PODSUM" ok
      kuma_push up "OK, czas: ${CZAS}s"
    else
      log "run: backup.sh zakonczony BLEDEM (kod $RC, ${CZAS}s)"
      powiadom "JARVIS: backup serwera NIE POWIODL SIE" "$PODSUM
Kod wyjscia: $RC" err
      kuma_push down "kod: $RC, czas: ${CZAS}s"
    fi
    exit "$RC"
    ;;

  *)
    die "polecenie spoza białej listy: ${CMD:0:120}"
    ;;
esac
