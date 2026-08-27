#!/usr/bin/env bash
# =============================================================================
#  JARVIS — audyt stanu SERWERA (Debian x86_64, węzeł efemeryczny / GPU)
# =============================================================================
#  Skrypt jest CZYSTO ODCZYTOWY. Nic nie instaluje, nie zmienia, nie restartuje.
#  UWAGA: na starcie zakłada lockfile /etc/jarvis-no-autoshutdown, żeby
#  idle-shutdown nie uciął audytu w połowie, i kasuje go na wyjściu.
#
#  Uruchomienie:
#     chmod +x jarvis-audit-serwer.sh
#     sudo ./jarvis-audit-serwer.sh | tee /tmp/audyt-serwer.md
#
#  Legenda:  [OK] zrobione · [!!] brak / ryzyko · [??] nie da się stwierdzić · [i] info
# =============================================================================
set -uo pipefail
export LC_ALL=C

LOCK=/etc/jarvis-no-autoshutdown
LOCK_MINE=0
if [ "$(id -u)" -eq 0 ] && [ ! -e "$LOCK" ]; then
  touch "$LOCK" && LOCK_MINE=1
fi
cleanup() { [ "$LOCK_MINE" -eq 1 ] && rm -f "$LOCK"; }
trap cleanup EXIT INT TERM

OUT_SUMMARY=()

hdr()  { printf '\n\n## %s\n\n' "$*"; }
sub()  { printf '\n### %s\n\n' "$*"; }
kv()   { printf '* **%s:** %s\n' "$1" "${2:-—}"; }
pre()  { printf '\n```\n%s\n```\n' "${1:-(brak danych)}"; }
have() { command -v "$1" >/dev/null 2>&1; }
run()  { "$@" 2>&1 || true; }
dq()   { docker "$@" 2>/dev/null || true; }
jget() { curl -fsS -m 5 "$1" 2>/dev/null || true; }

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

printf '# Audyt JARVIS — SERWER\n\n'
kv "Host" "$(hostname)"
kv "Data audytu" "$(date -Is)"
kv "Skrypt" "jarvis-audit-serwer.sh v1"
kv "Lockfile idle-shutdown" "$([ "$LOCK_MINE" -eq 1 ] && echo "założony przez audyt (skasuję na końcu)" || echo "już istniał lub brak root")"
[ "$(id -u)" -ne 0 ] && printf '\n> **UWAGA:** bez roota część sekcji będzie pusta. Puść przez `sudo`.\n'

# =============================================================================
hdr "1. Sprzęt i system"
# =============================================================================
kv "OS" "$(run sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '\"')"
kv "Kernel" "$(uname -srm)"
kv "CPU" "$(run lscpu | awk -F: '/Model name/{gsub(/^ +/,"",$2); print $2; exit}')"
kv "Rdzenie/wątki" "$(run nproc)"
kv "RAM" "$(run free -h | awk '/Mem:/{printf "%s uzyte / %s total (dostepne: %s)", $3, $2, $7}')"
kv "Uptime" "$(run uptime -p)"
sub "Temperatury / czujniki"
pre "$(run sensors)"

# =============================================================================
hdr "2. GPU — stan po/przed wymianą na GTX 1070 Ti"
# =============================================================================
if have nvidia-smi; then
  GPUNAME=$(run nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  GPUMEM=$(run nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -1)
  DRV=$(run nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
  kv "Karta" "$GPUNAME"
  kv "VRAM" "$GPUMEM"
  kv "Sterownik" "$DRV"
  kv "CUDA (runtime wg smi)" "$(run nvidia-smi | awk '/CUDA Version/{print $NF}' | tr -d '|')"
  pre "$(run nvidia-smi)"
  case "$GPUNAME" in
    *1070*) chk OK GPU-UPGRADE "GTX 1070 Ti zamontowana ($GPUMEM) — plan §6 audytu zrealizowany sprzętowo" ;;
    *960*)  chk FAIL GPU-UPGRADE "Nadal GTX 960 4 GB — upgrade z §6 audytu jeszcze nie wykonany" ;;
    *)      chk INFO GPU-UPGRADE "Wykryto: $GPUNAME / $GPUMEM" ;;
  esac
  sub "Procesy trzymające VRAM"
  pre "$(run nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv)"
  sub "Zasilanie i limity (istotne przy TDP 180 W)"
  pre "$(run nvidia-smi --query-gpu=power.draw,power.limit,temperature.gpu,utilization.gpu,clocks_throttle_reasons.active --format=csv)"
