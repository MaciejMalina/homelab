# n8n — przypomnienia i maile (2026-10-16)

| Plik | Gdzie | Co robi |
|---|---|---|
| `serwer-poranny-brief.json` | n8n na serwerze | `/webhook/reminders` (woła go `nightly-backup.sh` o 7:30): kalendarz Nextcloud (z wydarzeniami cyklicznymi), zadania Vikunji, terminy z Paperlessa, dyski i temperatury z Glances → Discord |
| `serwer-maile-etykiety-ai.json` | n8n na serwerze | oba konta Gmail → qwen3:4b → etykiety BIZNES / OSOBISTE / NEWSLETTER / `AI/Spam?` (bez przenoszenia do Spamu) |
| `../malinka/mail-notifier/` | malinka (Docker) | skrypt w Pythonie: nowe nieprzeczytane maile z „Głównych” na obu kontach → Discord, 24/7, ~20 MB RAM |

## 1. Serwer — n8n

```text
1. Stary workflow „Przypomnienia” → Deactivate (ma ten sam path /reminders)
2. Import from file: serwer-poranny-brief.json
   - węzeł Discord: URL = Twój webhook
   - Nextcloud / Vikunja: sprawdź, czy credentiale się podpięły
   - Paperless pola + Paperless dokumenty: nowy credential „Header Auth”
       Name:  Authorization
       Value: Token <token z Paperless: profil → „Mój profil” → Token API>
     Paperless: http://100.93.105.37:8010 (w obu węzłach
     i w stałej PAPERLESS_URL w węźle „Złóż brief”)
   - Publish
   - test (z malinki):  curl -X POST http://100.93.105.37:5678/webhook/reminders
3. Gmail (oba konta): utwórz etykietę  AI/Spam?
   maciejmalina19: utwórz też  BIZNES, OSOBISTE, NEWSLETTER
   (nazwy muszą się zgadzać ze stałą NAZWY w węzłach „Przypisz – …”)
4. Import: serwer-maile-etykiety-ai.json
   - łańcuch maciejmalina19: nowy credential Gmail OAuth2 dla tego konta (3 węzły Gmail)
   - Publish
5. Przejrzyj folder Spam w macmalonet783 — stary workflow wrzucał tam maile uznane przez AI za SPAM.
```

- **Glances:** jeśli brief pokaże „Glances dyski: 404”, masz Glances 3. W obu węzłach Glances zmień `/api/4/` na `/api/3/`.
- **Google Cloud → OAuth consent screen → Publishing status: In production.** W trybie „Testing” Google unieważnia token po 7 dniach i trigger Gmaila po cichu przestaje działać.

## 2. Paperless — pola dla przypomnień

Brief szuka pól o dokładnie tych nazwach. Jeśli zmienisz nazwę, popraw ją w stałej `POLA` w „Złóż brief” i w zapytaniu węzła „Paperless dokumenty”.

| Pole dodatkowe (menu „Pola dodatkowe”) | Typ | Przypomnienie w briefie |
|---|---|---|
| `Termin płatności` | Data | 💳 7 dni przed terminem i po terminie, aż do zaznaczenia „Zapłacone” |
| `Zapłacone` | Boolean | wyłącza przypomnienie o płatności |
| `Kwota` | Kwota | pokazywana przy płatności |
| `Gwarancja do` | Data | ⏳ 30 dni przed końcem |
| `Ważne do` | Data | ⏳ 30 dni przed końcem (OC, przegląd, dowód, abonamenty) |

Automatyczne dodawanie pól: menu **Procesy** → wyzwalacz *Dokument dodany*, filtr: typ dokumentu `Faktura`, akcja *Przypisz* → pola `Termin płatności`, `Zapłacone`, `Kwota`. Analogicznie dla `Paragon/Gwarancja` (pole `Gwarancja do`) i `Polisa` (pole `Ważne do`).

## 3. Malinka — mail-notifier

