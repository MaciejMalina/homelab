#!/usr/bin/env bash
# =============================================================================
#  JARVIS — audyt stanu MALINKI (Raspberry Pi, węzeł always-on)
# =============================================================================
#  Skrypt jest CZYSTO ODCZYTOWY. Nic nie instaluje, nic nie zmienia, nic nie
#  restartuje. Można go bezpiecznie puścić na produkcji.
#
#  Uruchomienie:
#     chmod +x jarvis-audit-malinka.sh
#     sudo ./jarvis-audit-malinka.sh | tee /tmp/audyt-malinka.md
#
#  Wynik to gotowy raport Markdown — wklej go z powrotem do rozmowy.
#  Legenda:  [OK] zrobione · [!!] brak / ryzyko · [??] nie da się stwierdzić · [i] info
# =============================================================================
set -uo pipefail
export LC_ALL=C

OUT_SUMMARY=()

hdr()  { printf '\n\n## %s\n\n' "$*"; }
sub()  { printf '\n### %s\n\n' "$*"; }
kv()   { printf '* **%s:** %s\n' "$1" "${2:-—}"; }
pre()  { printf '\n```\n%s\n```\n' "${1:-(brak danych)}"; }
have() { command -v "$1" >/dev/null 2>&1; }

# chk <STATUS> <ID> <opis>   STATUS: OK | FAIL | UNK | INFO
chk() {
  local st="$1" id="$2"; shift 2
  local mark
  case "$st" in
    OK)   mark='[OK]' ;;
    FAIL) mark='[!!]' ;;
    UNK)  mark='[??]' ;;
    *)    mark='[i ]' ;;
  esac
  printf '%s **%s** — %s\n' "$mark" "$id" "$*"
  OUT_SUMMARY+=("$mark $id — $*")
}

run() { # run <komenda...> — bezpieczne wywołanie, nigdy nie wywraca skryptu
  "$@" 2>&1 || true
}
dq() { # dq <argumenty docker> — docker bez szumu błędów (pusty wynik = brak/niedostępny)
  docker "$@" 2>/dev/null || true
}

printf '# Audyt JARVIS — MALINKA\n\n'
kv "Host" "$(hostname)"
kv "Data audytu" "$(date -Is)"
kv "Skrypt" "jarvis-audit-malinka.sh v1"
[ "$(id -u)" -ne 0 ] && printf '\n> **UWAGA:** uruchomiono bez root — część sekcji będzie niepełna. Puść przez `sudo`.\n'

# =============================================================================
hdr "1. Sprzęt, system, zdrowie"
# =============================================================================
kv "Model" "$(run cat /proc/device-tree/model | tr -d '\0')"
kv "OS" "$(run sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '\"')"
kv "Kernel" "$(uname -srm)"
kv "Architektura userland" "$(run dpkg --print-architecture)"
kv "Uptime" "$(run uptime -p)"
kv "Load" "$(run cut -d' ' -f1-3 /proc/loadavg)"
kv "RAM" "$(run free -h | awk '/Mem:/{printf "%s uzyte / %s total (dostepne: %s)", $3, $2, $7}')"
kv "Swap" "$(run free -h | awk '/Swap:/{printf "%s / %s", $3, $2}')"

if have vcgencmd; then
  TEMP=$(run vcgencmd measure_temp)
  THROT=$(run vcgencmd get_throttled)
  kv "Temperatura SoC" "$TEMP"
  kv "get_throttled" "$THROT"
  case "$THROT" in
    *0x0) chk OK  HW-THROTTLE "Brak throttlingu i under-voltage od startu systemu" ;;
    *)    chk FAIL HW-THROTTLE "Wykryto throttling/under-voltage ($THROT) — sprawdź zasilacz 5V/3A i chłodzenie" ;;
  esac
else
  chk UNK HW-THROTTLE "Brak vcgencmd — nie sprawdzę under-voltage"
fi

sub "Zram / zswap"
kv "zramswap" "$(run systemctl is-active zramswap 2>/dev/null)"
pre "$(run zramctl)"

# =============================================================================
hdr "2. Nośnik i storage (kluczowe: pendrive vs SSD)"
# =============================================================================
sub "Urządzenia blokowe"
pre "$(run lsblk -o NAME,SIZE,ROTA,TRAN,TYPE,FSTYPE,MOUNTPOINT,MODEL,SERIAL)"

