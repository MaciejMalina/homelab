# JARVIS Panel — dashboard na starym telefonie (Redmi Note 9 Pro)

```
telefon (appka JARVIS Panel = WebView, ekran główny)
   │  http://192.168.254.10:8084        co 3 s: /api/screen   co 30 s: /api/dash   co 60 s: /api/heartbeat
   ▼
malinka: jarvis_panel (ten folder, network_mode: host, port 8084)
   ├─ 127.0.0.1:8083  jarvis_todo      (lista TO DO, odhaczanie, dodawanie)
   ├─ 127.0.0.1:8082  jarvis_trener    (/api/brief, /api/sync)
   ├─ 127.0.0.1:3001  Uptime Kuma      (/metrics, klucz API)
   ├─ SERVER_IP:22 / :5678             (serwer działa? n8n żyje?)
   ├─ WoL broadcast                    ("Obudź serwer")
   ├─ ssh jpower@serwer poweroff       ("Uśpij serwer", ten sam forced command co bot)
   └─ api.open-meteo.com               (pogoda w Sułkowicach, bez klucza)
```

Ekran: strona po 2 min bez dotyku zasłania się na czarno, a appka ściemnia podświetlenie do minimum
(ekran logicznie dalej włączony, więc **dotyk go budzi** na `WAKE_MIN` minut). JARVIS steruje nim przez API.

## 1. Malinka

```bash
# z PC (folder home/jarvis):
scp -r malinka/live/panel macmal@malinka:~/

# na malince:
cd ~/panel
ss -tlnp | grep 8084                       # ma być pusto
cp .env.example .env && nano .env          # SERVER_IP (= NODE2_IP z .env bota), KUMA_API_KEY
ls -l ../jarvis-bot/ssh_keys/id_rsa        # klucz bota do jpower — MUSI istnieć, inaczej docker zrobi z niego katalog
docker compose up -d --build
curl -s localhost:8084/api/dash | head -c 600; echo
```

Klucz do Kumy: Uptime Kuma → Settings → API Keys → Add (bez daty wygaśnięcia).
Opcjonalnie w Kumie nowy monitor **Push** „Panel (telefon)” (interwał 120 s), jego URL do `KUMA_PUSH_PANEL`:
gdy telefon padnie albo straci Wi-Fi, dostaniesz alert jak przy innych monitorach.

Tailnet (opcjonalnie, np. żeby otworzyć panel z S25 poza domem):
`sudo tailscale serve --bg --https=8446 http://localhost:8084` (8443 Trot, 8444 trener, 8445 todo, 10000 Kuma).

## 2. Sterowanie z JARVIS-a

```bash
# ekran: on (na N minut, 0 = do odwołania) | sleep | auto
curl -s -X POST -H 'Content-Type: application/json' -d '{"mode":"on","minutes":10}' http://127.0.0.1:8084/api/screen
# komunikat + zapalenie ekranu (level: info | warn | crit; domyślnie świeci ALERT_MIN minut)
curl -s -X POST -H 'Content-Type: application/json' -d '{"text":"Backup serwera nie przeszedł","level":"crit"}' http://127.0.0.1:8084/api/alert
# z n8n na serwerze: http://100.105.181.54:8084/... (IP malinki w tailnecie) albo http://192.168.254.10:8084/...
```

Jeśli ustawisz `PANEL_TOKEN`, dodaj nagłówek `-H 'X-Panel-Token: …'`.

Bot Discord: skopiuj `cogs/panel.py` do `~/jarvis-bot/cogs/`, w `main.py` dopisz
`await self.load_extension("cogs.panel")`, przebuduj bota → komendy `/ekran` i `/panel_alert`.

## 3. Appka na telefon (`android/`)

Czysty Java + WebView, bez bibliotek. APK buduje GitHub Actions (`.github/workflows/panel-apk.yml`):
`git push` → GitHub → Actions → **Panel APK** → artefakt `jarvis-panel-apk` → `app-debug.apk` na telefon.
(Albo Android Studio: Open → `malinka/live/panel/android` → Build → Build APK.)

Stały podpis (żeby aktualizacje instalowały się na poprzednią wersję): w repo na GitHubie
Settings → Secrets and variables → Actions → dwa sekrety z folderu `home/panel-podpis/` (poza gitem):
`PANEL_KEYSTORE_B64` = zawartość `PANEL_KEYSTORE_B64.txt`, `PANEL_KEYSTORE_PASS` = zawartość `PANEL_KEYSTORE_PASS.txt`.

Na telefonie:
1. Zainstaluj APK, uruchom, przy pytaniu o ekran główny wybierz **JARVIS Panel → Zawsze**.
   Odtąd startuje sam po restarcie telefonu.
2. Blokada ekranu: **Brak** (inaczej po restarcie zostanie na ekranie blokady).
3. Ustawienia appki: **przytrzymaj 3 s lewy górny róg** → adres (domyślnie `http://192.168.254.10:8084/`),
   token, jasność po wybudzeniu. Stamtąd też przycisk „Ustawienia Androida”.
4. Wyjście z kiosku: Ustawienia Androida → Aplikacje → Aplikacje domyślne → Ekran główny.

## 4. Bateria (do zrobienia po ustaleniu dokładnego modelu)

Redmi Note 9 Pro = rodzina **miatoll** (LineageOS ją wspiera). Sam system baterii nie odłączy:
potrzebny root (Magisk) + **ACC** (Advanced Charging Controller):
- `su -c acc -t` — test przełączników ładowania; jeśli któryś obsługuje **idle mode**, telefon chodzi z zasilacza, a bateria stoi;
- jeśli nie — tryb emulowany: `acc 60 55` (ładowanie trzymane między 55 a 60%).
Panel pokazuje temperaturę i status baterii („nie ładuje” = ACC trzyma ładowanie) i ostrzega powyżej 38/42°C.