else
  chk UNK GPU-DRV "Brak nvidia-smi — sterownik NVIDIA nie zainstalowany albo GPU wypięte"
fi

sub "NVIDIA Container Toolkit (GPU w Dockerze)"
if have nvidia-ctk || [ -f /etc/docker/daemon.json ] && grep -qs nvidia /etc/docker/daemon.json; then
  chk OK GPU-DOCKER "Runtime nvidia skonfigurowany dla Dockera"
  pre "$(run cat /etc/docker/daemon.json)"
else
  chk UNK GPU-DOCKER "Nie potwierdziłem runtime'u nvidia w Dockerze"
fi

# =============================================================================
hdr "3. Dyski, RAID, gdzie leżą backupy (audyt P1)"
# =============================================================================
sub "Urządzenia blokowe"
pre "$(run lsblk -o NAME,SIZE,ROTA,TRAN,TYPE,FSTYPE,MOUNTPOINT,MODEL,SERIAL)"
sub "Zajętość"
pre "$(run df -hT -x tmpfs -x devtmpfs -x overlay)"
sub "RAID (mdadm)"
pre "$(run cat /proc/mdstat)"
pre "$(run mdadm --detail --scan)"
if grep -qs 'active' /proc/mdstat; then
  if grep -qs '\[U*_' /proc/mdstat || grep -qs '_' /proc/mdstat; then
    chk FAIL RAID-DEGRADED "Macierz wygląda na zdegradowaną — sprawdź /proc/mdstat wyżej!"
  else
    chk OK RAID-OK "Macierz RAID zdrowa"
  fi
else
  chk INFO RAID-OK "Brak aktywnej macierzy md (albo RAID sprzętowy/ZFS)"
fi

sub "SMART dysków"
for d in /dev/sd? /dev/nvme?n1; do
  [ -b "$d" ] || continue
  if have smartctl; then
    ST=$(run smartctl -H "$d" | grep -Ei 'overall-health|SMART Health')
    PH=$(run smartctl -A "$d" | grep -Ei 'Power_On_Hours|Reallocated_Sector|Current_Pending|Media_Wearout|Percentage Used|Wear_Leveling')
    printf '**%s** — %s\n' "$d" "${ST:-brak}"
    [ -n "$PH" ] && pre "$PH"
    echo "$ST" | grep -qi 'PASSED\|OK' || chk FAIL SMART-"$(basename "$d")" "SMART dla $d nie zwrócił PASSED — sprawdź dysk"
  fi
done
have smartctl || chk FAIL SMART-BIN "Brak smartmontools — nie masz telemetrii zdrowia dysków (apt install smartmontools)"
kv "smartd" "$(run systemctl is-active smartd 2>/dev/null)"

sub "KLUCZOWE: czy backupy leżą na tej samej macierzy co dane? (audyt P1)"
BKPLIST=/tmp/.jarvis-audit-bkpdirs
find / -xdev -maxdepth 4 -type d \( -name 'backups' -o -name 'backup' \) \
     -not -path '/proc/*' -not -path '/sys/*' -not -path '/var/lib/docker/*' \
     2>/dev/null | head -8 > "$BKPLIST"
pre "$(cat "$BKPLIST")"
SRC_D=$(findmnt -no SOURCE --target /mnt/data 2>/dev/null)
while IFS= read -r b; do
  [ -d "$b" ] || continue
  SRC_B=$(findmnt -no SOURCE --target "$b" 2>/dev/null)
  printf '* `%s` → urządzenie `%s` (rozmiar: %s)\n' "$b" "${SRC_B:-?}" "$(du -sh "$b" 2>/dev/null | cut -f1)"
  if [ -n "$SRC_B" ] && [ -n "$SRC_D" ] && [ "$SRC_B" = "$SRC_D" ]; then
    chk FAIL P1-321 "Backupy ($b) leżą na TYM SAMYM urządzeniu co dane ($SRC_B) — złamana zasada 3-2-1 (P1 audytu)"
  fi
