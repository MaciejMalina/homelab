#!/usr/bin/env bash
# =============================================================================
#  SERWER — podsłuch: czego NAPRAWDĘ używa dzisiejszy klucz roota bota
# =============================================================================
#  Cel: zanim wyłączysz stary klucz root->root i przełączysz bota na
#  ograniczonego 'jpower' (jarvis-power-agent.sh), chcesz mieć PEWNOŚĆ, że
#  biała lista (dziś: tylko poweroff) obejmuje WSZYSTKO, czego bot używa.
#
#  Ten skrypt NIE BLOKUJE i NIE ZMIENIA zachowania klucza — dopisuje mu
#  tylko `command=` który LOGUJE polecenie, a potem WYKONUJE JE NORMALNIE
#  (bo to nadal pełny root, tylko z dopiskiem obserwacyjnym). Zostaw to na
#  kilka dni normalnej pracy bota (co najmniej jeden cykl "zgaś serwer
#  wieczorem"), potem sprawdź log i dopiero wtedy rób cutover na jpower.
#
#  Instalacja:
#     sudo install -m 0755 discover-bot-ssh-usage.sh /usr/local/bin/discover-bot-ssh-usage.sh
#
#  W /root/.ssh/authorized_keys PRZED istniejącym kluczem bota dopisz:
#     command="/usr/local/bin/discover-bot-ssh-usage.sh" ssh-ed25519 <KLUCZ_BOTA> jarvis-bot-DISCOVERY
#
#  (zostaw resztę linii bez zmian — no-port-forwarding itp. możesz dodać już
#  teraz, discover-bot-ssh-usage.sh i tak przepuszcza polecenie dalej)
# =============================================================================
set -euo pipefail
LOG=/var/log/jarvis-bot-ssh-discovery.log

CMD="${SSH_ORIGINAL_COMMAND:-<powłoka interaktywna, bez polecenia>}"
printf '%s\tuser=%s\tcmd=%s\n' "$(date -Is)" "$(whoami)" "$CMD" >> "$LOG"

# Wykonaj polecenie tak, jakby tego skryptu nie było (nadal pełny root!)
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  eval "$SSH_ORIGINAL_COMMAND"
else
  exec "$SHELL"
fi
