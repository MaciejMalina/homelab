#!/usr/bin/env bash
# =============================================================================
#  SERWER — agent zasilania (forced command dla klucza bota Discord)
# =============================================================================
#  Instalacja NA SERWERZE:
#     sudo install -m 0755 jarvis-power-agent.sh /usr/local/bin/jarvis-power-agent.sh
#     sudo useradd -m -s /bin/bash jpower
#     sudo install -d -m 0700 -o jpower -g jpower /home/jpower/.ssh
#     # wklej klucz PUBLICZNY bota do /home/jpower/.ssh/authorized_keys
#     # w formacie z pliku authorized_keys-power.example (obok tego skryptu)
#     echo 'jpower ALL=(root) NOPASSWD: SETENV: /usr/local/bin/jarvis-power-agent.sh' \
#        | sudo tee /etc/sudoers.d/jarvis-power
#     sudo chmod 0440 /etc/sudoers.d/jarvis-power
#     sudo visudo -c
#
#  MODEL BEZPIECZEŃSTWA:
#  Bot Discorda łączy się jako 'jpower' zamiast root@serwer. Forced command
#  ogranicza go do whitelisty niżej — nie da się przez ten klucz dostać
#  powłoki ani wykonać nic innego.
#
#  BIAŁA LISTA (2026-08-27, ustalona z realnego kodu bota commands.py, nie
#  z podsłuchu — root i tak już nie logował się po SSH hardeningu, więc
#  discover-bot-ssh-usage.sh nie mógł zadziałać):
#     poweroff  — /shutdown_serwer
#     reboot    — /reboot
#     ping      — test łączności (agent, nie discordowa komenda)
#     info      — /info: status CPU/RAM/GPU/dysk. Treść skryptu PRZENIESIONA
#                 tu z bota (bot wysyła tylko krótkie hasło "info", nie cały
#                 skrypt przez SSH) — bezpieczniej i łatwiej to utrzymać.
# =============================================================================
set -euo pipefail
export LC_ALL=C

LOGTAG="jarvis-power-agent"
log() { logger -t "$LOGTAG" -- "$*"; }
die() { log "ODRZUCONO: $*"; printf 'jarvis-power-agent: odrzucono (%s)\n' "$*" >&2; exit 42; }

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n --preserve-env=SSH_ORIGINAL_COMMAND /usr/local/bin/jarvis-power-agent.sh
fi

CMD="${SSH_ORIGINAL_COMMAND:-}"
[ -n "$CMD" ] || die "brak polecenia (powłoka interaktywna jest zablokowana)"
log "żądanie: ${CMD:0:200}"

case "$CMD" in

  poweroff|"systemctl poweroff")
    log "poweroff — wyłączam serwer"
    exec systemctl poweroff
    ;;

  reboot|"systemctl reboot")
    log "reboot — restartuję serwer"
    exec systemctl reboot
    ;;

  ping)
    echo "pong $(hostname) $(date -Is)"
    ;;

  info)
    cpu=$(cat /proc/loadavg | awk '{print $1, $2, $3}')
    ram=$(free -m | awk 'NR==2 {printf "%d MB / %d MB", $3, $2}')
    if command -v nvidia-smi >/dev/null 2>&1; then
      gpu=$(nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader | awk -F', ' '{printf "%s%% | Temp: %s°C | VRAM: %s / %s", $1, $2, $3, $4}' 2>/dev/null || echo "Oczekuje na instalację sterownika")
    else
      gpu="Oczekuje na sprzęt"
    fi
    disk_root=$(df -h / | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}')
    if df -h | grep -q '/mnt/data'; then
      disk_data=$(df -h /mnt/data | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}')
    else
      disk_data="Oczekuje na sprzęt"
    fi
    uptime_sys=$(uptime -p)
    echo "⏱️ **Uptime:** $uptime_sys"
    echo "🧠 **CPU Load (1/5/15m):** $cpu"
    echo "💾 **RAM:** $ram"
    echo "🎮 **GPU:** $gpu"
    echo "💽 **SSD (/):** $disk_root"
    echo "🗄️ **HDD (RAID):** $disk_data"
    ;;

  *)
    die "polecenie spoza białej listy: ${CMD:0:120}"
    ;;
esac
