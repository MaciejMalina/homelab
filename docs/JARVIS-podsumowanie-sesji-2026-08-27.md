# JARVIS — podsumowanie sesji 27 sierpnia 2026

Sesja zaczęła się od dokończenia backupu malinki (Kroki 4-6), a rozwinęła w
większy kawałek roboty: naprawę backupu serwera, poważne odkrycie
bezpieczeństwa (Tailscale SSH) i pełny cutover klucza bota Discorda.
Wszystko poniżej jest zrobione i zweryfikowane, chyba że zaznaczono inaczej.

## 1. Backup malinki — dokończenie (Kroki 4-6)

- **Krok 4 (timery na serwerze).** Przyczyna wcześniejszego niepowodzenia
  `cp systemd/...`: cały podkatalog `serwer/systemd/` z paczki nigdy nie
  dotarł na serwer (tylko sam skrypt `backup-malinka.sh`). Naprawione
  ręcznym `scp -r` z Windows, potem `cp` do `/etc/systemd/system/` +
  `daemon-reload` + `enable --now`. Oba timery aktywne.
- **Zmiana harmonogramu (Twoja decyzja):** backup dzienny (rsync+restic)
  przeniesiony z 03:15 na **22:00**. Backup obrazu karty (niedziela) **zostaje
  w nocy ok. 03:40-03:48** celowo — na czas jego trwania Docker na malince
  jest zatrzymany, więc pada AdGuard = DNS całego domu; w nocy nikomu to nie
  przeszkadza, wieczorem by przeszkadzało.
- **Krok 5 (Wake-on-LAN).** MAC serwera: `4c:cc:6a:4a:33:6d` (enp2s0), WoL
  magic packet potwierdzony włączony. Dwa wpisy w cronie roota na malince:
  `45 21 * * *` (przed backupem dziennym) i `0 3 * * *` (zapas przed
  backupem obrazu w niedzielę).
- **Krok 6 (test odtworzenia).** Repo restic:
  `/mnt/telemetry/backups/restic-malinka`, hasło w `/etc/jarvis/restic-pass`.
  Odtworzono `/etc/hostname` ze snapshotu `6cfddd20` — treść poprawna.
- **Nierozwiązane:** unattended-upgrades ma auto-reboot na obu maszynach też
  o 22:00 — potencjalna kolizja z nowym backupem dziennym (tylko w noce, gdy
  akurat jest reboot po aktualizacji). Zgłoszone, jeszcze nie zdecydowane czy
  i jak rozdzielić.

## 2. Backup danych własnych serwera — naprawa

- **Odkryty mechanizm:** stary `nightly-backup.sh` w cronie usera `macmal`
  NA MALINCE (`0 7 * * *` — dlatego długo nie mogliśmy go znaleźć w cronie
  roota), budził serwer i przez SSH jako `root@serwer` **tym samym kluczem co
  bot Discorda** odpalał `/opt/jarvis/scripts/backup.sh`.
- `BACKUP_DIR` w `backup.sh` naprawiony: `/mnt/data/backups` (ta sama macierz
  co dane, P1 audytu) → `/mnt/telemetry/backups/serwer`.
- **Backup był realnie zepsuty od rana 27 sierpnia** — SSH hardening z
  26 sierpnia (`PermitRootLogin no`) zablokował logowanie roota tym kluczem.
- **Naprawa właściwa:** nowy, ograniczony agent `bkptrigger@serwer`
  (forced command, whitelist tylko `ping`/`run`), dedykowany klucz
  wygenerowany na malince — INNY niż klucz bota. `nightly-backup.sh`
  zaktualizowany i wgrany. Po drodze naprawiony dodatkowy bug: `backup.sh`
  nie miał bitu +x. **Pełny test end-to-end — sukces.**

## 3. KRYTYCZNE odkrycie: Tailscale SSH omijał zabezpieczenia

Przy instalacji `bkptrigger` test bezpieczeństwa (`rm -rf /` powinno być
odrzucone) nie zadziałał — połączenie dostało pełną powłokę zamiast
odrzucenia przez whitelistę. Przyczyna: **Tailscale SSH przechwytywał
połączenia zanim `authorized_keys`/`command=` w lokalnym sshd w ogóle
wchodziły do gry** — dotyczyło to obu maszyn, w tym prawdopodobnie od
zawsze pierwszego agenta backupu (`bkp@malinka`). Brak szkód (sprawdzone
`ls -la /`, usługi działały normalnie).

**Naprawa:** `tailscale set --ssh=false` na serwerze i malince (Twoja decyzja
— nie używasz świadomie Tailscale SSH do logowania). Oba agenty (`bkp`,
`bkptrigger`) ponownie przetestowane po naprawie — działają poprawnie.

Pełne szczegóły w osobnej notatce (dla przyszłych sesji): patrz pamięć
projektu, plik `jarvis-tailscale-ssh-bypass-2026-08-27.md`.

## 4. Klucz bota Discorda — cutover na ograniczone konto