done < "$BKPLIST"

# =============================================================================
hdr "4. Docker — stos usług"
# =============================================================================
if ! have docker; then
  chk FAIL DOCKER "Brak Dockera"
else
  kv "Docker" "$(run docker --version)"
  sub "Kontenery"
  pre "$(dq ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}')"

  sub "Które usługi z dokumentacji faktycznie stoją"
  for s in ollama n8n postgres qdrant nextcloud vikunja paperless whisper openwebui redis; do
    N=$(dq ps -a --format '{{.Names}} {{.Image}}' | grep -i "$s" | head -1)
    if [ -n "$N" ]; then
      ST=$(dq ps --format '{{.Names}} {{.Status}}' | grep -i "$s" | head -1)
      printf '* **%s** — %s\n' "$s" "${ST:-ZATRZYMANY ($N)}"
    else
      printf '* **%s** — BRAK\n' "$s"
    fi
  done

  sub "Restart policy + przypięcie wersji"
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
  LATEST_COUNT=$(dq ps -a --format '{{.Image}}' | grep -c ':latest' || true)
  [ "${LATEST_COUNT:-0}" -gt 0 ] && chk FAIL DOCK-PIN "$LATEST_COUNT obrazów na :latest — brak kontroli nad aktualizacjami"

  sub "Wolumeny i rozmiary"
  pre "$(run docker system df -v | head -80)"

  sub "Pliki compose"
  pre "$(run find /opt /home /root /srv -maxdepth 4 -name 'docker-compose*.y*ml' -o -maxdepth 4 -name 'compose.y*ml' 2>/dev/null | sort)"
fi

# =============================================================================
hdr "5. Ollama i modele (audyt §6 — układ VRAM)"
# =============================================================================
OLL=$(dq ps --format '{{.Names}}' | grep -i ollama | head -1)
if [ -n "$OLL" ]; then
  chk OK OLL-RUN "Ollama działa jako '$OLL'"
  sub "Zmienne środowiskowe Ollamy"
  ENVS=$(run docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$OLL" | grep -i ollama)
  pre "$ENVS"
  KA=$(printf '%s' "$ENVS" | grep -i KEEP_ALIVE | cut -d= -f2)
  ML=$(printf '%s' "$ENVS" | grep -i MAX_LOADED | cut -d= -f2)
  kv "OLLAMA_KEEP_ALIVE" "${KA:-domyślne (5m)}"
  kv "OLLAMA_MAX_LOADED_MODELS" "${ML:-domyślne}"
  case "$KA" in
    -1|-1s) chk OK OLL-KA "KEEP_ALIVE=-1 — modele nie wypadają, zero zimnych startów (plan wariantu A)" ;;
    "")     chk FAIL OLL-KA "KEEP_ALIVE nieustawione — zimne starty przy głosie" ;;
    *)      chk FAIL OLL-KA "KEEP_ALIVE=$KA — po upgradzie GPU ustaw -1 (audyt §6)" ;;
  esac
  sub "Zainstalowane modele"
  pre "$(run docker exec "$OLL" ollama list)"
  sub "Modele obecnie w VRAM"
  pre "$(run docker exec "$OLL" ollama ps)"
  MODELS=$(run docker exec "$OLL" ollama list)
  printf '%s' "$MODELS" | grep -qi 'qwen3:8b'  && chk OK  MODEL-QWEN8 "qwen3:8b obecny (wariant A)" || chk FAIL MODEL-QWEN8 "Brak qwen3:8b — docelowy model wariantu A niepobrany"
  printf '%s' "$MODELS" | grep -qi 'bielik'    && chk INFO MODEL-BIELIK "Bielik obecny"
  printf '%s' "$MODELS" | grep -qi 'minilm'    && chk OK  MODEL-EMB "all-minilm obecny (kolekcja Qdrant 384-dim musi zostać!)" || chk FAIL MODEL-EMB "Brak all-minilm — embeddingi RAG nie ruszą"
  printf '%s' "$MODELS" | grep -qi 'qwen3:4b'  && chk INFO MODEL-QWEN4 "qwen3:4b nadal obecny — po przejściu na 8b można skasować (uproszczenie z §6)"
  printf '%s' "$MODELS" | grep -qiE 'vl|vision' && chk INFO MODEL-VL "Model multimodalny obecny"
