#!/bin/bash
# JARVIS — instalacja cotygodniowych aktualizacji kontenerów + raportu zdrowia (common/jarvis-zdrowie.py).
#   sudo bash instaluj-zdrowie.sh malinka   -> sobota 9:55 WoL serwera (przez panel), 10:00 skrypt
#   sudo bash instaluj-zdrowie.sh serwer    -> sobota 10:05 skrypt (serwer obudzony przez malinkę)
# Skrypt leży obok tego pliku. Log: /var/log/jarvis-zdrowie.log. Test bez zmian: sudo jarvis-zdrowie.py --sprawdz
set -euo pipefail
ROLA="${1:-}"
[ "$ROLA" = malinka ] || [ "$ROLA" = serwer ] || { echo "użycie: sudo bash $0 malinka|serwer"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "uruchom przez sudo"; exit 1; }

install -m 755 "$(dirname "$0")/jarvis-zdrowie.py" /usr/local/bin/jarvis-zdrowie.py
command -v smartctl >/dev/null || command -v /usr/sbin/smartctl >/dev/null || apt-get install -y smartmontools >/dev/null
touch /var/log/jarvis-zdrowie.log

if [ "$ROLA" = malinka ]; then
  cat > /etc/cron.d/jarvis-zdrowie <<'EOF'
# JARVIS (common/instaluj-zdrowie.sh): sobota 9:55 budzi serwer przez panel (WoL), 10:00 aktualizacje + raport zdrowia
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
55 9 * * 6 root curl -s -m 15 -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8084/api/serwer/wake >/dev/null 2>&1
0 10 * * 6 root /usr/bin/python3 /usr/local/bin/jarvis-zdrowie.py >/dev/null 2>&1
EOF
else
  cat > /etc/cron.d/jarvis-zdrowie <<'EOF'
# JARVIS (common/instaluj-zdrowie.sh): sobota 10:05 aktualizacje + raport zdrowia (serwer budzi malinka o 9:55)
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
5 10 * * 6 root /usr/bin/python3 /usr/local/bin/jarvis-zdrowie.py >/dev/null 2>&1
EOF
fi
chmod 644 /etc/cron.d/jarvis-zdrowie
echo "Zainstalowane ($ROLA): /usr/local/bin/jarvis-zdrowie.py + /etc/cron.d/jarvis-zdrowie"