Na każdym koncie Google: włącz weryfikację dwuetapową i wygeneruj **hasło aplikacji** (myaccount.google.com/apppasswords). Hasło logowania do konta tu nie zadziała.

```bash
# Windows, w folderze home\jarvis
scp -r malinka/mail-notifier macmal@malinka:~/

# malinka
cd ~/mail-notifier
cp .env.example .env && chmod 600 .env && nano .env      # webhook + 2 hasła aplikacji
mkdir -p state && chown 1000:1000 state
docker compose up -d && docker logs -f mail_notifier    # oczekiwane: „start od UID …” dla obu kont
```

Pierwsze uruchomienie tylko zapamiętuje pozycję w skrzynce. Powiadomienia przychodzą od następnego maila. Skrypt nie oznacza maili jako przeczytanych.

Opcjonalnie: Uptime Kuma → monitor typu **Push**, interwał 120 s → URL do `KUMA_PUSH_URL` w `.env` → `docker compose up -d`.

Backup: dopisz `~/mail-notifier` (`.env` + `state/`) do backupu konfiguracji malinki.

## 4. Media (bez n8n)

Sonarr i Radarr mają wbudowane powiadomienia: Settings → Connect → + → **Discord** → Webhook URL. Zaznacz:
- Sonarr: On File Import (albo On Import Complete — jedno powiadomienie na cały sezon), On File Upgrade
- Radarr: On File Import, On File Upgrade

## 5. Brief — dodatkowe źródła (2026-10-17)

| Węzeł | Co ustawić |
|---|---|
| Paperless pola / dokumenty / nowe | credential Header Auth `Authorization: Token …` (ten sam we wszystkich trzech) |
| Pogoda | nic — Open-Meteo bez klucza, Sułkowice (49.846, 19.776) |
| Maile ważne – macmalonet783 / – maciejmalina19 | credentiale Gmail danego konta; szuka `newer_than:1d (label:biznes OR label:osobiste)` |
| Sonarr / Radarr | credential Header Auth: Name `X-Api-Key`, Value = API Key z Settings → General (osobny dla każdego) |
| Kuma strona / Kuma stan | w Uptime Kumie: Strony statusów → Nowa strona statusu, slug **`brief`**, dodaj monitory, które mają działać 24/7 (malinka + backup). Monitorów serwera NIE dodawaj — serwer śpi, więc ciągle „padają” |

Backup w briefie pojawia się tylko, gdy monitor z „backup” w nazwie nie jest zielony; awarie — tylko gdy monitor miał < 99,5% w 24 h, padł w ostatnich 12 h albo nadal nie działa.
Każdy węzeł źródła można usunąć (połącz wtedy sąsiednie węzły) — brief pominie jego sekcję bez błędu.

## Pogoda w miejscu wydarzeń + listy (2026-11-20)

Panel na malince geokoduje pole „Miejsce” wydarzeń z Nextclouda i daje prognozę na godzinę wydarzenia.
W workflow „poranny brief” (ręcznie w edytorze n8n):

1. Dodaj węzeł **HTTP Request** o nazwie dokładnie **`Pogoda wydarzeń`**:
   - Method `GET`, URL `http://100.105.181.54:8084/api/kalendarz/pogoda`, Response Format: JSON
   - Settings → **On Error: Continue** (gdy panel nie odpowie, brief pójdzie bez pogody)
2. Wepnij go w łańcuch między **Kalendarz** a **Zadania**: `Kalendarz → Pogoda wydarzeń → Zadania`.
3. W węźle **Złóż brief** podmień cały kod na aktualny `n8n/zloz-brief.js`.

Efekt: przy wydarzeniu z miejscem dopisek `— 📍 Kraków 🌧️ 6°C · opady 70%`. Pozycje z list TO DO (zakupy, prezenty…)
nie są już wypisywane jako zadania — trafiają do pola **📋 Listy** (liczba pozycji na każdej liście).