ROOTSRC=$(findmnt -no SOURCE / 2>/dev/null)
ROOTDISK=$(lsblk -no PKNAME "$ROOTSRC" 2>/dev/null | head -1)
ROOTTRAN=$(lsblk -dno TRAN "/dev/$ROOTDISK" 2>/dev/null)
ROOTMODEL=$(lsblk -dno MODEL "/dev/$ROOTDISK" 2>/dev/null)
kv "Root filesystem" "$ROOTSRC (dysk: /dev/${ROOTDISK:-?}, transport: ${ROOTTRAN:-?}, model: ${ROOTMODEL:-?})"
kv "cmdline root=" "$(run sed -n 's/.*\(root=[^ ]*\).*/\1/p' /proc/cmdline)"

case "$ROOTDISK" in
  mmcblk*) chk FAIL STOR-BOOT "System startuje z karty microSD — najsłabsze ogniwo (brak SMART, wear-out po ~1-2 latach zapisów). Migracja na SSD USB3 rekomendowana." ;;
  sd*)
    if [ "${ROOTTRAN:-}" = "usb" ]; then
      # pendrive czy SSD? heurystyka: rotational=0 + obecność SMART/UAS
      UASP=$(run ls -l "/sys/block/$ROOTDISK/device/../../driver" | grep -o 'uas$')
      kv "Sterownik USB" "${UASP:-usb-storage (BRAK UASP)}"
      if have smartctl && smartctl -i "/dev/$ROOTDISK" >/dev/null 2>&1; then
        chk OK STOR-BOOT "Root na USB, urządzenie zwraca SMART — najprawdopodobniej SSD. Model: ${ROOTMODEL:-?}"
        pre "$(run smartctl -a "/dev/$ROOTDISK" | head -40)"
      else
        chk FAIL STOR-BOOT "Root na USB bez SMART — to najpewniej PENDRIVE. Brak telemetrii zużycia, awaria będzie cicha i nagła. Wymień na SSD (patrz sekcja rekomendacji)."
      fi
      [ -z "${UASP:-}" ] && chk FAIL STOR-UASP "Nośnik działa przez usb-storage zamiast UAS — wolniej i wyższe obciążenie CPU. Sprawdź mostek USB-SATA / quirks."
    else
      chk OK STOR-BOOT "Root na ${ROOTTRAN:-?} (${ROOTMODEL:-?})"
    fi
    ;;
  nvme*) chk OK STOR-BOOT "Root na NVMe (${ROOTMODEL:-?})" ;;
  *)     chk UNK STOR-BOOT "Nie rozpoznano nośnika root ($ROOTSRC)" ;;
esac

sub "Zajętość"
pre "$(run df -hT -x tmpfs -x devtmpfs)"
DFROOT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "${DFROOT:-0}" -ge 85 ] && chk FAIL STOR-FULL "Root zapełniony w ${DFROOT}% — zrób miejsce zanim coś padnie"
[ "${DFROOT:-0}" -lt 85 ] && chk OK STOR-FULL "Root zapełniony w ${DFROOT}% — OK"

sub "TRIM / fstrim"
kv "fstrim.timer" "$(run systemctl is-enabled fstrim.timer 2>/dev/null)"
if [ "$(run systemctl is-enabled fstrim.timer 2>/dev/null)" = "enabled" ]; then
  chk OK STOR-TRIM "fstrim.timer włączony"
else
  chk FAIL STOR-TRIM "fstrim.timer wyłączony — na SSD włącz: systemctl enable --now fstrim.timer"
fi

sub "log2ram (ochrona nośnika przed zapisami logów)"
if systemctl list-unit-files 2>/dev/null | grep -q '^log2ram'; then
  chk OK P2-LOG2RAM "log2ram zainstalowany ($(run systemctl is-active log2ram))"
  pre "$(run cat /etc/log2ram.conf | grep -v '^#' | grep -v '^$')"
else
  chk FAIL P2-LOG2RAM "Brak log2ram — /var/log wali w nośnik 24/7 (punkt 4 roadmapy z audytu)"
fi
kv "Rozmiar /var/log" "$(run du -sh /var/log | cut -f1)"
kv "journald max use" "$(run grep -E '^\s*SystemMaxUse' /etc/systemd/journald.conf)"

