#!/usr/bin/env bash
# =============================================================================
#  WSPÓLNE — unattended-upgrades (malinka + serwer)
#  Uruchom przez sudo NA KAŻDEJ z dwóch maszyn.
# =============================================================================
#  Wg decyzji: automatyczne poprawki bezpieczeństwa WŁĄCZONE, automatyczny
#  reboot WŁĄCZONY o 22:00 (kontenery mają restart:unless-stopped, więc
#  wstają same; serwer usypiany idle-shutdownem i tak startuje na nowo przy
#  WoL — reboot o 22:00 nie koliduje z backupem, który leci 03:00-03:40).
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Uruchom przez sudo." >&2; exit 1
fi

echo "== Instaluję unattended-upgrades =="
apt-get update -qq
apt-get install -y unattended-upgrades apt-listchanges

echo "== Konfiguruję automatyczny reboot o 22:00, tylko poprawki bezpieczeństwa =="
install -d -m 0755 /etc/apt/apt.conf.d
cat > /etc/apt/apt.conf.d/51jarvis-unattended-upgrades <<'EOF'
// Wygenerowane przez jarvis/common/setup-unattended-upgrades.sh
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "22:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF

cat > /etc/apt/apt.conf.d/20jarvis-auto-upgrades <<'EOF'
// Wygenerowane przez jarvis/common/setup-unattended-upgrades.sh
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "== Sprawdzam listę Origins-Pattern (czy jest sensowna dla tej dystrybucji) =="
if [ -f /etc/apt/apt.conf.d/50unattended-upgrades ]; then
  grep -A3 'Unattended-Upgrade::Origins-Pattern' /etc/apt/apt.conf.d/50unattended-upgrades | head -6
else
  echo "  [!] Brak /etc/apt/apt.conf.d/50unattended-upgrades — coś poszło nie tak z instalacją pakietu"
fi

echo "== Włączam usługę =="
systemctl enable --now unattended-upgrades

echo
echo "== GOTOWE — dry-run (nic nie instaluje, tylko pokazuje co by zrobił) =="
unattended-upgrade --dry-run --debug 2>&1 | tail -30

echo
echo "Stan przed/po: apt list --upgradable 2>/dev/null | grep -c upgradable"
apt list --upgradable 2>/dev/null | grep -c upgradable || true
echo "(to jest liczba zaległych pakietów TERAZ — spadnie stopniowo po kolejnych przebiegach,"
echo " część może wymagać ręcznego apt upgrade przy większych skokach wersji)"
