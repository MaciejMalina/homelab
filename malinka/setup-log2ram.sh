#!/usr/bin/env bash
# =============================================================================
#  MALINKA — log2ram (logi w RAM, zrzut na dysk raz dziennie)
#  Uruchom przez sudo TYLKO na malince.
# =============================================================================
#  Treść przeniesiona 1:1 z docs/JARVIS-storage-i-roadmapa.md, tylko jako
#  gotowy do odpalenia skrypt zamiast wklejania linii ręcznie.
#  UWAGA: na końcu wymagany reboot (log2ram montuje tmpfs nad /var/log
#  dopiero po restarcie).
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Uruchom przez sudo." >&2; exit 1
fi

echo "== Dodaję repozytorium azlux =="
install -d -m 0755 /usr/share/keyrings
if [ ! -f /usr/share/keyrings/azlux.gpg ]; then
  wget -qO /usr/share/keyrings/azlux.gpg https://azlux.fr/repo.gpg
fi
echo "deb [signed-by=/usr/share/keyrings/azlux.gpg] http://packages.azlux.fr/debian/ stable main" \
  > /etc/apt/sources.list.d/azlux.list

echo "== Instaluję log2ram =="
apt-get update -qq
apt-get install -y log2ram

echo "== Konfiguruję /etc/log2ram.conf (SIZE=128M, MAIL=false) =="
sed -i 's/^SIZE=.*/SIZE=128M/' /etc/log2ram.conf
sed -i 's/^MAIL=.*/MAIL=false/' /etc/log2ram.conf
grep -E '^(SIZE|MAIL)=' /etc/log2ram.conf

echo
echo "== Ograniczam journald (domyślnie potrafi zająć 4 GB) =="
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/00-jarvis.conf <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=64M
EOF
systemctl restart systemd-journald

cat <<'EOF'

== GOTOWE (prawie) ==
log2ram wymaga RESTARTU, żeby zamontować tmpfs nad /var/log.

    sudo reboot

Po restarcie zweryfikuj:
    mount | grep log2ram              # powinno pokazać tmpfs na /var/log
    systemctl status log2ram-daily.timer

Pamiętaj o osobnym kroku spoza tego skryptu: w AdGuard Home
(Ustawienia -> Dziennik zapytań) skróć retencję logu DNS z domyślnych
90 dni do 7 — to zwykle największe pojedyncze źródło zapisów na malince.
EOF