# =============================================================================
hdr "3. Docker — stan stosu"
# =============================================================================
if ! have docker; then
  chk FAIL DOCKER "Docker nie jest zainstalowany na malince (?)"
else
  kv "Docker" "$(run docker --version)"
  kv "Compose" "$(run docker compose version)"
  sub "Kontenery"
  pre "$(dq ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}')"

  UNHEALTHY=$(dq ps --filter health=unhealthy --format '{{.Names}}' | tr '\n' ' ')
  EXITED=$(dq ps -a --filter status=exited --format '{{.Names}}' | tr '\n' ' ')
  [ -n "${UNHEALTHY// /}" ] && chk FAIL DOCK-HEALTH "Kontenery unhealthy: $UNHEALTHY" || chk OK DOCK-HEALTH "Brak kontenerów unhealthy"
  [ -n "${EXITED// /}" ]    && chk INFO DOCK-EXITED "Kontenery zatrzymane: $EXITED"

  sub "Polityka restartu i przypięcie wersji obrazów"
  printf '%s\n' '| Kontener | restart | obraz | przypięty? |'
  printf '%s\n' '|---|---|---|---|'
  for c in $(dq ps -a --format '{{.Names}}'); do
    RP=$(run docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c")
    IM=$(run docker inspect -f '{{.Config.Image}}' "$c")
    case "$IM" in
      *:latest) PIN="NIE (:latest)" ;;
      *:*)      PIN="tak" ;;
      *)        PIN="NIE (brak tagu)" ;;
    esac
    printf '| %s | %s | %s | %s |\n' "$c" "$RP" "$IM" "$PIN"
  done
  LATEST_COUNT=$(dq ps -a --format '{{.Image}}' | grep -c ':latest\|^[^:]*$')
  [ "${LATEST_COUNT:-0}" -gt 0 ] && chk FAIL DOCK-PIN "$LATEST_COUNT kontenerów na :latest / bez tagu — aktualizacje niekontrolowane (audyt §3 krok 5)" || chk OK DOCK-PIN "Wszystkie obrazy przypięte do wersji"

  sub "Wolumeny i ich rozmiar"
  pre "$(run docker system df -v | head -60)"

  sub "Lokalizacje plików compose"
  COMPOSE_FILES=$(run find /opt /home /root /srv -maxdepth 4 -name 'docker-compose*.y*ml' -o -maxdepth 4 -name 'compose.y*ml' 2>/dev/null | sort)
  pre "$COMPOSE_FILES"
  CF_DIRS=$(printf '%s\n' "$COMPOSE_FILES" | xargs -r -n1 dirname | sort -u)
  CF_N=$(printf '%s\n' "$CF_DIRS" | grep -c . || true)
  [ "${CF_N:-0}" -gt 1 ] && chk FAIL P2-SCATTER "Konfiguracje w $CF_N różnych katalogach — audyt P2 (rozproszony stan). Docelowo jedno repo git."
fi

# =============================================================================
hdr "4. Wersjonowanie konfiguracji (audyt P2 / roadmapa #4)"
# =============================================================================
GITREPOS=$(run find /opt /home /root /srv -maxdepth 4 -type d -name .git 2>/dev/null | xargs -r -n1 dirname | sort -u)
if [ -n "$GITREPOS" ]; then
  chk OK P2-GIT "Znaleziono repozytoria git:"
  pre "$GITREPOS"
  for r in $GITREPOS; do
    printf '* `%s` — branch: %s, brudne pliki: %s, remote: %s\n' \
      "$r" \
      "$(run git -C "$r" rev-parse --abbrev-ref HEAD)" \
      "$(run git -C "$r" status --porcelain | wc -l)" \
      "$(run git -C "$r" remote -v | head -1)"
  done
else
  chk FAIL P2-GIT "Brak repozytorium git z konfiguracją — odtworzenie malinki = archeologia (roadmapa #4)"
fi
have ansible-playbook && chk OK P2-ANSIBLE "Ansible obecny" || chk INFO P2-ANSIBLE "Brak Ansible (docelowy punkt roadmapy, nie pilny)"
have sops && chk OK P2-SOPS "sops obecny (szyfrowanie sekretów w repo)" || chk INFO P2-SOPS "Brak sops/age — sekrety trzymane poza repo?"

