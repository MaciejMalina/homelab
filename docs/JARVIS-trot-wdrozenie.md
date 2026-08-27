# Trot (tartak) na malince — plan wdrożenia

Appka: Next.js 16 + Prisma/SQLite, śledzenie produkcji w tartaku (stacje,
zdarzenia produkcyjne, partie deski→klocki, kalkulator objętości). Dockerfile
w repo już ma dopisek o kompatybilności Prisma na ARM — ktoś wcześniej mierzył
w malinkę, więc trzymamy się tego wyboru: **malinka**, bo jest always-on i
wujek nie musi budzić serwera przez WoL, żeby wejść do appki.

## 0. Zanim zaczniesz — RAM na malince

Malinka ma dziś 8 kontenerów na 2GB RAM (osobny temat z audytu). Dziewiąty
kontener to kolejny gość na tej samej działce. Zanim wdrożysz:

```bash
free -h
docker stats --no-stream    # ile realnie zjada dziś każdy kontener
```

Jeśli `free -h` pokazuje mniej niż ~200-300MB wolnego — zrób najpierw
`setup-log2ram.sh` (już w tej paczce) i rozważ, czy nie poczekać z trot do
przeniesienia czegoś na serwer, zamiast dokładać w ciasne miejsce.

## 1. Przenieś kod na malinkę

Repo dziś żyje tylko na Twoim laptopie (folder `trot/`, ma `.git`, ale bez
zdalnego repo — git na serwer to osobny punkt z listy, na koniec). Najprostsza
droga teraz, zanim będzie Gitea/Forgejo:

```bash
# z Twojego komputera (WSL/git bash/PowerShell z rsync albo scp)
rsync -avz --exclude node_modules --exclude .next --exclude .git \
      ./trot/ macmal@malinka:~/trot/
```

(Jeśli nie masz `rsync` na Windows: spakuj folder bez `node_modules`/`.git`
do zip, `scp` na malinkę, rozpakuj tam.)

## 2. Podmień docker-compose.yml

Ten z repo mapuje port 80, który na malince zajmuje już reverse proxy. Podmień
na wersję z tej paczki (`malinka/trot/docker-compose.yml`, port 3010):

```bash
# na malince
cp ~/jarvis/malinka/trot/docker-compose.yml ~/trot/docker-compose.yml
```

## 3. Build i start

```bash
cd ~/trot
docker compose up -d --build
docker compose logs -f app          # ctrl-C jak wystartuje
```

Test lokalny: `curl -I http://localhost:3010` z malinki powinno dać `200 OK`.

## 4. Migracje Prisma (baza SQLite pusta przy pierwszym starcie)

```bash
docker compose exec app npx prisma migrate deploy
# jeśli migracje jeszcze nie istnieją w repo (tylko schema.prisma bez migrations/*.sql):
docker compose exec app npx prisma db push
```

## 5. Udostępnienie wujkowi — dwie opcje

**A. Tailscale (rekomendowane)** — appka NIE trafia na publiczny internet,
tylko do Twojej sieci Tailscale. Zaproś wujka jako gościa do tailnetu albo
użyj `tailscale serve`:

```bash
# na malince
tailscale serve --bg --https=443 http://localhost:3010
```

Wujek dostaje link `https://malinka.<twoj-tailnet>.ts.net` — działa tylko dla
urządzeń w Twoim tailnecie (musi mieć zainstalowany Tailscale i dostać
zaproszenie).

**B. Reverse proxy przez NPM (jeśli wujek ma być publicznie, bez Tailscale)**
— dodaj Proxy Host w panelu NPM: domena np. `tartak.twojadomena.pl` →
`http://malinka-ip:3010`. To wystawia appkę na świat przez ten sam Funnel co
resztę usług — rozważ, czy appka produkcyjna tartaku faktycznie musi być
publiczna, czy Tailscale (opcja A) wystarczy na testy z wujkiem.

## 6. Kafelek na Homepage (opcjonalnie, wzorem panelu LED)

```yaml
- Tartak:
    - Trot:
        href: http://malinka-ip:3010   # albo adres z Tailscale Serve
        icon: mdi-saw-blade
        description: Śledzenie produkcji tartaku
```

## Po wdrożeniu

- `docker stats jarvis_trot --no-stream` — sprawdź realne zużycie RAM po kilku
  dniach normalnej pracy, nie zaraz po starcie.
- Backup: SQLite leży w `~/trot/prisma/database.sqlite` na malince — dopisz
  ten katalog do wykluczeń/włączeń w `backup-malinka.sh`, jeśli chcesz mieć
  dane tartaku w tym samym backupie co reszta malinki (domyślnie rsync
  kopiuje cały rootfs poza wykluczeniami z `EXCLUDES`, więc `~/trot` już
  powinno się łapać — zweryfikuj po pierwszym `backup-malinka.sh daily`
  przez `restic ls latest | grep trot`).
