#!/usr/bin/env bash
# =============================================================================
#  MALINKA — fail2ban (SEC-F2B z audytu)
#  Uruchom przez sudo TYLKO na malince.
# =============================================================================
#  Co robi:
#    - Instaluje fail2ban.
#    - Włącza jail 'sshd' (obronna warstwa nawet przy kluczach-only —
#      chroni przed skanowaniem/ewentualnym driftem konfiguracji sshd).
#    - Dodaje jail 'jarvis-npm': skanuje logi Nginx Proxy Managera
#      (/home/macmal/npm/data/logs/*.log) pod kątem powtarzających się
#      401/403 i banuje źródłowe IP. To chroni panel admina NPM (port 81)
#      i każdą aplikację za nim, która sygnalizuje błąd logowania kodem
#      401/403 w odpowiedzi.
#
#  WAŻNE OGRANICZENIE — przeczytaj:
#  Część aplikacji za NPM (typowe SPA: Nextcloud, Vikunja, Portainer, ...)
#  przy złym haśle zwraca 200 OK z błędem w treści JSON, nie 401/403 w
#  nagłówku HTTP. Taki fail2ban tego NIE złapie — to nie jest błąd tego
#  skryptu, tylko fundamentalne ograniczenie podejścia "czytaj log serwera
#  www". Realna, dodatkowa ochrona tych aplikacji to ich WŁASNE mechanizmy
#  (np. wbudowany brute-force protection w Nextcloud) — do sprawdzenia
#  osobno per aplikacja, jeśli chcesz iść dalej niż to.
#
#  WAŻNE — Docker i iptables:
#  fail2ban domyślnie banuje w łańcuchu INPUT, ale porty publikowane przez
#  Docker (80/443/81 dla NPM) idą przez FORWARD/DOCKER-USER, więc zwykły
#  ban w INPUT ich NIE zatrzyma. Dlatego jail 'jarvis-npm' używa
#  dedykowanej akcji wstawiającej DROP do łańcucha DOCKER-USER — to
#  jedyny łańcuch, który Docker gwarantuje sprawdzić PRZED własnymi
#  regułami przekierowania.
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Uruchom przez sudo." >&2; exit 1
fi

NPM_LOG_DIR=/home/macmal/npm/data/logs

echo "== Sprawdzam czy katalog logów NPM istnieje =="
if [ ! -d "$NPM_LOG_DIR" ]; then
  echo "STOP — nie widzę $NPM_LOG_DIR. Sprawdź ścieżkę w npm/docker-compose.yml" >&2
  echo "(wolumen './data:/data' jest względny do katalogu, z którego NPM jest" >&2
  echo "odpalany przez 'docker compose up' — zwykle /home/macmal/npm/data)." >&2
  exit 1
fi
echo "  OK: $NPM_LOG_DIR"

echo "== Instaluję fail2ban =="
apt-get update -qq
apt-get install -y fail2ban

echo "== Jail sshd (domyślny, tylko włączam) =="
install -d -m 0755 /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/jarvis-sshd.conf <<'EOF'
# Wygenerowane przez jarvis/malinka/setup-fail2ban.sh
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF

echo "== Akcja banująca w DOCKER-USER (zamiast domyślnego INPUT) =="
install -d -m 0755 /etc/fail2ban/action.d
cat > /etc/fail2ban/action.d/jarvis-docker-drop.conf <<'EOF'
# Wygenerowane przez jarvis/malinka/setup-fail2ban.sh
# Ban w łańcuchu DOCKER-USER — jedynym, który Docker sprawdza PRZED
# własnymi regułami NAT/FORWARD dla publikowanych portów kontenerów.
[Definition]
actionstart =
actionstop =
actioncheck = iptables -L DOCKER-USER -n >/dev/null
actionban   = iptables -I DOCKER-USER -s <ip> -j DROP
actionunban = iptables -D DOCKER-USER -s <ip> -j DROP
EOF

echo "== Filtr: powtarzające się 401/403 w logach NPM =="
cat > /etc/fail2ban/filter.d/jarvis-npm-401.conf <<'EOF'
# Wygenerowane przez jarvis/malinka/setup-fail2ban.sh
# Zakłada domyślny format logu Nginx Proxy Managera (combined).
[Definition]
failregex = ^<HOST> \S+ \S+ \[.*\] "(GET|POST|PUT|HEAD|OPTIONS|DELETE)\s+\S+\s+HTTP/\d(\.\d)?" (401|403) 
ignoreregex =
EOF

echo "== Jail jarvis-npm =="
cat > /etc/fail2ban/jail.d/jarvis-npm.conf <<EOF
# Wygenerowane przez jarvis/malinka/setup-fail2ban.sh
[jarvis-npm]
enabled  = true
filter   = jarvis-npm-401
logpath  = $NPM_LOG_DIR/*.log
maxretry = 8
findtime = 10m
bantime  = 1h
action   = jarvis-docker-drop
EOF

echo "== Test składni filtra na istniejących logach (informacyjnie) =="
fail2ban-regex "$NPM_LOG_DIR"/*.log /etc/fail2ban/filter.d/jarvis-npm-401.conf 2>&1 | tail -20 || true

echo "== Restart fail2ban =="
systemctl enable --now fail2ban
systemctl restart fail2ban

echo
echo "== GOTOWE =="
echo "Status jaili:"
fail2ban-client status
echo
echo "Szczegóły jarvis-npm:"
fail2ban-client status jarvis-npm || true
echo
echo "Ręczny test banowania (podstaw dowolne IP testowe, NIE swoje!):"
echo "    sudo fail2ban-client set jarvis-npm banip 203.0.113.99"
echo "    sudo iptables -L DOCKER-USER -n | grep 203.0.113.99   # powinno pokazać DROP"
echo "    sudo fail2ban-client set jarvis-npm unbanip 203.0.113.99"