else
  chk FAIL OLL-RUN "Kontener Ollamy nie działa"
fi
sub "API Ollamy"
pre "$(jget http://localhost:11434/api/tags | head -c 2000)"

# =============================================================================
hdr "6. Whisper / STT (CPU czy GPU?)"
# =============================================================================
WSP=$(dq ps --format '{{.Names}}' | grep -iE 'whisper|asr' | head -1)
if [ -n "$WSP" ]; then
  kv "Kontener" "$WSP"
  WENV=$(run docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WSP" | grep -iE 'ASR|MODEL|DEVICE|COMPUTE')
  pre "$WENV"
  GPUREQ=$(run docker inspect -f '{{json .HostConfig.DeviceRequests}}' "$WSP")
  kv "DeviceRequests (GPU)" "$GPUREQ"
  if printf '%s' "$GPUREQ" | grep -q 'nvidia\|gpu'; then
    chk OK STT-GPU "Whisper ma przydzielone GPU (§6 zrealizowane)"
  else
    chk FAIL STT-GPU "Whisper leci na CPU — po upgradzie na 1070 Ti przenieś na GPU (faster-whisper small/medium int8_float16)"
  fi
  printf '%s' "$WENV" | grep -qi 'faster_whisper' && chk OK STT-ENGINE "ASR_ENGINE=faster_whisper" || chk FAIL STT-ENGINE "ASR_ENGINE nie ustawione na faster_whisper"
  kv "Healthcheck /docs" "$(run curl -fsS -m 5 -o /dev/null -w '%{http_code}' http://localhost:9000/docs)"
else
  chk FAIL STT-RUN "Nie widzę kontenera Whisper"
fi

# =============================================================================
hdr "7. n8n"
# =============================================================================
N8N=$(dq ps --format '{{.Names}}' | grep -i n8n | head -1)
if [ -n "$N8N" ]; then
  kv "Kontener" "$N8N"
  kv "Obraz" "$(run docker inspect -f '{{.Config.Image}}' "$N8N")"
  kv "/healthz" "$(run curl -fsS -m 5 -o /dev/null -w '%{http_code}' http://localhost:5678/healthz)"
  sub "Env (bez sekretów)"
  pre "$(run docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$N8N" | grep -iE 'N8N_|DB_|GENERIC|WEBHOOK|TZ' | sed -E 's/(KEY|PASSWORD|TOKEN|SECRET)=.*/\1=<UKRYTE>/I')"
  ENCKEY=$(run docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$N8N" | grep -c 'N8N_ENCRYPTION_KEY')
  [ "$ENCKEY" -gt 0 ] && chk OK N8N-ENCKEY "N8N_ENCRYPTION_KEY ustawiony jawnie (dobrze — łatwy do zabackupowania)" || chk INFO N8N-ENCKEY "Klucz szyfrujący prawdopodobnie w wolumenie ~/.n8n/config — MUSI być w backupie"
  sub "Liczba workflowów i ich stan (jeśli baza w Postgresie)"
  PGC=$(dq ps --format '{{.Names}}' | grep -iE 'postgres|pgsql' | head -1)
  if [ -n "$PGC" ]; then
    pre "$(run docker exec "$PGC" psql -U postgres -d n8n -c "select active, count(*) from workflow_entity group by active;")"
    pre "$(run docker exec "$PGC" psql -U postgres -d n8n -c "select name, active, updatedAt from workflow_entity order by updatedAt desc limit 20;")"
  fi
else
  chk FAIL N8N-RUN "n8n nie działa"
fi

# =============================================================================
hdr "8. Qdrant — pamięć RAG"
# =============================================================================
QD=$(jget http://localhost:6333/collections)
if [ -n "$QD" ]; then
  chk OK QDR-RUN "Qdrant odpowiada"
  pre "$QD"
  for col in $(printf '%s' "$QD" | grep -o '"name":"[^"]*"' | cut -d'"' -f4); do
    sub "Kolekcja: $col"
    INFO=$(jget "http://localhost:6333/collections/$col")
    pre "$(printf '%s' "$INFO" | head -c 1500)"
    DIM=$(printf '%s' "$INFO" | grep -o '"size":[0-9]*' | head -1 | cut -d: -f2)
    CNT=$(printf '%s' "$INFO" | grep -o '"points_count":[0-9]*' | head -1 | cut -d: -f2)
    kv "Wymiar wektora" "${DIM:-?}"
    kv "Liczba punktów" "${CNT:-?}"
    [ "${DIM:-0}" = "384" ] && chk OK QDR-DIM "Kolekcja $col ma 384-dim (zgodne z all-minilm — NIE zmieniaj modelu embeddingów)" || chk INFO QDR-DIM "Kolekcja $col ma wymiar ${DIM:-?}"
    [ "${CNT:-0}" -eq 0 ] 2>/dev/null && chk FAIL QDR-EMPTY "Kolekcja $col jest PUSTA — pamięć nie zapisuje faktów"
  done
else
  chk FAIL QDR-RUN "Qdrant nie odpowiada na :6333"
fi

# =============================================================================
hdr "9. Backupy — co realnie działa (audyt P1, roadmapa #1)"
# =============================================================================
have restic && kv "restic" "$(run restic version)" || chk FAIL P1-RESTIC "Brak restic — offsite backup niewdrożony (roadmapa #1)"
have rclone && kv "rclone" "$(run rclone version | head -1)"

sub "Skrypty backupowe"
BSLIST=/tmp/.jarvis-audit-bscripts
find /opt /root /usr/local/bin /home /etc -maxdepth 4 -type f -name '*backup*' 2>/dev/null | head -20 > "$BSLIST"
pre "$(cat "$BSLIST")"

while IFS= read -r f; do
  case "$f" in *.sh)
    sub "Analiza: $f"
    kv "Ostatnia modyfikacja" "$(run stat -c '%y' "$f")"
    grep -q 'restic\|rclone\|b2:\|s3:\|sftp:' "$f" 2>/dev/null \
      && chk OK  "P1-OFFSITE" "$f zawiera push offsite (restic/rclone/sftp)" \
      || chk FAIL "P1-OFFSITE" "$f NIE wypycha kopii poza serwer — punkt 1 roadmapy niezrobiony"
    grep -q 'jarvis-no-autoshutdown' "$f" 2>/dev/null \
      && chk OK  "P2-LOCKFILE" "$f zakłada lockfile idle-shutdown" \
      || chk FAIL "P2-LOCKFILE" "$f NIE zakłada /etc/jarvis-no-autoshutdown — wyścig z idle-shutdown (roadmapa #3)"
    grep -qE 'trap .*EXIT' "$f" 2>/dev/null \
      && chk OK  "P2-TRAP" "$f ma trap EXIT (sprzątanie)" \
      || chk FAIL "P2-TRAP" "$f nie ma trap EXIT"
    grep -qiE 'healthcheck|discord|webhook|ntfy|curl.*hc-ping' "$f" 2>/dev/null \
      && chk OK  "P1-ALERT" "$f alarmuje o niepowodzeniu" \
      || chk FAIL "P1-ALERT" "$f cicho zawodzi — brak alertu przy błędzie (roadmapa #1)"
    grep -qiE 'n8n.*(encryption|config)|ENCRYPTION_KEY' "$f" 2>/dev/null \
      && chk OK  "BKP-N8NKEY" "$f obejmuje klucz szyfrujący n8n" \
      || chk INFO "BKP-N8NKEY" "Sprawdź czy $f backupuje klucz n8n (bez niego dump bazy jest bezużyteczny)"
    grep -qiE 'forget|prune|retention|mtime \+|keep-daily' "$f" 2>/dev/null \
      && chk OK  "BKP-RETENCJA" "$f ma politykę retencji" \
      || chk FAIL "BKP-RETENCJA" "$f nie kasuje starych kopii — dysk się zapełni"
    grep -qiE 'malinka|raspberry|\bpi@|rpi' "$f" 2>/dev/null \
      && chk OK  "BKP-PI" "$f obejmuje malinkę" \
      || chk FAIL "BKP-PI" "$f NIE backupuje malinki — Pi to niezabezpieczony SPOF"
    sub "Treść (pierwsze 80 linii)"
    pre "$(head -80 "$f" 2>/dev/null | sed -E 's/(PASS|TOKEN|KEY|SECRET)[A-Z_]*=.*/\1=<UKRYTE>/I')"
  ;; esac
done < "$BSLIST"
[ -s "$BSLIST" ] || chk FAIL BKP-NONE "Nie znalazłem ŻADNEGO skryptu backupu na serwerze"
rm -f "$BSLIST"

sub "Repozytoria restic"
pre "$(run find / -maxdepth 5 -type d -name 'restic*' -not -path '*/proc/*' 2>/dev/null | head -20)"
sub "Ostatnie pliki w katalogach backupowych (czy w ogóle są świeże?)"
while IFS= read -r b; do
  [ -d "$b" ] || continue
  printf '**%s**\n' "$b"
  pre "$(find "$b" -maxdepth 2 -type f -printf '%TY-%Tm-%Td %TH:%TM  %10s  %p\n' 2>/dev/null | sort -r | head -15)"
  NEWEST=$(find "$b" -type f -mtime -2 2>/dev/null | head -1)
  [ -n "$NEWEST" ] && chk OK BKP-FRESH "W $b są pliki młodsze niż 48h" || chk FAIL BKP-FRESH "W $b BRAK plików z ostatnich 48h — backup prawdopodobnie nie działa!"
  OLD=$(find "$b" -type f -mtime +31 2>/dev/null | wc -l)
  [ "${OLD:-0}" -gt 0 ] && chk FAIL BKP-OLD "$OLD plików starszych niż 31 dni w $b — brak czyszczenia retencji"
done < "$BKPLIST"
rm -f "$BKPLIST"

# =============================================================================
hdr "10. Idle-shutdown / WoL / zarządzanie mocą"
# =============================================================================
sub "Skrypty idle-shutdown"
ISHLIST=/tmp/.jarvis-audit-idle
find /opt /usr/local/bin /root -maxdepth 4 -type f \( -name '*idle*' -o -name '*shutdown*' -o -name '*power*' \) 2>/dev/null | head -20 > "$ISHLIST"
pre "$(cat "$ISHLIST")"
while IFS= read -r f; do
  case "$f" in *.sh)
    sub "Treść: $f"
    pre "$(run cat "$f")"
    grep -q 'jarvis-no-autoshutdown' "$f" 2>/dev/null \
      && chk OK P2-LOCKHONOR "$f respektuje lockfile" \
      || chk FAIL P2-LOCKHONOR "$f NIE sprawdza /etc/jarvis-no-autoshutdown — kontrakt z roadmapy #3 niepełny"
    grep -qi 'nvidia-smi\|utilization' "$f" 2>/dev/null \
      && chk OK POW-GPUCHK "$f patrzy na obciążenie GPU" \
      || chk INFO POW-GPUCHK "$f nie sprawdza GPU util"
  ;; esac
