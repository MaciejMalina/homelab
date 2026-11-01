# JARVIS Trener

Webappka treningowa na malince: treningi z Huawei Watch GT 5 (Huawei Health → intervals.icu → appka),
zapis siłowni w trakcie treningu, analiza każdego treningu i plan tygodniowy od Claude Sonnet,
biegi z planu wysyłane z powrotem na zegarek.

- Adres: `https://malinka.tail0524ca.ts.net:8444` (tylko tailnet), kontener `jarvis_trener`, port hosta **8082**
- Stos: Next.js 15 (standalone) + Prisma 6 (klient bez silnika Rust, sterownik better-sqlite3) + SQLite w `./data`
- Harmonogram w procesie appki: synchronizacja co 20 min, plan na kolejny tydzień w niedzielę o 19:00 (zmiana w Ustawieniach)
- Powiadomienia: webhook Discorda JARVIS-a; poranny brief n8n pobiera `GET /api/brief`

## Jednorazowa konfiguracja kont

1. **intervals.icu** — konto (darmowe) → Settings → Connections → **HUAWEI Health → Connect** (zaloguj Huawei ID),
   w tym samym boksie zaznacz **Upload planned workouts**. W aplikacji Huawei Health: Ja → usługi zewnętrzne (3rd Party Services) →
   **Health Service Kit** musi być połączony. W boksie Huawei kliknij **Download Old Data** (rok historii).
   Klucz: Settings → Developer Settings → API key; Athlete ID z adresu profilu (`i123456`).
2. **Claude API** — claude.ai → Ustawienia → Rozliczenia → sekcja kredytów API → podepnij organizację Console
   (plan Max: kredyty co miesiąc). Na platform.claude.com → API keys → nowy klucz. Warto ustawić limit wydatków.
3. Webhook Discorda — ten sam, którego używa reszta JARVIS-a.

## Wdrożenie (malinka)

```bash
# z Windowsa, w katalogu repo jarvis-infra
scp -r malinka/live/trener macmal@malinka:~/

ssh macmal@malinka
cd ~/trener
cp .env.example .env && nano .env      # INTERVALS_*, ANTHROPIC_API_KEY, DISCORD_WEBHOOK
mkdir -p data
docker compose up -d --build           # pierwszy build na malince: kilka–kilkanaście minut
docker compose logs -f --tail=50       # czekaj na "[scheduler] sync {...}"
sudo tailscale serve --bg --https=8444 http://localhost:8082
curl -s http://localhost:8082/api/health
```

Na telefonie: otwórz adres w Chrome → menu ⋮ → **Dodaj do ekranu głównego** (instaluje się jak aplikacja).

## Aktualizacja

```bash
scp -r malinka/live/trener macmal@malinka:~/     # .env i data/ na malince zostają nietknięte
ssh macmal@malinka 'cd ~/trener && docker compose up -d --build'
```

Schemat bazy dopasowuje się sam przy starcie (`prisma db push`), dane zostają.

## Rozwój lokalnie

```bash
npm install
cp .env.example .env    # + DATABASE_URL=file:/pełna/ścieżka/data/dev.sqlite
npx prisma db push
npm run dev             # TRENER_SCHEDULER=off wyłącza harmonogram
npm test                # testy dat i szacunków (Epley, Riegel)
```

## Endpointy

| | |
|---|---|
| `GET /api/health` | healthcheck (Kuma, Docker) |
| `GET /api/brief` | linie do porannego briefu n8n |
| `POST /api/sync` | ręczna synchronizacja z intervals.icu |
| `POST /api/plan` `{week: "current"\|"next", uwagi}` | ułóż/przebuduj plan |
| `POST /api/chat` `{message}` | rozmowa z trenerem |
