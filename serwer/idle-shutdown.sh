#!/bin/bash
# /opt/jarvis/scripts/idle-shutdown.sh  (SERWER, cron roota CO MINUTE)
# Wylacza serwer po IDLE_MIN minutach bez ZADNEJ aktywnosci. W razie
# watpliwosci NIE wylacza.
#
# ZMIANA (2026-10-12):
#  - kazda aktywnosc odswieza znacznik $STAMP; serwer gasnie IDLE_MIN minut
#    po OSTATNIEJ aktywnosci (cron co minute => 15-16 min). Wczesniej liczylo
#    sie tylko n8n, a po wylogowaniu z SSH serwer mogl zgasnac od razu.
#  - swiezy start liczy sie jako aktywnosc (zastepuje dawne MIN_UPTIME=600),
#  - NOWE: polaczenia z uslugami w Dockerze z ostatnich ~2 min (Jellyfin, Nextcloud,
#    Paperless, *arr, WebUI qBittorrenta...) wykrywane przez conntrack — ruch
#    do kontenerow idzie przez DNAT i nie jest widoczny w zwyklym `ss`,
#  - NOWE: pobieranie w qBittorrencie (ruch przychodzacy na interfejsie VPN
#    w gluetun); samo seedowanie NIE trzyma serwera.
#  Diagnostyka: `cat /run/jarvis-last-activity` — czas i powod ostatniej
#  aktywnosci; wylaczenia: `journalctl -t jarvis-idle-shutdown`.
#  Wymaga: apt install conntrack

IDLE_MIN=15
LOCK=/run/jarvis-no-shutdown                # zakladany przez backup.sh i inne dlugie zadania
KILLSWITCH=/etc/jarvis-no-autoshutdown      # utworz ten plik, by calkowicie wylaczyc auto-off
STAMP=/run/jarvis-last-activity             # /run = tmpfs, znika przy kazdym starcie

# Porty opublikowane przez Dockera, ktore NIE oznaczaja uzytkownika:
#  2375 docker-socket-proxy (Uptime Kuma), 8000 sterowanie gluetun,
#  8888/8388 proxy gluetun (wylaczone), 32551 port torrentow, 61208 Glances (widget Homepage)
IGNORE_PORTS="2375 8000 8888 8388 32551 61208"
# Zrodla, ktore nie sa uzytkownikiem: sieci Dockera (np. Sonarr -> Jackett, n8n -> Ollama).
# 127.x CELOWO liczymy — tak wchodzi ruch z `tailscale serve` na serwerze.
IGNORE_SRC_REGEX='^172\.(1[6-9]|2[0-9]|3[01])\.'

GLUETUN=gluetun
DL_MIN_KB=2048                              # >2 MB pobrane przez VPN od ostatniego sprawdzenia = pobieranie
VPN_STATE=/run/jarvis-idle-vpn-rx

[ -f "$KILLSWITCH" ] && exit 0

NOW=$(date +%s)
BOOT=$(( NOW - $(awk '{print int($1)}' /proc/uptime) ))
[ -f "$STAMP" ] || { echo "start systemu" > "$STAMP"; touch -d "@$BOOT" "$STAMP"; }

aktywny() { echo "$(date '+%F %T') $1" > "$STAMP"; exit 0; }

# --- 1) Aktywnosc "na zywo" --------------------------------------------------
[ -f "$LOCK" ]       && aktywny "trwajace zadanie ($LOCK)"
who | grep -q .      && aktywny "sesja logowania"
ss -tnH state established '( sport = :22 )' 2>/dev/null | grep -q . && aktywny "polaczenie SSH"

UTIL=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d '[:space:]')
[ -n "$UTIL" ] && [ "$UTIL" -gt 10 ] && aktywny "GPU ${UTIL}%"

# --- 2) Polaczenia z uslugami w Dockerze (Jellyfin, Nextcloud, *arr...) ------
if command -v conntrack >/dev/null; then
  PORTY=$(docker ps --format '{{.Ports}}' 2>/dev/null | grep -oE ':[0-9]+->[0-9]+/tcp' \
          | sed -E 's/^:([0-9]+)->.*/\1/' | sort -un)
  for ig in $IGNORE_PORTS; do PORTY=$(printf '%s\n' $PORTY | grep -vx "$ig"); done
  if [ -n "$PORTY" ]; then
    # regex przez ENVIRON, nie -v (awk przetwarza w -v sekwencje "\." i psuje wzorzec)
    # BEZ filtra --state: zamkniete polaczenia wisza w conntrack jako TIME_WAIT
    # jeszcze ~2 min, wiec sprawdzanie co minute lapie KAZDE zapytanie HTTP
    # (Nextcloud/Paperless w przegladarce), nie tylko trwajace strumienie.
    HIT=$(conntrack -L -p tcp 2>/dev/null | IGN="$IGNORE_SRC_REGEX" awk -v porty=" $(echo $PORTY) " '
      BEGIN { ign = ENVIRON["IGN"] }
      { src=""; dport="";
        for (i=1;i<=NF;i++) {
          if (src=="" && $i ~ /^src=/)     src=substr($i,5)
          if (dport=="" && $i ~ /^dport=/) dport=substr($i,7)
        }
        if (src ~ ign) next
        if (index(porty, " " dport " ")) { print dport " z " src; exit }
      }')
    [ -n "$HIT" ] && aktywny "polaczenie z usluga: port $HIT"
  fi
fi

# --- 3) Pobieranie w qBittorrencie (ruch przychodzacy na VPN w gluetun) ------
PID=$(docker inspect -f '{{.State.Pid}}' "$GLUETUN" 2>/dev/null)
if [ -n "$PID" ] && [ "$PID" != 0 ] && [ -r "/proc/$PID/net/dev" ]; then
  RX=$(awk -F'[: ]+' '$2 ~ /^(tun0|wg0)$/ {print $3; exit}' "/proc/$PID/net/dev")
  if [ -n "$RX" ]; then
    PREV=$(cat "$VPN_STATE" 2>/dev/null)
    echo "$RX" > "$VPN_STATE"
    if [ -n "$PREV" ] && [ "$RX" -ge "$PREV" ] && [ $(( (RX - PREV) / 1024 )) -gt "$DL_MIN_KB" ]; then
      aktywny "pobieranie przez VPN ($(( (RX - PREV) / 1024 / 1024 )) MB/min)"
    fi
  fi
fi

# --- 4) Ostatnie wykonanie n8n. Brak odczytu -> dla bezpieczenstwa NIE wylaczaj
LAST_N8N=$(docker exec backend_postgres psql -U jarvis -d jarvis_db -tAc \
  "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(\"startedAt\")))::int, 999999) FROM execution_entity;" \
  2>/dev/null | tr -d '[:space:]')
[ -z "$LAST_N8N" ] && exit 0

# --- 5) Bezczynnosc = czas od najpozniejszej aktywnosci (znacznik albo n8n) --
OSTATNIA=$(stat -c %Y "$STAMP")
N8N_TS=$(( NOW - LAST_N8N ))
[ "$N8N_TS" -gt "$OSTATNIA" ] && OSTATNIA=$N8N_TS
BEZCZYNNY=$(( NOW - OSTATNIA ))
[ "$BEZCZYNNY" -lt $(( IDLE_MIN * 60 )) ] && exit 0

logger -t jarvis-idle-shutdown "bezczynny $((BEZCZYNNY / 60)) min (prog ${IDLE_MIN} min, ostatnio: $(cat "$STAMP")) -> poweroff"
/sbin/poweroff