done < "$ISHLIST"
rm -f "$ISHLIST"
kv "Lockfile obecny teraz" "$([ -e "$LOCK" ] && echo TAK || echo nie)"

sub "Wake-on-LAN"
for i in $(ls /sys/class/net | grep -vE '^(lo|docker|br-|veth|tailscale|ifb|dummy|bond)'); do
  W=$(run ethtool "$i" | grep -E 'Wake-on|Supports Wake')
  printf '* **%s** — %s\n' "$i" "$(printf '%s' "$W" | tr '\n' ' ')"
  printf '%s' "$W" | grep -q 'Wake-on: g' && chk OK WOL-ON "WoL aktywny na $i" || chk FAIL WOL-ON "WoL NIE aktywny na $i (Wake-on powinno być 'g') — po restarcie znika, potrzebny systemd unit"
done
sub "Czy WoL jest utrwalone (przeżywa reboot)?"
pre "$(run grep -rl 'wol\|WakeOnLan' /etc/systemd/network /etc/network/interfaces.d /etc/systemd/system 2>/dev/null)"

# =============================================================================
hdr "11. Bezpieczeństwo SSH — dostęp bota (audyt P1)"
# =============================================================================
pre "$(run sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|port|allowusers)')"
sub "authorized_keys — forced command?"
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -f "$f" ] || continue
  printf '**%s** (%s wpisów)\n' "$f" "$(grep -c '^ssh-\|^command=' "$f" 2>/dev/null)"
  pre "$(run sed -E 's/(ssh-[a-z0-9]+ )[A-Za-z0-9+\/=]{20,}/\1<KLUCZ>/g' "$f")"
