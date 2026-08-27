# JARVIS — paczka wdrożeniowa, sierpień 2026 (na czas oczekiwania na SSD)

Kolejność w tej paczce odpowiada Twojej liście: robimy to, co nie czeka na
dysk, sekrety+git zostają na koniec.

## 0. Kolejność sugerowana

1. **SSH hardening** (`common/setup-ssh-hardening.sh`) — na obu maszynach.
   Zrób to PIERWSZE, ale ostrożnie — skrypt sam sprawdza, czy masz jak wejść
   bez roota, i odmawia, jeśli nie. Mimo to: otwórz dwa terminale, nie
   zamykaj starej sesji, dopóki nie zweryfikujesz nowej.
2. **Odkrycie użycia klucza bota** (`serwer/discover-bot-ssh-usage.sh`) —
   zainstaluj TERAZ, zbieraj kilka dni, dopiero potem rób cutover na
   `jarvis-power-agent.sh`. To jedyny punkt na liście, który naturalnie nie
   kończy się dziś — reszta jest niezależna, możesz robić równolegle.
3. **smartmontools** (`common/setup-smartmontools.sh`) — na obu maszynach.
4. **log2ram** (`malinka/setup-log2ram.sh`) — tylko malinka, kończy się
   restartem.
5. **unattended-upgrades** (`common/setup-unattended-upgrades.sh`) — na obu
   maszynach, reboot 22:00.
6. **Backup malinki** — wdrożenie wg `serwer/systemd/README-instalacja.md`
   (bez zmian w kolejności kroków), ale z podmienionym
   `serwer/backup-malinka.env` (już wskazuje na `/mnt/telemetry`).
7. **Trot na malince** — `docs/JARVIS-trot-wdrozenie.md`, po powyższych, żeby
   nie dokładać RAM-u w środku zmian na malince.
8. Na koniec, jak było ustalone: sekrety do sops + repo git.

## 1. Backup 3-2-1 na serwerze — co jest zrobione, a czego szukamy

`backup-malinka.env` w tej paczce **już** celuje w `/mnt/telemetry` zamiast
`/mnt/data` — to załatwia 3-2-1 dla backupu MALINKI (rozdzielenie od głównej
macierzy serwera). Zainstaluj wg `README-instalacja.md` bez zmian w krokach,
tylko z tym env-em.

To, czego NIE mam i nie umiem stąd znaleźć: skrypt, który backupuje WŁASNE
dane serwera (Postgres, n8n, Nextcloud — ten sprzed lipcowego audytu, gdzie
P1 mówił "/mnt/data/backups leży na tej samej macierzy co dane"). Skoro nie
wiesz, gdzie go szukać — odpal to na serwerze, żeby go znaleźć:

```bash
# cron roota — najbardziej prawdopodobne miejsce
sudo crontab -l

# systemd timery
systemctl list-timers --all | grep -i backup

# szukaj po nazwie/treści w typowych miejscach
sudo find /opt /usr/local/bin /root -maxdepth 3 -iname '*backup*' 2>/dev/null
sudo grep -rl 'pg_dump\|restic\|rsync.*backup' /opt /usr/local/bin /etc/cron* 2>/dev/null
```

Jak znajdziesz plik — podeślij mi ścieżkę albo treść, dopiszę mu gałąź zapisu
na `/mnt/telemetry` (analogicznie do tego, co zrobiłem dla malinki). Jeśli
naprawdę nic się nie znajdzie — to znaczy, że P1 z lipcowego audytu wciąż
czeka, i backup danych serwera trzeba napisać od zera (osobny temat, większy
niż "podmień ścieżkę").

## 2. Klucz bota — dlaczego dwa skrypty, nie jeden

Potwierdziłeś tylko `poweroff`, ale nie jesteś pewien, czy to wszystko.
Zrobiłem to w dwóch krokach zamiast zgadywać:

- `discover-bot-ssh-usage.sh` — wchodzi na MIEJSCE dzisiejszego klucza roota
  (nie zastępuje go, tylko dopisuje logowanie) i przez kilka dni zbiera do
  `/var/log/jarvis-bot-ssh-discovery.log` każde polecenie, jakie bot faktycznie
  wysyła. Zero ryzyka — bot działa dokładnie tak jak dziś, tylko podglądamy.
- `jarvis-power-agent.sh` — docelowy, ograniczony agent (dziś tylko
  `poweroff` na białej liście). Podłączasz go i przełączasz klucz bota
  DOPIERO gdy log z podsłuchu potwierdzi, że nic więcej nie jest potrzebne
  (albo dopiszesz brakujące polecenia po wzorze w skrypcie).

Szybszy skrót, jeśli wolisz nie czekać kilku dni: sprawdź w źródle bota / w
workflow n8n, jakie polecenie SSH jest wpisane wprost:

```bash
# jeśli bot to kontener — wejdź i poszukaj w kodzie
docker exec -it <kontener-bota> grep -r 'ssh ' /app 2>/dev/null

# jeśli sterowanie idzie przez n8n — otwórz workflow z węzłem SSH/Execute
# Command w edytorze n8n i zobacz dokładnie, co jest wpisane w polu Command
```

## 3. Co zrobić z materiałami w tej paczce

```
common/
  setup-ssh-hardening.sh         # oba: PermitRootLogin no, PasswordAuthentication no
  setup-smartmontools.sh         # oba: smartmontools + smartd + alert Discord
  setup-unattended-upgrades.sh   # oba: auto-upgrade + reboot 22:00

malinka/
  setup-log2ram.sh               # tylko malinka
  trot/docker-compose.yml        # appka tartaku, port 3010

serwer/
  jarvis-power-agent.sh          # docelowy forced-command agent (poweroff)
  authorized_keys-power.example  # wzór wpisu dla klucza bota
  discover-bot-ssh-usage.sh      # tymczasowy podsłuch PRZED cutoverem
  backup-malinka.env             # zaktualizowany: DEST_ROOT/RESTIC na /mnt/telemetry

docs/
  JARVIS-trot-wdrozenie.md               # appka tartaku krok po kroku
  JARVIS-wdrozenie-sierpien-2026.md      # ten plik
```

Wszystkie `setup-*.sh` są idempotentne (można puścić drugi raz bez szkody) i
kończą się sekcją weryfikacji — wklej mi output, jeśli coś nie wygląda jak
powinno.
