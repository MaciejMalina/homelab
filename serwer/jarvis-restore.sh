#!/usr/bin/env bash
# =============================================================================
#  JARVIS — odtworzenie node'a z backupu konfiguracji (serwer/backup.sh)
#  Na serwerze: /opt/jarvis/scripts/jarvis-restore.sh; kopia jest też w KAŻDYM
#  katalogu backupu (/mnt/telemetry/backups/jarvis-config/<data>/).
# =============================================================================
#  Użycie — na ŚWIEŻO zainstalowanym systemie, jako root:
#     sudo bash jarvis-restore.sh <serwer|malinka> <katalog_backupu>
#
#  Przed uruchomieniem:
#   - ten sam system co w backupie (serwer: Debian, malinka: Raspberry Pi OS,
#     ta sama wersja — patrz "### os" w <node>-meta.txt),
#   - przy instalacji utworzony user 'macmal' (UID 1000), sieć działa,
#   - serwer: podłączone dyski RAID1 (md0) i /mnt/telemetry,
#   - katalog backupu skopiowany na maszynę (malinka: scp z serwera).
#
#  Co robi: użytkownicy -> repozytoria APT + pakiety -> /home /root /opt
#  /usr/local/bin crontaby wolumeny Dockera stan Tailscale -> wybrane pliki /etc
#  -> fstab/RAID -> usługi i timery -> docker compose up dla każdego projektu.
#  Czego NIE robi automatycznie (wypisze na końcu): hasła userów, konfiguracja
#  sieci, cmdline.txt malinki, import dumpów baz (tylko gdy padł RAID).
# =============================================================================
set -uo pipefail
export LC_ALL=C DEBIAN_FRONTEND=noninteractive

NODE="${1:-}"; SRC="${2:-}"
[ "$(id -u)" -eq 0 ] || { echo "Uruchom jako root (sudo)."; exit 1; }
case "$NODE" in serwer|malinka) ;; *) echo "Użycie: $0 <serwer|malinka> <katalog_backupu>"; exit 2 ;; esac
SRC="${SRC%/}"
ARCH="$SRC/$NODE-config.tar.gz"
META="$SRC/$NODE-meta.txt"
[ -f "$ARCH" ] || { echo "Brak $ARCH"; exit 2; }

WARN=()
step() { printf '\n=== %s ===\n' "$*"; }
warn() { echo "UWAGA: $*"; WARN+=("$*"); }
pyt()  { local a; read -r -p "$1 [wpisz TAK] " a; [ "$a" = TAK ]; }

grep -q '^OK' "$SRC/STATUS" 2>/dev/null || warn "STATUS backupu nie jest OK: $(head -1 "$SRC/STATUS" 2>/dev/null || echo brak)"
OLD_OS=$(awk '/^### os/{f=1;next} /^### /{f=0} f' "$META" 2>/dev/null | grep -m1 '^VERSION_CODENAME=' | cut -d= -f2)
NEW_OS=$(. /etc/os-release; echo "${VERSION_CODENAME:-?}")
if [ -n "$OLD_OS" ] && [ "$OLD_OS" != "$NEW_OS" ]; then
  echo "System w backupie: $OLD_OS, ten system: $NEW_OS — lista pakietów i configi mogą nie pasować."
  pyt "Kontynuować mimo to?" || exit 1
fi
echo "Odtwarzam '$NODE' z $SRC. Nadpisze /home, /root, /opt, /usr/local/bin, crontaby, wybrane pliki /etc."
pyt "Kontynuować?" || exit 1

STAGE=/root/jarvis-restore/$NODE

# -----------------------------------------------------------------------------
step "1. Rozpakowuję archiwum do $STAGE"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -C "$STAGE" --numeric-owner -xzf "$ARCH" || { echo "Błąd rozpakowania"; exit 1; }

# -----------------------------------------------------------------------------
step "2. Użytkownicy z backupu (UID 1000-59999)"
while IFS=: read -r name _ uid gid _ home shell; do
  [ "$uid" -ge 1000 ] 2>/dev/null && [ "$uid" -lt 60000 ] || continue
  if ! id "$name" >/dev/null 2>&1; then
    getent group "$gid" >/dev/null || groupadd -g "$gid" "$name"
    useradd -u "$uid" -g "$gid" -d "$home" -s "$shell" -M "$name" && echo "utworzono $name (UID $uid)"
  elif [ "$(id -u "$name")" != "$uid" ]; then
    warn "$name ma UID $(id -u "$name"), w backupie $uid — właściciele plików się nie zgodzą"
  fi
done < "$STAGE/etc/passwd"

# -----------------------------------------------------------------------------
step "3. Repozytoria APT i pakiety"
for d in etc/apt/sources.list.d etc/apt/keyrings usr/share/keyrings; do
  [ -d "$STAGE/$d" ] && mkdir -p "/$d" && cp -a "$STAGE/$d/." "/$d/"