done
if grep -qs 'command=' /root/.ssh/authorized_keys; then
  chk FAIL P1-ROOTKEY "W /root/.ssh/authorized_keys jest forced command, ale to nadal klucz do ROOTA — przenieś na dedykowanego usera (roadmapa #2)"
elif [ -s /root/.ssh/authorized_keys ]; then
  chk FAIL P1-ROOTKEY "Klucz do root@serwer bez forced command — dokładnie problem P1 z audytu, największa powierzchnia ataku"
else
  chk OK P1-ROOTKEY "Brak kluczy w /root/.ssh/authorized_keys"
fi
if grep -qs 'command=' /home/*/.ssh/authorized_keys 2>/dev/null; then
  chk OK P1-FORCED "Dedykowany user z forced command istnieje"
  pre "$(run grep -h 'command=' /home/*/.ssh/authorized_keys | sed -E 's/(ssh-[a-z0-9]+ )[A-Za-z0-9+\/=]{20,}/\1<KLUCZ>/g')"
else
  chk FAIL P1-FORCED "Brak usera z forced command — punkt 2 roadmapy niezrealizowany"
fi
sub "Ostatnie logowania"
pre "$(run last -n 15)"
sub "Nieudane logowania SSH (ostatnie 24h)"
pre "$(run journalctl -u ssh -u sshd --since '24 hours ago' --no-pager | grep -i 'failed\|invalid' | tail -15)"

