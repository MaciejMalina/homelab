# JARVIS Panel — dashboard na starym telefonie (Redmi Note 9 Pro)

```
telefon (appka JARVIS Panel = WebView, ekran główny, poziomo)
   │  http://192.168.254.10:8084        strumień SSE /api/stream (ekran, alerty, Discord — od razu) · zakładka co 2–60 s /api/tab/<nazwa> · co 60 s /api/heartbeat
   │                                    (gdy strumień milczy: zapasowe odpytywanie /api/screen co 3 s)
   ▼
malinka: jarvis_panel (ten folder, network_mode: host, port 8084)
   ├─ Przegląd   todo :8083, trener :8082, Kuma :3001, Open-Meteo (dotknij kafla pogody → godzinowa + 7 dni)
   ├─ Dzień      kalendarz Nextcloud (CalDAV) + Paperless (serwer, po LAN-ie), mail-notifier/state/stan.json
   ├─ Komputer   agent C# na gaming PC / laptopie (pc-agent/): temperatury, W, RAM/VRAM, ping, audio, zasilanie
   ├─ Muzyka     agent: co gra (Spotify/przeglądarka), play/pauza, mikser aplikacji
   ├─ Discord    bot (cogs/panel.py) wypycha kanały głosowe; mute/deafen = skróty klawiszowe przez agenta
   ├─ Media      qBittorrent / Sonarr / Radarr / Jellyfin na serwerze
   ├─ Serwery    Glances na serwerze, malinka (/proc), Uptime Kuma, obudź/uśpij/restart serwera,
   │             kontenery Dockera (lista, logi, restart) przez docker-socket-proxy
   ├─ Sieć       ZTE MC889A Pro (goform API), AdGuard, speedtest z malinki
   ├─ Trening    trener GET /api/panel (plan tygodnia, dziś, cele) + minutnik przerw
   └─ Światło    WLED na płytce ESP8266 (gdy wgrasz firmware)
```

**Serwer pytamy wyłącznie po LAN-ie (192.168.254.11).** `idle-shutdown.sh` ignoruje ruch z 192.168.254.10,
więc panel nie trzyma serwera przy życiu. Gdy serwer śpi, Media/Glances pokazują „Obudź”, a Dzień — ostatni zapisany
kalendarz i faktury (`data/pamiec.json`).

## Nowe w tej wersji (po inspiracji dashboardVibed)

**Kontenery Dockera** (Serwery → „Zarządzaj kontenerami”): lista z problemami na górze, podgląd logów (ostatnie 100 linii,
odświeżane co 5 s), restart z potwierdzeniem „Na pewno?”. Panel nie dostaje gniazda Dockera — `docker-compose.yml` stawia
obok `jarvis_docker_proxy` (docker-socket-proxy: tylko lista, logi i restart, słucha na 127.0.0.1:2375).

```bash
cd ~/panel
nano .env                            # dopisz blok DOCKER_* z .env.example (nie kopiuj całego pliku — nadpiszesz klucze)
docker compose up -d --build         # startuje proxy i panel
curl -s localhost:2375/containers/json | head -c 200; echo                       # lista -> JSON
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:2375/containers/NAZWA/restart   # prawdziwy kontener: 204; nieistniejący: 404 (też dobrze — proxy przepuściło)
curl -s -o /dev/null -w '%{http_code}\n' localhost:2375/images/json                          # 403 = reszta zablokowana (tak ma być)
```

Restart przechodzi dzięki własnej regule w `docker-proxy.cfg.template` (tylko `POST /containers/<nazwa>/restart`). Sam `ALLOW_RESTARTS` bez `POST=1` w obrazie
0.5.0 nie działa, a `POST: 1` otworzyłoby też tworzenie i kasowanie kontenerów — nie zmieniaj tego. Obraz jest przypięty po digeście, bo szablon pasuje tylko do tej wersji.
Stop, kill, exec, start i create zostają zablokowane (403). Restart wyłączają: `ro` przy hoście,
`DOCKER_NIE_RESTARTUJ` (domyślnie sam panel i proxy). Logi mogą zawierać sekrety, więc idą przez POST, który wymaga `PANEL_TOKEN`
(jeśli ustawiony). Host serwera w `DOCKER_HOSTS` (opcjonalnie, `ro`) wpisuj tylko po adresie LAN — po IP Tailscale panel
nie rozpozna, że serwer śpi, i go nie przepuści przez `idle-shutdown.sh`.

**Pogoda** — dotknięcie kafla na Przeglądzie otwiera widok: teraz (wilgotność, ciśnienie, wiatr z porywami, opady, UV, wschód/zachód),
najbliższe 24 godziny (przewijane) i 7 dni z zakresem temperatur.

**Blokada „tapnięcia przez ekran”** — przez 600 ms po wybudzeniu (dotykiem albo komendą z JARVIS-a) panel ignoruje kliknięcia,
żeby przypadkowy dotyk w ciemny ekran nie uśpił serwera ani nie zrestartował kontenera.

**Push zamiast odpytywania** — `/api/stream` (Server-Sent Events): zmiana ekranu i alert z JARVIS-a oraz wiadomość od bota
Discorda dochodzą od razu (w testach ~50 ms zamiast do 3 s). Dane zakładek (temperatury, kolejka pobierania, itp.) nadal się odpytuje,
bo i tak trzeba je pobierać ze źródeł. Telefon sam łączy się ponownie po restarcie panelu, a martwe połączenie (Wi-Fi w uśpieniu)
wykrywa po braku `ping` przez 45 s.

## 1. Malinka