# =============================================================================
hdr "5. Automatyzacja: cron, timery, joby"
# =============================================================================
sub "Crontab roota"
pre "$(run crontab -l)"
sub "Crontaby userów"
for u in $(run cut -d: -f1 /etc/passwd); do
  C=$(run crontab -u "$u" -l | grep -v '^#' | grep -v '^$')
  [ -n "$C" ] && printf '**%s:**\n```\n%s\n```\n' "$u" "$C"
done
sub "/etc/cron.d"
pre "$(run grep -rvE '^\s*(#|$)' /etc/cron.d/ 2>/dev/null)"
sub "Aktywne timery systemd"
pre "$(run systemctl list-timers --all --no-pager)"

# =============================================================================
hdr "6. Backupy — stan faktyczny (audyt P1)"
# =============================================================================
have restic && kv "restic" "$(run restic version)" || chk FAIL P1-RESTIC "Brak restic na malince — offsite backup z §2 audytu nie jest wdrożony"
have rsync  && kv "rsync" "$(run rsync --version | head -1)" || chk FAIL BKP-RSYNC "Brak rsync"
have borg   && kv "borg" "$(run borg --version)"

sub "Skrypty backupowe znalezione na dysku"
BSCRIPTS=$(run find /opt /root /home /usr/local/bin -maxdepth 4 -type f \( -name '*backup*' -o -name '*restic*' \) 2>/dev/null | head -40)
pre "$BSCRIPTS"

sub "Katalogi wyglądające na backupowe"
pre "$(run find / -maxdepth 4 -type d \( -name 'backup*' -o -name 'restic*' \) -not -path '*/proc/*' -not -path '*/sys/*' 2>/dev/null | head -30)"

sub "Czy istnieje backup malinki gdziekolwiek?"
if [ -n "$BSCRIPTS" ]; then
  chk INFO BKP-PI "Znaleziono skrypty backupowe — sprawdź poniżej czy dotyczą malinki czy tylko serwera"
else
  chk FAIL BKP-PI "Nie znalazłem żadnego skryptu backupu NA malince — malinka to SPOF bez kopii (audyt P2)"
fi

sub "Rozmiar kandydatów do backupu"
for d in /etc /opt /home /root /var/lib/docker/volumes /srv; do
  [ -d "$d" ] && printf '* `%s` — %s\n' "$d" "$(run du -sh "$d" 2>/dev/null | cut -f1)"
done

# =============================================================================
hdr "7. Sieć, DNS, dostęp zdalny"
# =============================================================================
kv "IP" "$(run hostname -I)"
sub "Nasłuchujące porty"
pre "$(run ss -tulpn | grep LISTEN)"

sub "Tailscale"
if have tailscale; then
  kv "status" "$(run tailscale status --peers=false | head -3)"
  kv "Funnel/Serve" "$(run tailscale serve status)"
  chk OK NET-TS "Tailscale działa"
else
  chk UNK NET-TS "Brak binarki tailscale w PATH (może być w kontenerze)"
fi

sub "AdGuard / DNS"
dq ps --format '{{.Names}}' | grep -qi adguard && chk OK NET-DNS "Kontener AdGuard obecny" || chk UNK NET-DNS "Nie widzę kontenera AdGuard"
kv "resolv.conf" "$(run grep nameserver /etc/resolv.conf | tr '\n' ' ')"

sub "Nginx Proxy Manager"
dq ps --format '{{.Names}}' | grep -qiE 'npm|nginx-proxy' && chk OK NET-NPM "NPM obecny" || chk UNK NET-NPM "Nie widzę kontenera NPM"

sub "fail2ban / CrowdSec"
have fail2ban-client && chk OK SEC-F2B "fail2ban obecny: $(run fail2ban-client status | tr '\n' ' ')" || chk FAIL SEC-F2B "Brak fail2ban (audyt P2 — wspólne hasło na Funnel)"
dq ps --format '{{.Names}}' | grep -qi crowdsec && chk OK SEC-CS "CrowdSec obecny"

