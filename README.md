# JARVIS — paczka: audyt stanu, backup malinki, sterowanie LED, hardening, trot

Wszystko po polsku, komentarze w skryptach też. Skrypty audytowe są **czysto
odczytowe** — nic nie instalują i nic nie zmieniają. Skrypty `setup-*` i
`jarvis-power-agent.sh`/`discover-bot-ssh-usage.sh` (dodane 2026-08-25) **instalują
i zmieniają konfigurację** — czytaj komentarz na górze każdego przed uruchomieniem.

## Co gdzie leży

```
common/                          # NOWE (2026-08-25) — identyczne na obu maszynach
  setup-ssh-hardening.sh         # PermitRootLogin no, PasswordAuthentication no
  setup-smartmontools.sh         # smartmontools + smartd + alert Discord
  setup-unattended-upgrades.sh   # auto-upgrade bezpieczeństwa + reboot 22:00

malinka/
  jarvis-audit-malinka.sh      # audyt stanu Raspberry Pi (uruchom pierwszy)
  jarvis-backup-agent.sh       # agent backupu — forced command dla klucza serwera
  authorized_keys.example      # wzór wpisu klucza z ograniczeniami
  setup-log2ram.sh             # NOWE — logi w RAM, zrzut raz dziennie
  trot/docker-compose.yml      # NOWE — appka tartaku dla wujka (port 3010)

serwer/
  jarvis-audit-serwer.sh       # audyt stanu serwera (GPU, Ollama, n8n, Qdrant, backupy)
  backup-malinka.sh            # backup malinki: rsync + restic + obraz, retencja 30 dni
  backup-malinka.env           # ZAKTUALIZOWANE — DEST_ROOT/RESTIC teraz na /mnt/telemetry
  jarvis-prune-backups.sh      # globalne kasowanie kopii starszych niż miesiąc
  jarvis-power-agent.sh        # NOWE — forced-command agent dla klucza bota (dziś: poweroff)
  authorized_keys-power.example # NOWE — wzór wpisu dla klucza bota
  discover-bot-ssh-usage.sh    # NOWE — tymczasowy podsłuch, czego bot używa, przed cutoverem
  systemd/                     # timery + README-instalacja.md (krok po kroku)

led/
  README-esp.md                # elektronika (MOSFET-y, piny), WLED, API
  docker-compose.yml            # kontener z panelem sterowania
  wled-panel/index.html        # panel: włącz/wyłącz, jasność, kolor, presety
  wled-panel/nginx.conf        # proxy do WLED (jeden origin = zero CORS)
  homepage-services.yaml       # fragment do services.yaml Homepage
  n8n-narzedzie-set-light.md   # narzędzie set_light dla agenta

docs/
  JARVIS-storage-i-roadmapa.md         # pendrive vs SSD, backupy 3-2-1, pomysły na rozwój
  JARVIS-trot-wdrozenie.md             # NOWE — appka tartaku krok po kroku
  JARVIS-wdrozenie-sierpien-2026.md    # NOWE — kolejność wdrożenia paczki z 2026-08-25
```

## Krok 1 — audyt (zrób to najpierw, jeśli jeszcze nie robione)

Skopiuj skrypt na każdą maszynę i puść przez `sudo`. Wynik to gotowy Markdown —
wklej go do rozmowy, wtedy dopiero wiadomo, co jest zrobione, a co nie.

```bash
# na malince
chmod +x jarvis-audit-malinka.sh
sudo ./jarvis-audit-malinka.sh | tee /tmp/audyt-malinka.md

# na serwerze
chmod +x jarvis-audit-serwer.sh
sudo ./jarvis-audit-serwer.sh | tee /tmp/audyt-serwer.md
```

Raport kończy się checklistą:

- `[OK]` — zrobione
- `[!!]` — brak albo ryzyko, z odniesieniem do punktu z audytu (P1/P2/P3)
- `[??]` — nie dało się stwierdzić z poziomu skryptu
- `[i ]` — informacja

## Krok 2 — paczka wdrożeniowa sierpień 2026 (dopóki czekasz na SSD)

**Zacznij od `docs/JARVIS-wdrozenie-sierpien-2026.md`** — tam jest sugerowana
kolejność dla `common/*`, `malinka/setup-log2ram.sh`,
`serwer/jarvis-power-agent.sh` + `discover-bot-ssh-usage.sh`, i zaktualizowany
backup malinki.

## Krok 3 — backup malinki

Pełna instrukcja z weryfikacją po każdym kroku: `serwer/systemd/README-instalacja.md`.
W skrócie: klucz i katalogi na serwerze → agent i konto `bkp` na malince →
`backup-malinka.sh test` → `daily` → timery. `backup-malinka.env` w tej paczce
już wskazuje `/mnt/telemetry` zamiast `/mnt/data`.

## Krok 4 — pasek LED

`led/README-esp.md` od elektroniki po kafelek w Homepage.
**Piny GPIO w dokumencie to propozycja** — podeślij zdjęcie płytki, dopiszę
konkretne numery pod Twoje wyprowadzenia.

## Krok 5 — trot (appka tartaku dla wujka)

`docs/JARVIS-trot-wdrozenie.md` — przeniesienie kodu na malinkę, port 3010,
udostępnienie przez Tailscale albo NPM.

## Krok 6 — reszta

`docs/JARVIS-storage-i-roadmapa.md`: SSD vs pendrive, 3-2-1, lista kierunków
rozwoju z oceną nakład/efekt.
