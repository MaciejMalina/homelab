# Roadmapa

Plan rozwoju homelaba. Każda pozycja ma kryterium „gotowe” sprawdzalne na danych z systemu.

## Teraz
- **Odporny monitoring** — powtórzenia przed alertem w Uptime Kuma i usunięcie przyczyny sporadycznych timeoutów reverse proxy. *Gotowe:* tydzień bez fałszywego alertu.
- **Historia reguł „gdy → wtedy”** — zapis także przypadków, gdy wyzwalacz zadziałał, a warunek nie. *Gotowe:* takie wpisy widać w historii reguł.
- **Import PDF-ów z chmury do Paperlessa** — większe paczki, gdy serwer i tak działa. *Gotowe:* kolejka importu pusta.
- **Nowe reguły z trybu „na sucho” na „naprawdę”** — po kilku dniach obserwacji historii.

## Dalej
1. Układ zakładek Sieć i Media na telefonie.
2. Wiele list TODO bezpośrednio z karty dnia na panelu (przełączanie, dodawanie, tworzenie list).
3. Zakładka Claude na panelu (limity, historia, powiadomienia).
4. Pytania głosowe do własnych dokumentów (lokalny model + Paperless).

## Później
- Pasek LED z czujnikiem zmierzchu.
- Mocniejsze GPU i więcej lokalnego AI (rozpoznawanie mowy, większy model).
- Sprzętowe transkodowanie w Jellyfinie + napisy (Bazarr).
- Home Assistant — do decyzji (dziś automatyką zajmują się panel i ESPHome).

## Zamknięte
- Synteza mowy (Piper TTS) — zastąpiona mową panelu.
- Przypinanie wersji obrazów — zastąpione cotygodniowymi aktualizacjami z automatycznym rollbackiem.
- Osobny kontener wake word — usunięty.
