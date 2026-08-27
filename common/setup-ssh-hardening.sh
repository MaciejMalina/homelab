#!/usr/bin/env bash
# =============================================================================
#  WSPÓLNE — hardening sshd (malinka + serwer)
#  Uruchom przez sudo NA KAŻDEJ z dwóch maszyn osobno.
# =============================================================================
#  Co robi:
#    - PermitRootLogin no          (root nie loguje się po SSH w ogóle)
#    - PasswordAuthentication no   (tylko klucze)
#    - KbdInteractiveAuthentication no (domyka lukę: PAM potrafi obejść
#      PasswordAuthentication=no, jeśli to zostawić włączone)
#    - Wrzuca to jako DROP-IN w /etc/ssh/sshd_config.d/, żeby nie ruszać
#      głównego pliku (przetrwa aktualizacje pakietu openssh-server)
#
#  UWAGA — PRZECZYTAJ PRZED URUCHOMIENIEM:
#  Jeśli DZIŚ logujesz się jako root po haśle (nie po kluczu), to po tym
#  skrypcie stracisz dostęp, dopóki nie masz zwykłego usera z sudo i kluczem
#  SSH. Skrypt to sprawdza i odmawia, jeśli nie widzi żadnego alternatywnego
#  sposobu wejścia — ale sprawdź SAM, zanim potwierdzisz.
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Uruchom przez sudo." >&2; exit 1
fi

HOST=$(hostname)
DROPIN=/etc/ssh/sshd_config.d/99-jarvis-hardening.conf

echo "== Sprawdzam, czy masz jak się zalogować bez hasła-do-roota =="
NONROOT_WITH_KEY=0
for d in /home/*; do
  u=$(basename "$d")
  if [ -s "$d/.ssh/authorized_keys" ]; then
    echo "  OK: user '$u' ma authorized_keys"
    NONROOT_WITH_KEY=1
  fi
done

if [ "$NONROOT_WITH_KEY" -eq 0 ]; then
  cat >&2 <<'EOF'

STOP — nie widzę ŻADNEGO zwykłego użytkownika z kluczem SSH w authorized_keys.
Jeśli teraz wyłączymy PermitRootLogin i PasswordAuthentication, możesz się
zablokować z systemu (poza dostępem fizycznym / konsolą).

Załóż najpierw usera z sudo i kluczem:
    sudo adduser <nazwa>
    sudo usermod -aG sudo <nazwa>          # Debian/Ubuntu — na malince może być grupa 'sudo' albo 'wheel'
    sudo install -d -m700 -o<nazwa> -g<nazwa> /home/<nazwa>/.ssh
    # wklej swój klucz PUBLICZNY do /home/<nazwa>/.ssh/authorized_keys
    sudo chmod 600 /home/<nazwa>/.ssh/authorized_keys

...i dopiero potem uruchom ten skrypt ponownie.
EOF
  exit 1
fi

echo "== Zapisuję drop-in: $DROPIN =="
install -d -m 0755 /etc/ssh/sshd_config.d
cat > "$DROPIN" <<'EOF'
# Wygenerowane przez jarvis/common/setup-ssh-hardening.sh — nie edytuj ręcznie,
# edytuj skrypt i uruchom ponownie.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF

echo "== Test składni sshd =="
sshd -t
echo "  OK — konfiguracja poprawna składniowo"

echo "== Restart sshd =="
if systemctl list-unit-files 2>/dev/null | grep -q '^ssh\.service'; then
  systemctl reload ssh
elif systemctl list-unit-files 2>/dev/null | grep -q '^sshd\.service'; then
  systemctl reload sshd
else
  echo "  Nie znalazłem jednostki ssh/sshd — zrestartuj ręcznie" >&2
fi

echo
echo "== GOTOWE na $HOST =="
echo "Sprawdzenie efektywnej konfiguracji:"
sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication)'
echo
echo "WAŻNE: zanim zamkniesz to okno, otwórz DRUGI terminal i sprawdź, że"
echo "nowe logowanie kluczem jako zwykły user + sudo nadal działa."
