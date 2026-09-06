#!/usr/bin/env bash
# =============================================================================
#  WSPÓLNE — smartmontools + smartd (malinka + serwer)
#  Uruchom przez sudo NA KAŻDEJ z dwóch maszyn.
# =============================================================================
#  Co robi:
#    - instaluje smartmontools
#    - włącza smartd z krótkim testem codziennie, długim raz w tygodniu
#    - alert na Discord webhook przy problemie (ten sam webhook co backup —
#      podaj go jako pierwszy argument albo w zmiennej DISCORD_WEBHOOK)
#    - NA MALINCE (dysk po USB): dopisuje `-d sat` jeśli mostek nie ujawnia
#      SMART inaczej — patrz uwaga niżej po instalacji SSD
#
#  Użycie:
#    sudo DISCORD_WEBHOOK='https://discord.com/api/webhooks/...' ./setup-smartmontools.sh
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Uruchom przez sudo." >&2; exit 1
fi

WEBHOOK="${DISCORD_WEBHOOK:-${1:-}}"

echo "== Instaluję smartmontools =="
apt-get update -qq
apt-get install -y smartmontools

echo "== Wykryte dyski =="
lsblk -d -o NAME,SIZE,TYPE,MODEL | grep -v loop || true

echo
echo "== Test odczytu SMART na każdym dysku (informacyjnie) =="
for dev in $(lsblk -dn -o NAME,TYPE | awk '$2=="disk"{print $1}'); do
  echo "--- /dev/$dev ---"
  smartctl -i "/dev/$dev" 2>&1 | grep -E 'SMART support|Model' || true
  if ! smartctl -H "/dev/$dev" >/dev/null 2>&1; then
    echo "  [!] smartctl -H nie zwrócił statusu — spróbuj: smartctl -d sat -H /dev/$dev"
    echo "      (typowe dla dysków za mostkiem USB, który nie przepuszcza SMART bez -d sat)"
  fi
done

echo
echo "== Konfiguruję smartd (/etc/smartd.conf) =="
cat > /etc/smartd.conf <<'EOF'
# Wygenerowane przez jarvis/common/setup-smartmontools.sh
# DEVICESCAN = monitoruj wszystkie wykryte dyski automatycznie.
#   -a               = wszystkie testy/atrybuty
#   -o on -S on      = włącz offline testing + attribute autosave
#   -s (S/../.././02)(L/../../6/03) = krótki test codziennie o 02:00,
#                                      długi w sobotę (dzień 6) o 03:00
#   -W 4,45,55       = alert przy zmianie temp >=4st, warn 45C, crit 55C
#   -m root -M exec  = przy problemie odpal skrypt alertujący zamiast maila
DEVICESCAN -a -o on -S on -s (S/../.././02)(L/../../6/03) -W 4,45,55 -m root -M exec /usr/local/bin/jarvis-smart-alert.sh
EOF

echo "== Instaluję skrypt alertu (Discord webhook) =="
cat > /usr/local/bin/jarvis-smart-alert.sh <<EOF
#!/usr/bin/env bash
# Wywoływane przez smartd (patrz /etc/smartd.conf) przy każdym problemie SMART.
# smartd przekazuje info w zmiennych SMARTD_* i stdin.
WEBHOOK="${WEBHOOK}"
MSG="⚠️ SMART alert on \$(hostname): \${SMARTD_MESSAGE:-\$(cat)} (device \${SMARTD_DEVICE:-?})"
if [ -n "\$WEBHOOK" ]; then
  curl -fsS -m 15 -H 'Content-Type: application/json' -X POST "\$WEBHOOK" \\
    -d "{\\"content\\": \\"\$(printf '%s' "\$MSG" | sed 's/"/\\\\"/g')\\"}" >/dev/null 2>&1 || true
fi
logger -t jarvis-smart-alert -- "\$MSG"
EOF
chmod 0755 /usr/local/bin/jarvis-smart-alert.sh

if [ -z "$WEBHOOK" ]; then
  echo "  [!] Nie podano DISCORD_WEBHOOK — alert i tak trafi do syslog (logger),"
  echo "      ale nie wyśle się na Discord. Dopisz go później w"
  echo "      /usr/local/bin/jarvis-smart-alert.sh (zmienna WEBHOOK)."
fi

echo "== Włączam i startuję smartd =="
# (poprawione 2026-09-06) Nazwa jednostki systemd dla smartd różni się między
# dystrybucjami/wersjami: bywa "smartd.service" albo "smartmontools.service"
# (to drugie widziane na Raspberry Pi OS / Debian trixie). Wykryj co faktycznie
# jest dostępne zamiast zakładać jedną nazwę na sztywno.
SMARTD_UNIT=""
for u in smartd smartmontools; do
  if systemctl list-unit-files "${u}.service" 2>/dev/null | grep -q "^${u}\.service"; then
    SMARTD_UNIT="$u"
    break
  fi
done
if [ -z "$SMARTD_UNIT" ]; then
  echo "  [!] Nie znalazłem ani smartd.service, ani smartmontools.service — sprawdź ręcznie:"
  echo "      systemctl list-unit-files | grep -i smart"
  SMARTD_UNIT="smartd"   # zgadywanie, żeby reszta skryptu nie wywaliła się na pusty string
fi
systemctl enable --now "$SMARTD_UNIT"
systemctl restart "$SMARTD_UNIT"

echo
echo "== GOTOWE =="
systemctl is-active "$SMARTD_UNIT"
echo "Test alertu (wyśle testową wiadomość na webhook, jeśli podany):"
echo "  sudo smartctl -t short /dev/sdX   # ręczny test krótki, sprawdź wynik po ~2 min: smartctl -a /dev/sdX"
echo
echo "Podgląd stanu wszystkich dysków w dowolnej chwili:"
echo "  for d in \$(lsblk -dn -o NAME,TYPE | awk '\$2==\"disk\"{print \$1}'); do echo \"== /dev/\$d ==\"; sudo smartctl -H -A /dev/\$d; done"
