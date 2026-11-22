# Homelab — JARVIS

Mój domowy asystent i homelab: Raspberry Pi działające 24/7, serwer budzony przez Wake-on-LAN tylko wtedy,
gdy jest potrzebny, stary telefon jako dotykowy panel przy biurku i bot na Discordzie. Wszystko po polsku,
łącznie z komentarzami w kodzie.

To moja konfiguracja, a nie gotowy produkt do instalacji jednym poleceniem. Repo pokazuje, jak to
działa, i jest kopią tego, co faktycznie chodzi na moich maszynach (bez sekretów).

## Jak to działa

```
            ┌──────────────── Tailscale ────────────────┐
 Telefon (panel, „Hey Jarvis”) ─┐                        │
 Discord (bot) ─────────────────┼──► Malinka (RPi, 24/7) ──── WoL ───► Serwer (na żądanie)
 Komputery (agent C#) ──────────┘    panel, bot, TODO,                 n8n, Ollama, Nextcloud,
                                     reguły, AdGuard, NPM,             Paperless, Jellyfin + *arr,
                                     Kuma, Vaultwarden                 Qdrant, backupy (RAID1)
```

- **Malinka** (Raspberry Pi, SSD) działa cały czas. Trzyma panel, bota, listy zadań, DNS i reverse proxy
  oraz decyduje, kiedy obudzić serwer.
- **Serwer** sam się wyłącza po 15 minutach bezczynności (`serwer/idle-shutdown.sh`), a budzi się przez WoL,
  kiedy potrzebne są jego usługi: AI, dokumenty, media albo backup.
- **Panel** to aplikacja w Pythonie bez frameworka (`malinka/live/panel`), wyświetlana na telefonie w
  WebView. Ma zakładki: dzień i kalendarz, komputery, muzykę i Discorda, limity Claude, media, serwery, sieć,
  trening i światło. Do tego: komendy głosowe rozpoznawane lokalnie (bez AI), budzik, minutniki,
  wykrywanie obecności kamerą i reguły „gdy → wtedy” z kreatorem i trybem „na sucho”.
- **Agent na PC** (`pc-agent`, C#/.NET) podaje panelowi temperatury, procesy, multimedia, mikser i stan
  Discorda oraz wykonuje polecenia (blokada, uśpienie, wyłączenie).
- **n8n** na serwerze składa poranny raport (kalendarz z pogodą w miejscu wydarzenia, zadania, faktury z
  Paperlessa, maile, media, stan usług) i etykietuje maile przez lokalny model w Ollamie.

## Co gdzie leży

| Folder | Zawartość |
|---|---|
| `malinka/live/` | Usługi na Raspberry Pi: `panel` (+ `android` — appka WebView), `jarvis-bot` (Discord), `todo`, `trener`, `homepage`, `adguardhome`, `npm`, `vaultwarden`, `esphome` (przedłużacze z ESP32), `olivetin`, `portainer`, `trot` |
| `malinka/` | Backup nocny, `mail-notifier` (powiadomienia o ważnych mailach), `wake-gate`, hardening (fail2ban, log2ram), audyt |
| `serwer/` | `idle-shutdown.sh`, backupy (restic, agent z forced command), `live/utorent` (Jellyfin + Sonarr/Radarr/qBittorrent przez gluetun), `live/paperless-gpt`, audyt |
| `common/` | Wspólne dla obu maszyn: hardening SSH, SMART, unattended-upgrades, cotygodniowy raport zdrowia z automatyczną aktualizacją kontenerów i rollbackiem |
| `n8n/` | Workflowy (poranny raport, etykiety maili) i kod węzła „Złóż brief” |
| `pc-agent/` | Agent Windows dla panelu |
| `uptime-kuma/`, `led/` | Monitoring; sterownik LED (WLED) |
| `secrets/` | Sekrety zaszyfrowane `sops` + `age` (klucz poza repo) |

## Sekrety

Żadnych haseł, tokenów ani kluczy w repo. Prawdziwe wartości leżą w plikach `.env` na maszynach (w repo są
tylko `.env.example`) albo w `secrets/jarvis-secrets.enc.yaml`, zaszyfrowanym `sops`/`age`. Klucz Google do
kalendarza i klucze SSH też są tylko na maszynach.

## Stos

Python (stdlib, bez frameworków po stronie panelu), JavaScript (vanilla), C#/.NET 8, Docker Compose, n8n,
Ollama, Tailscale, AdGuard Home, Nginx Proxy Manager, Uptime Kuma, Nextcloud, Paperless-ngx + paperless-gpt,
Jellyfin, ESPHome, Google Calendar API, Open-Meteo, Discord (discord.py, webhooki).
