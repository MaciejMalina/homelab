# JARVIS Agent (Windows)

Mały serwer HTTP (.NET 8) dla panelu na telefonie: temperatury i pobór CPU/GPU, RAM/VRAM, ping,
głośność, wyjście audio, mikser aplikacji, „co gra” (Spotify, przeglądarka…), uśpij/wyłącz,
wyciszenie mikrofonu i słuchawek w Discordzie, speedtest. Panel na malince jest jedynym klientem.

```powershell
# laptop (raz): .NET 8 SDK — winget install Microsoft.DotNet.SDK.8
cd jarvis\pc-agent
dotnet publish -c Release
# -> bin\Release\net8.0-windows10.0.19041.0\win-x64\publish\JarvisAgent.exe
```

Instalacja na każdym komputerze: skopiuj `JarvisAgent.exe` + `install.ps1` do jednego folderu i jako administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Nazwa gaming            # gaming PC
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Nazwa laptop -Token <ten sam>   # laptop
```

Skrypt kopiuje agenta do `C:\JarvisAgent`, tworzy `agent.json` z tokenem, otwiera port 8765 w zaporze
**tylko dla malinki** (192.168.254.10 i 100.105.181.54) i dodaje zadanie „JARVIS Agent” w Harmonogramie
(start po zalogowaniu, najwyższe uprawnienia — czujniki CPU wymagają admina).

API (nagłówek `X-Agent-Token`):

| | |
|---|---|
| `GET /api/stan` | CPU/GPU (temp, obciążenie, W), RAM, VRAM, dyski, ping |
| `GET /api/audio` | urządzenia wyjściowe, głośność, mikser aplikacji |
| `GET /api/media`, `GET /api/media/okladka/{id}` | co gra + okładka |
| `POST /api/audio/glosnosc {wartosc}` / `wycisz {wyciszony?}` / `wyjscie {id}` / `aplikacja {pid, glosnosc?, wyciszona?}` | |
| `POST /api/media/toggle\|nastepny\|poprzedni` | |
| `POST /api/zasilanie/uspij\|wylacz\|restart\|zablokuj` | |
| `POST /api/discord/mikrofon\|sluchawki` | naciska skróty z agent.json — ustaw te same w Discordzie |
| `POST /api/speedtest` | ping + 25 MB w dół / 10 MB w górę (Cloudflare) |
| `GET /api/procesy` | top 8 procesów wg CPU i wg RAM (zgrupowane po nazwie, próbka co 3 s) — od 1.1 |
| `POST /api/procesy/zakoncz {nazwa, pid?}` | kończy jedną instancję (pid) albo wszystkie o tej nazwie; tylko sesja użytkownika, bez chronionych (explorer, dwm, svchost…) — od 1.1 |

Uwagi:
- LibreHardwareMonitor czyta czujniki CPU przez sterownik jądra (starsze wersje: WinRing0). Jeśli Windows Defender go zgłosi,
  sprawdź, czy jest nowsza wersja pakietu `LibreHardwareMonitorLib` (projekt odchodzi od WinRing0) — bez sterownika
  agent działa dalej, tylko bez temperatury/poboru CPU.
- Zmiana wyjścia audio używa nieudokumentowanego `IPolicyConfig` (tak robią EarTrumpet/SoundSwitch).
- Log: `C:\JarvisAgent\agent.log`. Aktualizacja: nowy exe + ten sam `install.ps1` (token zostaje).
