# Uptime Kuma — monitoring JARVIS-a

Patrz nagłówek `docker-compose.yml` (uzasadnienie: malinka nie serwer, docker
przez proxy nie surowy socket, kroki konfiguracji po pierwszym starcie).

## Instalacja

```bash
# na malince
mkdir -p /opt/jarvis/uptime-kuma
# skopiuj docker-compose.yml tutaj (scp z Windowsa, jak reszta paczki)
cd /opt/jarvis/uptime-kuma
docker compose up -d
```

## Udostępnienie poza LAN (opcjonalnie, przez Tailscale)

Port 8443 zajęty przez Trota — Kuma dostaje **10000** (Tailscale Serve HTTPS
wspiera tylko 443/8443/10000, a 443 zostaje dla NPM, patrz notatka o
konflikcie portu 443 z 2026-08-27):

```bash
tailscale serve --bg --https=10000 http://localhost:3001
```

Dostęp: `https://malinka.<twój-tailnet>.ts.net:10000`

## Co monitorować w pierwszej kolejności

- **Push monitor** dla `backup-malinka.sh` (serwer) i `nightly-backup.sh`
  (malinka) — Kuma daje unikalny URL, dopisz na końcu skryptu `curl -fsS -m
  10 "<push-url>" >/dev/null 2>&1 || true` (dokładnie ten sam wzorzec co już
  istniejący `hc()`/`HEALTHCHECK_URL` w `backup-malinka.sh` — to jest ta sama
  idea, healthchecks.io, tylko self-hosted). To wychwytuje przypadek, którego
  same powiadomienia Discord nie widzą: skrypt, który w ogóle nie wystartował
  (np. bo padł WoL albo cron).
- **HTTP(s) monitor** dla: AdGuard Home, NPM, Homepage, n8n, Ollama — cokolwiek
  ma UI/API na porcie.
- **Docker monitor** dla kontenerów, które mają krótkie/ciche awarie (np.
  `mountain-tracker`, `unhealthy` od dłuższego czasu wg audytu).

## Powiązane

- `docs/JARVIS-storage-i-roadmapa.md` — sekcja 3.1 i 3.5 (Uptime Kuma + ntfy,
  docker socket proxy).