done
apt-get update || warn "apt-get update z błędami (repozytorium z backupu może nie pasować)"
SEL=/root/jarvis-restore/$NODE-dpkg.txt
if [ "$NODE" = serwer ]; then cp -f "$SRC/serwer-dpkg.txt" "$SEL" 2>/dev/null
else awk '/^### dpkg/{f=1;next} /^### /{f=0} f' "$META" > "$SEL"; fi
if [ -s "$SEL" ]; then
  apt-cache dumpavail > /tmp/jarvis-avail && dpkg --merge-avail /tmp/jarvis-avail >/dev/null 2>&1
  dpkg --set-selections < "$SEL" 2>/dev/null
  apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dselect-upgrade \
    || warn "instalacja pakietów z błędami — sprawdź 'apt-get -f install'"
else
  warn "brak listy pakietów — doinstaluj ręcznie"
fi
if ! command -v docker >/dev/null; then
  echo "Brak Dockera — instaluję z get.docker.com"
  curl -fsSL https://get.docker.com | sh || warn "instalacja Dockera nie powiodła się"
fi

# -----------------------------------------------------------------------------
step "4. Pliki: /home /root /opt /usr/local/bin crontaby wolumeny Dockera Tailscale"
systemctl stop docker.socket docker containerd tailscaled 2>/dev/null
for d in home root opt usr/local/bin var/spool/cron/crontabs var/lib/docker/volumes var/lib/tailscale; do
  [ -e "$STAGE/$d" ] || continue
  mkdir -p "/$d" && cp -a "$STAGE/$d/." "/$d/" && echo "  /$d"
done
if [ "$NODE" = malinka ] && [ -f "$STAGE/boot/firmware/config.txt" ]; then
  cp -a /boot/firmware/config.txt /boot/firmware/config.txt.przed-restore 2>/dev/null
  cp -a "$STAGE/boot/firmware/config.txt" /boot/firmware/config.txt && echo "  /boot/firmware/config.txt"
  # cmdline.txt CELOWO nie — zawiera PARTUUID starego nośnika, na nowym dysku system by nie wstał
fi

# -----------------------------------------------------------------------------
step "5. Wybrane pliki /etc"
ETC_ITEMS=(hostname hosts timezone localtime ssh sudoers.d jarvis cron.d docker fail2ban
           log2ram.conf smartd.conf default/smartmontools mdadm
           apt/apt.conf.d/50unattended-upgrades apt/apt.conf.d/20auto-upgrades
           systemd/journald.conf.d)
for i in "${ETC_ITEMS[@]}"; do
  [ -e "$STAGE/etc/$i" ] || continue
  mkdir -p "/etc/$(dirname "$i")" && cp -a "$STAGE/etc/$i" "/etc/$(dirname "$i")/" && echo "  /etc/$i"
done
for f in "$STAGE"/etc/systemd/system/jarvis*; do
  [ -e "$f" ] && cp -a "$f" /etc/systemd/system/ && echo "  /etc/systemd/system/$(basename "$f")"
done
visudo -c >/dev/null || { warn "sudoers z backupu ma błąd składni — usuwam przywrócone /etc/sudoers.d/jarvis*";
                          rm -f /etc/sudoers.d/jarvis*; }