# =============================================================================
hdr "12. Automatyzacja: cron, timery"
# =============================================================================
sub "Crontab roota"
pre "$(run crontab -l)"
sub "/etc/cron.d"
pre "$(run grep -rvE '^\s*(#|$)' /etc/cron.d/ 2>/dev/null)"
sub "Timery systemd"
pre "$(run systemctl list-timers --all --no-pager)"

# =============================================================================
hdr "13. Sieć i porty"
# =============================================================================
kv "IP" "$(run hostname -I)"
for i in $(ls /sys/class/net | grep -vE '^(lo|docker|br-|veth|tailscale|ifb|dummy|bond)'); do
  kv "MAC $i (do WoL)" "$(cat /sys/class/net/"$i"/address 2>/dev/null)"
done
pre "$(run ss -tulpn | grep LISTEN)"
have tailscale && pre "$(run tailscale status --peers=false | head -5)"

# =============================================================================
hdr "14. Aktualizacje i higiena"
# =============================================================================
kv "unattended-upgrades" "$(run systemctl is-enabled unattended-upgrades 2>/dev/null)"
kv "Pakiety do aktualizacji" "$(run apt list --upgradable 2>/dev/null | grep -c upgradable)"
kv "Reboot wymagany" "$([ -f /var/run/reboot-required ] && echo TAK || echo nie)"
kv "Śmieci Dockera" "$(run docker system df | tail -4 | tr '\n' ' ')"

# =============================================================================
hdr "PODSUMOWANIE — checklista"
# =============================================================================
printf '\n'
if [ "${#OUT_SUMMARY[@]}" -gt 0 ]; then
  printf '%s\n' "${OUT_SUMMARY[@]}" | sed 's/^/- /'
fi
printf '\n\n**Legenda:** `[OK]` zrobione · `[!!]` brak lub ryzyko · `[??]` nie dało się stwierdzić · `[i ]` informacja\n'
printf '\n_Koniec raportu SERWER — %s_\n' "$(date -Is)"
