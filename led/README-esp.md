# Sterowanie paskiem RGB 12 V z Homepage — ESP8266 + WLED

Cel: kafelek na Homepage, z którego jednym kliknięciem włączasz/wyłączasz pasek,
zmieniasz jasność i kolor — a przy okazji ten sam pasek staje się fizycznym
wskaźnikiem stanu JARVIS-a (backup padł → czerwony, serwer wstaje → niebieski).

> **Uwaga:** piny GPIO w tym dokumencie to propozycja. Podeślij zdjęcie płytki —
> dopiszę konkretne numery pod Twoje wyprowadzenia, bo na własnej płytce część
> pinów może być już zajęta (np. przez przetwornicę, przycisk albo diodę statusu).

---

## 1. Dlaczego WLED, a nie własny firmware

Pasek analogowy 12 V to trzy kanały PWM przez MOSFET-y — samo w sobie 40 linijek
Arduino. Ale WLED daje za darmo rzeczy, które inaczej pisałbyś tygodniami:
HTTP/JSON API, ~180 efektów, presety, harmonogram wschód/zachód, nightlight,
OTA, mDNS, MQTT, integrację z Home Assistant i gotowe UI mobilne — a to UI
wsadzimy prosto w Homepage jako iframe.

WLED obsługuje paski **nieadresowalne**: od 0.13.1 typy „single color, CCT, RGB,
RGBW i RGBCCT". RGB analogowy = **3 piny PWM**, po jednym na kolor.

Jedno zastrzeżenie sprzętowe: domyślna częstotliwość PWM to **880 Hz na ESP8266**
(vs 19 531 Hz na ESP32). Okiem tego nie widać, ale na nagraniach wideo pasek
będzie migał paskami, a przy bardzo niskiej jasności regulacja bywa skokowa.
Jeśli pasek ma trafić w kadr kamery albo pod biurko jako podświetlenie do nagrań
— rozważ ESP32. Do oświetlenia nastrojowego ESP8266 wystarczy.

---

## 2. Elektronika

```
   12 V (+)  ────────────────────────┬─────────────  pasek RGB, wspólna ANODA (+12V)
                                     │
   zasilacz 12 V                     │   pasek ma 4 przewody: +12V, R, G, B
        │                            │
        │                    ┌───────┴────────┬────────────────┬──────────────┐
        │                    │  R             │  G             │  B           │
        │              ┌─────┴─────┐    ┌─────┴─────┐    ┌─────┴─────┐
        │              │  MOSFET   │    │  MOSFET   │    │  MOSFET   │   IRLZ44N
        │              │  D  G  S  │    │  D  G  S  │    │  D  G  S  │   (logic-level!)
        │              └──┬──┬──┬──┘    └──┬──┬──┬──┘    └──┬──┬──┬──┘
        │                 │  │  │          │  │  │          │  │  │
   GND ─┴─────────────────┴──┼──┴──────────┴──┼──┴──────────┴──┼──┴─── GND wspólna
                             │                │                │
                        GPIO(R)          GPIO(G)          GPIO(B)   ← z ESP8266
                        przez 100-220 Ω  + rezystor 10 kΩ z bramki do GND
```

**Krytyczne szczegóły, na których łatwo się przejechać:**

1. **MOSFET musi być logic-level.** IRLZ44N, STP55NF06L albo AO3400 (do 24 V/3 A).
   Zwykły IRF540N **nie** otworzy się w pełni przy 3,3 V z ESP — pasek będzie
   przygaszony, a tranzystor będzie się grzał. Litera „L" w IRL*Z* to nie ozdoba.
2. **GND zasilacza 12 V i GND ESP muszą być wspólne.** Bez tego MOSFET nie ma
   odniesienia dla napięcia bramki i nic nie zadziała (albo zadziała losowo).
3. **Rezystor 10 kΩ z bramki do GND** na każdym kanale — trzyma tranzystor
   zamkniętym w czasie bootowania ESP, zanim firmware ustawi piny. Bez tego pasek
   błyśnie przy każdym restarcie.
4. **Rezystor 100–220 Ω szeregowo w bramkę** — ogranicza prąd szpilkowy z GPIO.
5. **Zasilanie ESP:** 12 V → przetwornica step-down na 5 V (albo 3,3 V, zależnie od
   płytki). Nie zasilaj ESP z 12 V bezpośrednio.
6. **Prąd paska:** 5 m paska RGB 12 V to typowo ~6 A na pełnej bieli. Sprawdź, czy
   zasilacz to udźwignie i czy przewody nie są za cienkie.

**Piny — propozycja dla „gołego" ESP-12/NodeMCU:**

| Kanał | GPIO | Etykieta NodeMCU | Dlaczego ten |
|---|---|---|---|
| R | GPIO5  | D1 | wolny przy starcie, brak funkcji boot-strap |
| G | GPIO4  | D2 | j.w. |
| B | GPIO14 | D5 | j.w. |

**Nie używaj** GPIO0, GPIO2, GPIO15 do sterowania paskiem — to piny strapujące
tryb bootowania. Podciągnięte/ściągnięte w złym momencie ESP nie wstanie albo
wejdzie w tryb programowania. GPIO16 też odpada (brak pełnego PWM).

---

## 3. Wgranie WLED

Najprościej z przeglądarki (Chrome/Edge, przez WebSerial): **https://install.wled.me**
— podłącz ESP kablem USB, wybierz wersję dla ESP8266, kliknij Install.