```bash
scp -r malinka/live/panel macmal@malinka:~/          # z PC, folder home/jarvis
# na malince:
cd ~/panel
ss -tlnp | grep 8084                                 # ma być pusto
cp .env.example .env && nano .env                    # opis każdej zmiennej w pliku
ls -l ../jarvis-bot/ssh_keys/id_rsa ../mail-notifier/state/stan.json   # oba MUSZĄ istnieć (inaczej docker zrobi z nich katalogi)
docker compose up -d --build
curl -s localhost:8084/api/tab/serwery | head -c 400; echo
```

Klucze do `.env`: Kuma → Settings → API Keys (albo zostaw `KUMA_STATUS_SLUG=brief`), Sonarr/Radarr → Settings → General → API Key,
Jellyfin → Panel sterowania → Klucze API, Paperless → profil → token API, Nextcloud → Ustawienia → Bezpieczeństwo → hasło aplikacji,
AdGuard i ZTE → te same loginy co do ich paneli WWW.

Trener: nowy plik `src/app/api/panel/route.ts` → `cd ~/trener && docker compose up -d --build`.

## 2. Agent na Windowsie (gaming PC + laptop)

`pc-agent/README.md`: `dotnet publish -c Release` na laptopie, potem `install.ps1` na każdym komputerze.
Token z instalatora → `AGENT_TOKEN` w `.env` panelu; `PCS=gaming|http://192.168.254.73:8765|<MAC>;laptop|http://<IP Tailscale laptopa>:8765|`.
W Discordzie ustaw skróty: Przełącz wyciszenie = `Ctrl+Shift+Alt+F9`, Przełącz ogłuszenie = `Ctrl+Shift+Alt+F11`.

## 3. Bot Discord

`cogs/panel.py` → `~/jarvis-bot/cogs/`, w `main.py`: `await self.load_extension("cogs.panel")`, przebuduj bota.
Daje `/ekran`, `/panel_alert` i wysyła do panelu, kto siedzi na kanałach głosowych.

## 4. Sterowanie ekranem z JARVIS-a

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"mode":"on","minutes":10}' http://127.0.0.1:8084/api/screen
curl -s -X POST -H 'Content-Type: application/json' -d '{"text":"Backup serwera nie przeszedł","level":"crit"}' http://127.0.0.1:8084/api/alert
```
Z `PANEL_TOKEN` dodaj `-H 'X-Panel-Token: …'`.

## 5. Appka (`android/`)

Czysty Java + WebView. APK buduje GitHub Actions (`.github/workflows/panel-apk.yml`, sekrety `PANEL_KEYSTORE_B64` /
`PANEL_KEYSTORE_PASS` z `home/panel-podpis/`) albo Android Studio. Na telefonie: zainstaluj, ustaw jako **ekran główny → Zawsze**,
blokada ekranu **Brak**. Ustawienia appki: przytrzymaj 3 s lewy górny róg.

## 6. Root (Magisk na MIUI) i bateria — Redmi Note 9 Pro **M2003J6B2G** (joyeuse)

> Odblokowanie bootloadera **kasuje wszystko na telefonie**. Wersja ROM-u do boot.img musi być **dokładnie** ta sama co na telefonie.

1. **Wersja:** Ustawienia → O telefonie → Wersja MIUI, np. `MIUI Global 14.0.3.0 (SJZMIXM)` albo europejska `SJZEUXM`.
   Ostatnie wydania: Global 14.0.3.0.SJZMIXM, EEA 14.0.5.0.SJZEUXM (Android 12, telefon nie dostaje już aktualizacji).
2. **Bootloader:** Opcje programisty (7× tap w „Wersja MIUI”) → Stan Mi Unlock → powiąż konto Mi (karta SIM i **dane komórkowe**
   włączone, nie Wi-Fi). Odczekaj blokadę (zwykle 168 h), potem na laptopie oficjalny **Mi Unlock** → telefon w fastboot
   (Power + Vol−) → Unlock.
3. **boot.img:** pobierz **Fastboot ROM** dokładnie Twojej wersji (xmfirmwareupdater.com → joyeuse), rozpakuj `.tgz`
   → `images/boot.img`. Zachowaj kopię oryginału.
4. **Łatka:** na telefon `Magisk-vXX.apk` (github.com/topjohnwu/Magisk/releases) + `boot.img` → Magisk → Instaluj →
   „Wybierz i załataj plik” → w Pobranych powstaje `magisk_patched-XXXXX.img`.
5. **Flash** (laptop, Google platform-tools):
   ```powershell
   adb pull /sdcard/Download/magisk_patched-XXXXX.img
   adb reboot bootloader
   fastboot flash boot magisk_patched-XXXXX.img
   fastboot reboot
   # coś nie tak -> fastboot flash boot boot.img (oryginał)
   ```
6. **Bez aktualizacji MIUI:** Ustawienia → O telefonie → Wersja MIUI → ⋮ → Ustawienia → wyłącz automatyczne pobieranie
   (OTA nadpisze boot i zdejmie root).
7. **Bateria — ACC:** Magisk → Moduły → Zainstaluj z pamięci → `acc_*.zip` (github.com/VR-25/acc/releases) → restart. Potem:
   ```sh
   su -c acc -t                         # test przełączników; "Idle" = telefon może chodzić z samego zasilacza
   su -c acc -s pc=60 rc=55             # trzymaj 55–60% (z natywnym idle bateria po prostu stoi na 60%)
   su -c acc -i                         # stan: prąd ładowania ~0 mA = działa jak "bez baterii"
   ```
   Panel pokazuje status baterii: „nie ładuje” przy 55–60% = ACC działa.
8. **MIUI:** JARVIS Panel → Uprawnienia → Autostart: włącz; Bateria → Bez ograniczeń.