# grupy (docker, sudo, adm...) dla userów z backupu
while IFS=: read -r grp _ _ members; do
  [ -n "$members" ] && getent group "$grp" >/dev/null || continue
  for u in ${members//,/ }; do id "$u" >/dev/null 2>&1 && usermod -aG "$grp" "$u"; done
done < "$STAGE/etc/group"

# -----------------------------------------------------------------------------
step "6. Dyski (fstab$( [ "$NODE" = serwer ] && echo ', RAID1'))"
if [ "$NODE" = serwer ]; then
  mdadm --assemble --scan 2>/dev/null
  grep -q md0 /proc/mdstat && echo "  RAID1 md0: $(grep -A1 '^md0' /proc/mdstat | tail -1 | xargs)" \
                           || warn "RAID md0 się nie złożył — sprawdź 'mdadm --assemble --scan' i dyski"
  command -v update-initramfs >/dev/null && update-initramfs -u >/dev/null 2>&1
fi
while read -r spec mp rest; do
  grep -qE "^[^#]*[[:space:]]$mp[[:space:]]" /etc/fstab && continue
  dev=""
  case "$spec" in
    UUID=*)  dev=$(blkid -U "${spec#UUID=}" 2>/dev/null) ;;
    LABEL=*) dev=$(blkid -L "${spec#LABEL=}" 2>/dev/null) ;;
    /dev/*)  [ -b "$spec" ] && dev="$spec" ;;
  esac
  if [ -n "$dev" ]; then
    echo "$spec $mp $rest" >> /etc/fstab && mkdir -p "$mp" && echo "  dodano do fstab: $mp ($dev)"
  else
    warn "nie znalazłem urządzenia $spec dla $mp — dopisz do /etc/fstab ręcznie"
  fi
done < <(grep -E '^[^#].*[[:space:]]/mnt/' "$STAGE/etc/fstab")
systemctl daemon-reload
mount -a || warn "mount -a zgłosił błąd"

# -----------------------------------------------------------------------------
step "7. Usługi i timery"
systemctl enable --now containerd docker >/dev/null 2>&1 || warn "Docker nie wystartował"
systemctl enable --now tailscaled >/dev/null 2>&1 && echo "  tailscaled (stan z backupu — ta sama nazwa/IP w tailnecie)"
if sshd -t 2>/dev/null; then systemctl restart ssh; echo "  ssh"; else warn "sshd -t: błąd configu SSH — NIE restartuję ssh"; fi
systemctl restart cron
command -v fail2ban-client >/dev/null && systemctl enable --now fail2ban >/dev/null 2>&1 && echo "  fail2ban"
for t in /etc/systemd/system/jarvis*.timer; do
  [ -e "$t" ] && systemctl enable --now "$(basename "$t")" >/dev/null 2>&1 && echo "  $(basename "$t")"
done

# -----------------------------------------------------------------------------
step "8. Kontenery (docker compose up)"
if [ "$NODE" = serwer ]; then
  mapfile -t FILES < <(awk '/^### compose-files/{f=1;next} /^### /{f=0} f' "$META" | grep -v '^$')
else
  mapfile -t FILES < <(find /home/macmal /opt -maxdepth 3 -name 'docker-compose.y*ml' 2>/dev/null \
                       | grep -v '/node_modules/' | sort | awk '/adguardhome/{print; next} {r=r $0 "\n"} END{printf "%s", r}')
fi
# projekty swiadomie wylaczone (znacznik .jarvis-disabled w katalogu) pomijamy
AKTYWNE=()
for f in "${FILES[@]}"; do
  if [ -e "$(dirname "$f")/.jarvis-disabled" ]; then echo "  (pomijam, wylaczony: $(dirname "$f"))"
  else AKTYWNE+=("$f"); fi
done
FILES=("${AKTYWNE[@]}")
printf '  %s\n' "${FILES[@]}"
if [ "${#FILES[@]}" -gt 0 ] && pyt "Uruchomić te projekty?"; then
  for f in "${FILES[@]}"; do
    [ -f "$f" ] || { warn "brak $f"; continue; }
    echo "--> $(dirname "$f")"
    ( cd "$(dirname "$f")" && docker compose -f "$(basename "$f")" up -d --build ) || warn "compose up nieudany: $f"
  done
fi

# -----------------------------------------------------------------------------
step "PODSUMOWANIE"
if [ "${#WARN[@]}" -gt 0 ]; then printf 'Ostrzeżenia:\n'; printf -- '- %s\n' "${WARN[@]}"; else echo "Bez ostrzeżeń."; fi
cat <<TXT

Do zrobienia ręcznie:
 - hasła nie są w backupie: 'passwd macmal' (logowanie SSH kluczem działa od razu)
 - sieć (stały IP/rezerwacja DHCP) — stary config do podejrzenia w $STAGE/etc
   (NetworkManager/, network/, dhcpcd.conf)
 - 'docker ps' — czy wszystko wstało; 'tailscale status' — czy node jest zalogowany
TXT
if [ "$NODE" = malinka ]; then cat <<TXT
 - stary cmdline.txt do porównania: $STAGE/boot/firmware/cmdline.txt (NIE kopiuj 1:1 — PARTUUID)
TXT
else cat <<TXT
 - dumpy baz importuj TYLKO gdy dane na RAID-zie zginęły (inaczej bazy już tam są):
     gunzip -c $SRC/db/postgres_jarvis_db.sql.gz | docker exec -i backend_postgres psql -U jarvis -d jarvis_db
     gunzip -c $SRC/db/paperless_db.sql.gz      | docker exec -i paperless_db psql -U paperless paperless
     gunzip -c $SRC/db/nextcloud_db.sql.gz      | docker exec -i nextcloud_db sh -c 'exec mariadb -uroot -p"\${MARIADB_ROOT_PASSWORD:-\$MYSQL_ROOT_PASSWORD}" nextcloud'
     tar -C /mnt/data -xzf $SRC/db/n8n_config.tar.gz
     tar -C /mnt/data/vikunja -xzf $SRC/db/vikunja_db.tar.gz
     tar -C /mnt/data/nextcloud/html -xzf $SRC/db/nextcloud_config.tar.gz
TXT
fi