# =============================================================================
hdr "8. Bezpieczeństwo SSH (audyt P1 — klucz do root@serwer)"
# =============================================================================
sub "Konfiguracja sshd"
pre "$(run sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|port|allowusers|allowgroups)')"
PRL=$(run sshd -T 2>/dev/null | awk '/^permitrootlogin/{print $2}')
PWA=$(run sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')
[ "$PWA" = "no" ] && chk OK SEC-SSH-PW "Logowanie hasłem wyłączone" || chk FAIL SEC-SSH-PW "PasswordAuthentication=$PWA — wyłącz"
[ "$PRL" = "no" ] || chk INFO SEC-SSH-ROOT "PermitRootLogin=$PRL"

sub "Klucze prywatne obecne na malince (KTO ma dostęp DOKĄD)"
pre "$(run find /root /home -maxdepth 4 -name 'id_*' -not -name '*.pub' 2>/dev/null)"

sub "authorized_keys — czy jest forced command?"
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -f "$f" ] || continue
  printf '**%s**\n' "$f"
  pre "$(run sed -E 's/(ssh-[a-z0-9]+ )[A-Za-z0-9+/=]{20,}/\1<KLUCZ>/g' "$f")"
done
if grep -rqs 'command=' /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null; then
  chk OK P1-FORCED "Znaleziono forced command w authorized_keys"
else
  chk FAIL P1-FORCED "Brak forced command w authorized_keys — punkt P1 audytu niezrealizowany"
fi

sub "Klucze SSH używane przez kontener bota"
BOT=$(dq ps --format '{{.Names}}' | grep -iE 'bot|jarvis' | head -1)
if [ -n "$BOT" ]; then
  kv "Kontener bota" "$BOT"
  pre "$(run docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Mode}}){{println}}{{end}}' "$BOT")"
  pre "$(run docker exec "$BOT" sh -c 'ls -la ~/.ssh 2>/dev/null; head -c 60 ~/.ssh/config 2>/dev/null')"
fi

# =============================================================================
hdr "9. Warstwa głosowa / wakeword / TTS (roadmapa #8)"
# =============================================================================
for svc in wakeword jarvis-wakeword porcupine openwakeword piper rhasspy wyoming; do
  S=$(run systemctl is-active "$svc" 2>/dev/null)
  [ "$S" != "inactive" ] && [ -n "$S" ] && [ "$S" != "unknown" ] && kv "systemd:$svc" "$S"
done
dq ps --format '{{.Names}}' | grep -qiE 'piper|tts' && chk OK VOICE-TTS "Kontener TTS/Piper obecny" || chk FAIL VOICE-TTS "Brak Pipera — pętla głosowa niedomknięta (roadmapa #8)"
dq ps --format '{{.Names}}' | grep -qiE 'wakeword|wyoming|openwake' && chk OK VOICE-WW "Wakeword w kontenerze" || chk INFO VOICE-WW "Wakeword prawdopodobnie jako proces/systemd — sprawdź wyżej"

# =============================================================================
hdr "10. Monitoring (audyt P3 / roadmapa #5)"
# =============================================================================
dq ps --format '{{.Names}}' | grep -qi uptime && chk OK P3-KUMA "Uptime Kuma działa" || chk FAIL P3-KUMA "Brak Uptime Kuma — nikt nie pilnuje bota (audyt P3)"
dq ps --format '{{.Names}}' | grep -qi ntfy && chk OK IDEA-NTFY "ntfy obecny (kanał alertów niezależny od Discorda)" || chk INFO IDEA-NTFY "Brak ntfy — Discord jest SPOF-em komunikacji"
dq ps --format '{{.Names}}' | grep -qiE 'glances|netdata|beszel|grafana|prometheus' && kv "Monitoring" "$(dq ps --format '{{.Names}}' | grep -iE 'glances|netdata|beszel|grafana|prometheus' | tr '\n' ' ')"
dq ps --format '{{.Names}}' | grep -qi healthchecks && chk OK IDEA-HC "healthchecks self-hosted obecny"

