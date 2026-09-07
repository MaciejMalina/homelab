#!/bin/bash
# ~/scripts/nightly-backup.sh  (uruchamiane na MALINCE z crona o 7:00)
# Budzi serwer (WoL) i odpala backup PO STRONIE SERWERA (zrzut na RAID /mnt/data).
# Kopie trzymane sa wylacznie na serwerze.
#
# ZMIANA (2026-08-27): logowanie jako root@serwer kluczem bota Discorda
# przestalo dzialac po SSH hardeningu (PermitRootLogin no). Teraz laczymy sie
# jako bkptrigger@serwer dedykowanym kluczem, ktory przez forced command
# potrafi wylacznie odpowiedziec "pong" albo uruchomic backup.sh - patrz
# serwer/jarvis-server-backup-agent.sh w paczce.
#
# ZMIANA (2026-09-07): dodano powiadomienia. Do tej pory blad budzenia serwera
# (WoL/SSH timeout) konczyl sie CICHYM exit 1 - dalszy kod z Discordem/Kuma
# siedzi w jarvis-server-backup-agent.sh na serwerze, ktory w tej sciezce
# w ogole sie nie uruchamial. Config: /etc/jarvis/nightly-backup.env
# (DISCORD_WEBHOOK=..., KUMA_PUSH_NIGHTLY_URL=... - nowy osobny monitor
# w Uptime Kumie, np. "Backup: budzenie serwera", bo to inny etap niz
# istniejace 3 monitory).

SERVER_IP=192.168.1.162
SERVER_MAC=4c:cc:6a:4a:33:6d
SSH_KEY=/home/macmal/.ssh/jarvis-server-backup-trigger    # dedykowany klucz, TYLKO do tego
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i $SSH_KEY"
REMOTE=bkptrigger@$SERVER_IP

log(){ echo "[$(date '+%F %T')] $*"; }

# --- powiadomienia (ten sam wzorzec co serwer/jarvis-server-backup-agent.sh) --
CONF_NOTIFY=/etc/jarvis/nightly-backup.env
DISCORD_WEBHOOK=""
KUMA_PUSH_NIGHTLY_URL=""
if [ -f "$CONF_NOTIFY" ]; then
  DISCORD_WEBHOOK=$(grep -m1 '^DISCORD_WEBHOOK=' "$CONF_NOTIFY" 2>/dev/null | cut -d= -f2- || true)
  KUMA_PUSH_NIGHTLY_URL=$(grep -m1 '^KUMA_PUSH_NIGHTLY_URL=' "$CONF_NOTIFY" 2>/dev/null | cut -d= -f2- || true)
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
  [ -n "$KUMA_PUSH_NIGHTLY_URL" ] || return 0
  curl -fsS -m 10 -G "$KUMA_PUSH_NIGHTLY_URL" --data-urlencode "status=$1" --data-urlencode "msg=$2" \
    >/dev/null 2>&1 || true
}

# 1) Obudz serwer jesli spi
if ! ping -c1 -W2 "$SERVER_IP" >/dev/null 2>&1; then
  log "Serwer spi - wysylam WoL"
  wakeonlan "$SERVER_MAC" >/dev/null 2>&1 || etherwake "$SERVER_MAC" 2>/dev/null
  for i in $(seq 1 36); do          # czekaj do ~3 min na ping
    ping -c1 -W2 "$SERVER_IP" >/dev/null 2>&1 && break
    sleep 5
  done
fi

# 2) Czekaj na SSH (agent odpowiada "pong ...")
for i in $(seq 1 24); do
  ssh $SSH_OPTS "$REMOTE" ping 2>/dev/null | grep -q '^pong' && break
  sleep 5
done
if ! ssh $SSH_OPTS "$REMOTE" ping 2>/dev/null | grep -q '^pong'; then
  log "BLAD: brak SSH do serwera"
  powiadom "JARVIS: nocny backup NIE WYSTARTOWAL" \
    "Serwer nie obudzil sie / nie odpowiedzial po SSH w wyznaczonym czasie (WoL + ok. 5 min oczekiwania). Backup serwera dzis SIE NIE ODBYL." \
    err
  kuma_push down "brak SSH do serwera po WoL"
  exit 1
fi

# 3) Uruchom backup na serwerze (zrzut na RAID)
log "Uruchamiam backup na serwerze"
ssh $SSH_OPTS "$REMOTE" run

# 4) Po backupie: odpal przypomnienia CRM (serwer juz czuwa)
log "Wywoluje przypomnienia (n8n webhook /reminders)"
curl -s -m 60 -X POST "http://$SERVER_IP:5678/webhook/reminders" >/dev/null 2>&1 || true

kuma_push up "obudzono serwer, backup zlecony"
log "Gotowe. Serwer zostanie uspiony przez idle-shutdown gdy bezczynny."
