#!/bin/bash
# ~/scripts/nightly-backup.sh  (uruchamiane na MALINCE z crona o 7:30)
# Budzi serwer (WoL), wywoluje przypomnienia CRM w n8n i odpala backup
# konfiguracji OBU node'ow PO STRONIE SERWERA (/opt/jarvis/scripts/backup.sh,
# wynik na /mnt/telemetry/backups/jarvis-config). Kopie trzymane sa na serwerze.
#
# ZMIANA (2026-10-10): 7:00 -> 7:30; to jedyne planowe budzenie serwera
# (wpisy WoL 21:45 i 03:00 w crontabie roota usuniete, timery
# jarvis-backup-malinka* na serwerze wylaczone). Przypomnienia CRM ida
# zaraz po starcie n8n, PRZED backupem i niezaleznie od jego wyniku.
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

SERVER_IP=192.168.254.11
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
# ZMIANA (2026-10-18): jeden pakiet WoL potrafil przepasc (18.10 serwer nie wstal,
# a skrypt i tak czekal na n8n i SSH). Teraz pakiet idzie co ~15 s przez 4 min,
# na broadcast ogolny i podsieci, a brak pingu konczy skrypt od razu z alertem.
wol() {
  wakeonlan "$SERVER_MAC" >/dev/null 2>&1
  wakeonlan -i 192.168.254.255 "$SERVER_MAC" >/dev/null 2>&1
  command -v etherwake >/dev/null && sudo -n etherwake -b "$SERVER_MAC" 2>/dev/null
  return 0
}
if ! ping -c1 -W2 "$SERVER_IP" >/dev/null 2>&1; then
  log "Serwer spi - wysylam WoL"
  for i in $(seq 1 48); do          # do ~4 min, pakiet WoL co 3. obieg (~15 s)
    [ $(( (i - 1) % 3 )) -eq 0 ] && wol
    ping -c1 -W2 "$SERVER_IP" >/dev/null 2>&1 && { log "Serwer odpowiada na ping (po ~$(( i * 5 )) s)"; break; }
    sleep 3
  done
  if ! ping -c1 -W2 "$SERVER_IP" >/dev/null 2>&1; then
    log "BLAD: serwer nie wstal po WoL (brak pingu przez ~4 min)"
    powiadom "JARVIS: serwer NIE WSTAL (WoL)" \
      "Malinka wysylala Wake-on-LAN przez ~4 min, serwer nie odpowiedzial na ping. Poranny brief i backup dzis SIE NIE ODBYLY. Sprawdz zasilanie serwera / wlacz go recznie." err
    kuma_push down "serwer nie wstal po WoL"
    exit 1
  fi
fi

# 2) Przypomnienia CRM (n8n webhook /reminders) — gdy tylko n8n wstanie
for i in $(seq 1 36); do           # do ~3 min na start n8n
  curl -fsS -m 5 -o /dev/null "http://$SERVER_IP:5678/healthz" 2>/dev/null && break
  sleep 5
done
# ZMIANA (2026-10-17): /healthz moze odpowiedziec, zanim n8n zarejestruje webhooki aktywnych
# workflow (mozliwe 404), a pojedynczy POST z bledem przepadal po cichu.
# Teraz: do 6 prob co 20 s, kod HTTP w logu, a po porazce alert na Discord.
log "Wywoluje przypomnienia (n8n webhook /reminders)"
BRIEF_OK=0
for i in $(seq 1 6); do
  KOD=$(curl -sS -m 60 -o /dev/null -w '%{http_code}' -X POST "http://$SERVER_IP:5678/webhook/reminders" 2>/dev/null)
  if [ "$KOD" = "200" ]; then BRIEF_OK=1; log "Brief: HTTP 200 (proba $i)"; break; fi
  log "Brief: HTTP ${KOD:-brak} (proba $i/6) - ponawiam za 20 s"
  sleep 20
done
[ "$BRIEF_OK" = 1 ] || powiadom "JARVIS: poranny brief NIE WYSTARTOWAL" \
  "Webhook /reminders w n8n nie odpowiedzial HTTP 200 po 6 probach (ostatni kod: ${KOD:-brak}). Sprawdz, czy workflow 'JARVIS - Poranny brief' jest opublikowany (aktywny)." err

# 3) Czekaj na SSH (agent odpowiada "pong ...")
for i in $(seq 1 24); do
  ssh $SSH_OPTS "$REMOTE" ping 2>/dev/null | grep -q '^pong' && break
  sleep 5
done
if ! ssh $SSH_OPTS "$REMOTE" ping 2>/dev/null | grep -q '^pong'; then
  # Diagnostyka (2026-09-07): powyzsza petla celowo tlumi stderr (normalne
  # bledy polaczenia podczas budzenia serwera), ale to ukrywalo realna
  # przyczyne raz - serwer byl gore i SSH dzialalo, ale forced-command na
  # koncie bkptrigger nie mial bitu +x (permission denied), wygladalo
  # identycznie jak "serwer nie wstal". Ta jedna dodatkowa proba pokazuje
  # realny stderr, zeby powiadomienie mowilo co NAPRAWDE poszlo nie tak.
  DIAG=$(ssh $SSH_OPTS "$REMOTE" ping 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-300)
  log "BLAD: brak SSH do serwera (diagnostyka: ${DIAG:-brak outputu})"
  powiadom "JARVIS: nocny backup NIE WYSTARTOWAL" \
    "Serwer nie obudzil sie / nie odpowiedzial po SSH w wyznaczonym czasie (WoL + ok. 5 min oczekiwania). Backup serwera dzis SIE NIE ODBYL.

Ostatnia proba polaczenia (stderr): ${DIAG:-brak outputu (prawdopodobnie realny brak lacznosci, nie blad uprawnien)}" \
    err
  kuma_push down "brak SSH: ${DIAG:-brak outputu}"
  exit 1
fi

# 4) Uruchom backup konfiguracji na serwerze (wynik i alerty: agent na serwerze)
log "Uruchamiam backup na serwerze"
ssh $SSH_OPTS "$REMOTE" run

kuma_push up "obudzono serwer, backup zlecony"
log "Gotowe. Serwer zostanie uspiony przez idle-shutdown gdy bezczynny."