- Bot (`/home/macmal/jarvis-bot/` na malince) używał klucza `root@serwer` do
  trzech rzeczy: `poweroff` (`/shutdown_serwer`), `reboot` (`/reboot`) i
  rozbudowanego skryptu statusu CPU/RAM/GPU/dysku (`/info`). Ustalone wprost
  z kodu bota (`cogs/commands.py`), nie z podsłuchu — bo root i tak już nie
  mógł się logować (patrz punkt 3).
- **Ważne:** zmienna `SSH_USER` w `.env` bota była **współdzielona** z
  wyłączaniem peceta Windows (`shutdown_pc`) — nie wolno było jej po prostu
  zmienić globalnie.
- **Rozwiązanie:** nowa zmienna `NODE2_SSH_USER=jpower`, TYLKO dla poleceń do
  serwera. `config.py` i `cogs/commands.py` spatchowane (skrypt Pythona z
  asercjami, backup pliku zrobiony przed patchem). `poweroff`/`reboot` idą
  teraz przez `jpower`, `info` wysyła krótkie hasło `"info"` zamiast całego
  skryptu przez SSH (skrypt przeniesiony na serwer, do agenta — bezpieczniej
  i łatwiej utrzymać). Pecet (`shutdown_pc`) **nietknięty**, dalej działa
  przez `SSH_USER=root`.
- Kontener bota przebudowany. **`/info` przetestowane naprawdę przez
  Discorda — działa identycznie jak przed zmianą.** `poweroff`/`reboot` nie
  testowane bezpośrednio (naprawdę by zadziałały), ale mechanizm już
  zweryfikowany (te same testy `ping`/brak-polecenia/`rm -rf /` co dla
  innych agentów).

## Zmienione/nowe pliki (w paczce `home/jarvis/` i na maszynach)

| Plik | Co się zmieniło |
|---|---|
| `serwer/systemd/jarvis-backup-malinka.timer` | godzina 03:15 → 22:00 |
| `serwer/jarvis-server-backup-agent.sh` | **nowy** — whitelist `ping`/`run` dla backupu serwera |
| `serwer/authorized_keys-backup-trigger.example` | **nowy** |
| `malinka/nightly-backup.sh` | **nowy w paczce** (był tylko na malince) — łączy się jako `bkptrigger`, nie `root` |
| `/opt/jarvis/scripts/backup.sh` (serwer) | `BACKUP_DIR` → `/mnt/telemetry/backups/serwer`, dodany bit +x |
| `serwer/jarvis-power-agent.sh` | whitelist rozszerzona: `poweroff`, `reboot`, `ping`, `info` |
| `/home/macmal/jarvis-bot/.env` (malinka) | dodana `NODE2_SSH_USER=jpower` |
| `/home/macmal/jarvis-bot/config.py` (malinka) | dodana `NODE2_SSH_USER` |
| `/home/macmal/jarvis-bot/cogs/commands.py` (malinka) | `poweroff`/`reboot`/`info` → `NODE2_SSH_USER`; backup: `commands.py.bak-20260827` |
| `/root/.ssh/authorized_keys` (serwer) | dopisana linia z `discover-bot-ssh-usage.sh` (obecnie nieaktywna, `PermitRootLogin no` i tak blokuje) |
| Tailscale (oba) | `ssh=false` |

## Nowe konta systemowe na serwerze

- `bkptrigger` — wyzwala backup danych serwera (whitelist: `ping`, `run`).
- `jpower` — steruje zasilaniem serwera dla bota (whitelist: `ping`, `poweroff`, `reboot`, `info`).

## Co zostało z listy 2026-08-27

1. ✅ Backup danych serwera.
2. ✅ Klucz bota Discorda.
3. **Trot** (appka tartaku dla wujka) — nietknięte, plan w
   `docs/JARVIS-trot-wdrozenie.md`.
4. Sekrety do sops + repo git — świadomie na koniec. W tej sesji w plaintext
   wyszły: `DISCORD_WEBHOOK` (`backup-malinka.env`) i `DISCORD_TOKEN`
   (`jarvis-bot/.env`) — warto zrotować przy okazji.

## Sprzątanie (jeszcze nie zrobione)

- Porozrzucane pliki instalacyjne w `~` na serwerze → `/opt/jarvis/scripts`.
- Stare snapshoty `/mnt/data/backups/*` (nieaktualne, ~30 katalogów).
- Rozważyć usunięcie starego klucza roota bota z `/root/.ssh/authorized_keys`.

## Ważne pułapki techniczne (żeby nie powtarzać)

- Transferowane skrypty z Windows: CRLF + brak x-bita —
  `sed -i 's/\r$//' plik && chmod +x plik` przed uruchomieniem.
- Sesja Cowork (`device_bash`) NIE ma dostępu do sieci LAN/Tailscale — nie
  potrafi połączyć się z `serwer`/`malinka`. Komendy trzeba wklejać ręcznie.
- **Każdy nowy agent forced-command: zawsze testować `rm -rf /` i sprawdzać,
  że w outpucie NIE ma "Tailscale SSH" ani pełnego MOTD** — inaczej
  ograniczenie może być martwe (patrz punkt 3).
