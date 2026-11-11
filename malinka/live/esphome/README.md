# ESPHome - przedluzacze i sterownik LED

Konfiguracje urzadzen ESPHome (ESP-12F / ESP8266) przy biurku. Hasla w `secrets.yaml` - NIE w repo
(lokalnie: `%USERPROFILE%\.jarvis-esp\secrets.yaml`, klucze: wifi_ssid, wifi_password, ap_password, ota_password, web_password).

| Plik | Urzadzenie | IP | Przekazniki |
|---|---|---|---|
| przedluzacz-1.yaml | przedluzacz 1 | 192.168.254.40 | GPIO12 = Monitor, GPIO13 = Drukarka |
| przedluzacz-2.yaml | przedluzacz 2 | 192.168.254.41 | GPIO12 = Para A, GPIO13 = Para B |
| sterownik-led.yaml | sterownik RGBW (etap testowy) | 192.168.254.42 | kanaly do ustalenia |

Aktualizacja przez Wi-Fi: `esphome run --device <IP> <plik>.yaml`.
Pierwsze wgranie kablem: zlacze UART plytki 1=VCC 3,3 V, 2=GND, 3=RX, 4=TX; GPIO0 do GND przy starcie (pola FLASH
albo 1. i 4. pole od gory po lewej stronie modulu, antena w dol). Z malinki: UART3 (`sudo dtoverlay uart3`, piny 7/29),
esptool z `~/esp-venv`, predkosc 115200 przy plytce LED (460800 dawalo zaklocenia).