# =============================================================================
hdr "11. Homepage (dashboard)"
# =============================================================================
HP=$(dq ps --format '{{.Names}}' | grep -i homepage | head -1)
if [ -n "$HP" ]; then
  chk OK HP-RUN "Homepage działa jako '$HP'"
  kv "Obraz" "$(run docker inspect -f '{{.Config.Image}}' "$HP")"
  sub "Montowane configi"
  pre "$(run docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' "$HP")"
  HPCFG=$(run docker inspect -f "{{range .Mounts}}{{if eq .Destination \"/app/config\"}}{{.Source}}{{end}}{{end}}" "$HP")
  if [ -n "$HPCFG" ] && [ -d "$HPCFG" ]; then
    kv "Katalog configu" "$HPCFG"
    pre "$(run ls -la "$HPCFG")"
    sub "services.yaml (obecne usługi)"
    pre "$(run grep -E '^\s*-?\s*[A-Za-z].*:' "$HPCFG/services.yaml" | head -60)"
    sub "settings.yaml"
    pre "$(run cat "$HPCFG/settings.yaml")"
    grep -q 'HOMEPAGE_ALLOWED_HOSTS' <<<"$(run docker inspect -f '{{range .Config.Env}}{{.}} {{end}}' "$HP")" \
      && chk OK HP-HOSTS "HOMEPAGE_ALLOWED_HOSTS ustawione" \
      || chk FAIL HP-HOSTS "Brak HOMEPAGE_ALLOWED_HOSTS — od v1.0 wymagane, inaczej 'Bad Request'"
  fi
else
  chk UNK HP-RUN "Nie widzę kontenera homepage na malince (może stoi na serwerze?)"
fi

# =============================================================================
hdr "12. IoT / MQTT / ESP (pod sterowanie paskiem LED)"
# =============================================================================
dq ps --format '{{.Names}}' | grep -qiE 'mosquitto|mqtt|emqx' && chk OK IOT-MQTT "Broker MQTT obecny" || chk FAIL IOT-MQTT "Brak brokera MQTT — przyda się jako szyna dla ESP (LED, czujniki)"
dq ps --format '{{.Names}}' | grep -qiE 'homeassistant|hass' && chk OK IOT-HA "Home Assistant obecny" || chk INFO IOT-HA "Brak Home Assistant"
dq ps --format '{{.Names}}' | grep -qi esphome && chk OK IOT-ESPHOME "ESPHome obecny"
sub "Urządzenia w sieci LAN odpowiadające jak WLED (skan portu 80, /json/info)"
printf '_(pominięte — uruchom ręcznie, jeśli chcesz: `for i in $(seq 1 254); do curl -m 1 -s http://192.168.X.$i/json/info | grep -o "\\"brand\\":\\"WLED\\"" && echo 192.168.X.$i; done`)_\n'

# =============================================================================
hdr "13. Wake-on-LAN i sterowanie serwerem"
# =============================================================================
have wakeonlan && kv "wakeonlan" "obecny"
have etherwake && kv "etherwake" "obecny"
have wakeonlan || have etherwake || chk INFO WOL-BIN "Brak wakeonlan/etherwake w PATH — WoL leci pewnie z kontenera bota"
sub "Skrypty power/WoL"
pre "$(run find /opt /usr/local/bin /root /home -maxdepth 4 -type f \( -name '*wol*' -o -name '*power*' -o -name '*wake*' \) 2>/dev/null | head -20)"

# =============================================================================
hdr "14. Aktualizacje systemu"
# =============================================================================
kv "unattended-upgrades" "$(run systemctl is-enabled unattended-upgrades 2>/dev/null)"
kv "Pakiety do aktualizacji" "$(run apt list --upgradable 2>/dev/null | grep -c upgradable)"
kv "Wymagany restart" "$([ -f /var/run/reboot-required ] && echo TAK || echo nie)"
[ "$(run systemctl is-enabled unattended-upgrades 2>/dev/null)" = "enabled" ] \
  && chk OK SYS-UNATT "unattended-upgrades włączone" \
  || chk FAIL SYS-UNATT "Brak automatycznych aktualizacji bezpieczeństwa"

# =============================================================================
hdr "PODSUMOWANIE — checklista"
# =============================================================================
printf '\n'
if [ "${#OUT_SUMMARY[@]}" -gt 0 ]; then
  printf '%s\n' "${OUT_SUMMARY[@]}" | sed 's/^/- /'
fi
printf '\n\n**Legenda:** `[OK]` zrobione · `[!!]` brak lub ryzyko · `[??]` nie dało się stwierdzić · `[i ]` informacja\n'
printf '\n_Koniec raportu MALINKA — %s_\n' "$(date -Is)"
