# Roadmapa

Plan rozwoju homelaba. Każda pozycja ma kryterium „gotowe” sprawdzalne na danych z systemu.

## Teraz
- **Odporny monitoring** — powtórzenia przed alertem w Uptime Kuma i usunięcie przyczyny sporadycznych timeoutów reverse proxy. *Gotowe:* tydzień bez fałszywego alertu.
- **Monitoring backupu i certyfikatu** — Uptime Kuma alarmuje, gdy poranny backup konfiguracji nie przyjdzie, i przed wygaśnięciem certyfikatu. *Gotowe:* oba monitory aktywne i zielone.
- **Import PDF-ów z chmury do Paperlessa** — większe paczki, gdy serwer i tak działa, bez zbędnej kopii archiwalnej dla PDF-ów z tekstem. *Gotowe:* kolejka importu pusta.
- **Nowe reguły z trybu „na sucho” na „naprawdę”** — po kilku dniach obserwacji historii (zapisuje też przypadki „warunek niespełniony”).
- **Sprzątanie** — nieużywane katalogi, martwe monitory, stare kopie bazy.

## Dalej
1. Konfiguracja usług serwera (docker compose) w repo, sekrety poza gitem.
2. Pytania głosowe do własnych dokumentów (lokalny model + Paperless).
3. Agent AI z narzędziami i pamięcią — odpowiada i wykonuje akcje na danych domu (dokumenty, kalendarz, zadania, usługi).

## Później
- Pasek LED z czujnikiem zmierzchu.
- Mocniejsze GPU i więcej lokalnego AI (rozpoznawanie mowy, większy model).
- Sprzętowe transkodowanie w Jellyfinie.
- Home Assistant — do decyzji (dziś automatyką zajmują się panel i ESPHome).
- Automatyczny start serwera po zaniku zasilania.
- Przegląd sekretów i uprawnień kont serwisowych.

## Zrobione ostatnio
- Układ zakładek Sieć i Media w poziomie, wiele list TODO na karcie dnia, zakładka limitów Claude.

## Zamknięte
- Synteza mowy (Piper TTS) — zastąpiona mową panelu.
- Przypinanie wersji obrazów — zastąpione cotygodniowymi aktualizacjami z automatycznym rollbackiem.
- Osobny kontener wake word — usunięty.