Po pierwszym starcie ESP tworzy sieć `WLED-AP` (hasło: `wled1234`).
Podłącz się i skonfiguruj Wi-Fi domowe.

**Konfiguracja LED (Config → LED Preferences):**

| Ustawienie | Wartość |
|---|---|
| LED Type | `PWM RGB` (w niektórych wersjach: `Analog RGB`) |
| Red GPIO | 5 |
| Green GPIO | 4 |
| Blue GPIO | 14 |
| Length | 1 |
| Max current | 0 (wyłącz limiter — analog go nie potrzebuje) |
| Auto-calculate brightness limiter | OFF |
| Reverse / Skip first | bez zmian |

**Config → Sync Interfaces:**
- Włącz mDNS: `wled-salon` → będzie dostępny jako `wled-salon.local`
- MQTT: opcjonalnie, ale polecam — patrz sekcja 6

**Config → Wi-Fi:** ustaw **statyczne IP** albo rezerwację DHCP na routerze.
Homepage będzie się do niego dobijać po adresie — nie chcesz, żeby się zmienił.

**Weryfikacja:** wejdź na `http://<IP_WLED>/` — powinno pokazać UI WLED,
a suwak jasności powinien realnie ściemniać pasek. Jeśli kolory są zamienione
(czerwony daje zielony), zamień numery pinów w konfiguracji — nie przelutowuj.

---

## 4. Test API z linii poleceń

Zanim wpinasz w Homepage, sprawdź, że API odpowiada (z malinki):

```bash
WLED=192.168.1.60

curl -s http://$WLED/json/info | head -c 300      # wersja, nazwa, uptime
curl -s http://$WLED/json/state                    # aktualny stan

# włącz / wyłącz / przełącz
curl -s -X POST -H 'Content-Type: application/json' -d '{"on":true}'  http://$WLED/json/state
curl -s -X POST -H 'Content-Type: application/json' -d '{"on":false}' http://$WLED/json/state
curl -s "http://$WLED/win&T=2"                     # toggle (stare, krótkie API)

# jasność 0-255
curl -s -X POST -H 'Content-Type: application/json' -d '{"bri":128}' http://$WLED/json/state

# kolor (RGB) na segmencie 0
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"on":true,"bri":200,"seg":[{"col":[[255,60,0]]}]}' http://$WLED/json/state

# preset nr 3
curl -s -X POST -H 'Content-Type: application/json' -d '{"ps":3}' http://$WLED/json/state
```

Jeśli te polecenia działają — reszta to już tylko interfejs.

---

## 5. Wpięcie w Homepage

Homepage nie ma natywnych przycisków ani suwaków w widgetach (to świadoma
decyzja projektu — widgety są tylko do odczytu). Są dwa widgety, które nas ratują:

- **`customapi`** — czyta JSON z dowolnego endpointu i pokazuje wybrane pola.
  Idealny do pokazania „ON / 78% / Sunrise" na kafelku.
- **`iframe`** — osadza dowolną stronę. Tu wchodzi sterowanie.

Robimy więc: kafelek `customapi` pokazuje **stan**, a pod nim `iframe` z małym
panelem sterowania (pliki w `wled-panel/`). Panel jedzie przez własny nginx,
który proxuje WLED-a — dzięki temu panel i API są na **tym samym origin**
i nie ma problemu z CORS-em.

Szczegóły w `docker-compose.yml`, `wled-panel/nginx.conf`,
`wled-panel/index.html` i `homepage-services.yaml`.

---

## 6. Pasek jako wskaźnik stanu JARVIS-a (to jest ta ciekawa część)

Pasek podłączony do sieci przestaje być tylko lampką. Kilka pomysłów, które
kosztują jedną linijkę `curl` w skryptach, które i tak już masz:

```bash
# w backup-malinka.sh, w gałęzi błędu — pasek na czerwono
curl -s -m 3 -X POST -H 'Content-Type: application/json' \
  -d '{"on":true,"bri":180,"seg":[{"col":[[255,0,0]]}]}' http://$WLED/json/state

# serwer wstaje po WoL — pulsujący niebieski (efekt "Breathe" = fx 2)
curl -s -m 3 -X POST -H 'Content-Type: application/json' \
  -d '{"on":true,"bri":120,"seg":[{"col":[[0,80,255]],"fx":2}]}' http://$WLED/json/state

# powrót do normalnego światła (preset 1)
curl -s -m 3 -X POST -H 'Content-Type: application/json' -d '{"ps":1}' http://$WLED/json/state
```

Gdzie to wpiąć:
- **backup**: `powiadom() ... err` w `backup-malinka.sh` → czerwony
- **Uptime Kuma**: notyfikacja typu Webhook → n8n → WLED
- **bot Discord**: `/led on|off|kolor <hex>` obok istniejącego `/power`
- **agent n8n**: nowe narzędzie `set_light` (patrz `n8n-narzedzie-set-light.md`)
  — wtedy „Jarvis, przygaś światło w salonie" działa z głosu bez nowego workflow

MQTT (jeśli postawisz Mosquitto) upraszcza to jeszcze bardziej: WLED subskrybuje
`wled/salon` i reaguje na `ON`, `OFF`, `128` (jasność) albo `#FF3300` (kolor) —
jedna publikacja zamiast HTTP POST-a.
