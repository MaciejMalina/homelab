# JARVIS — nośnik malinki, backupy i kierunki rozwoju

Dokument uzupełnia audyt z 2026-07-06. Trzy części:
1. **Pendrive vs SSD** — odpowiedź na Twoje pytanie, z liczbami i procedurą migracji
2. **Backupy** — jak nowy backup malinki domyka zasadę 3-2-1
3. **Roadmapa** — pomysły na rozwój ekosystemu, pogrupowane, z oceną nakład/efekt

---

# 1. Pendrive na malince — tak, wymień go na SSD

## Dlaczego to jest pilniejsze, niż wygląda

Pendrive nie jest „małym SSD". Różnica jest jakościowa, nie ilościowa:

| | Pendrive | SSD (SATA/NVMe) |
|---|---|---|
| Kontroler | najprostszy, bez zaawansowanego wear-levelingu | pełny FTL, dynamiczne + statyczne wear-leveling |
| SMART / telemetria | **brak** | pełna: godziny pracy, TBW, realokacje, zużycie |
| TRIM | zwykle brak | tak |
| Nadmiarowość (over-provisioning) | ~0% | 7–28% |
| Ochrona przed utratą zasilania | brak | częściowa (lepsze modele) |
| Deklarowana wytrzymałość | niepodawana | 100–360 TBW |
| Sposób umierania | **nagle i po cichu** | stopniowo, z ostrzeżeniem w SMART |

Malinka to najgorszy możliwy scenariusz dla pendrive'a, bo pisze **bez przerwy**:
logi systemd, log zapytań AdGuarda (każde zapytanie DNS w domu!), baza Uptime
Kumy, stan kontenerów, dziennik bota. To są dziesiątki tysięcy drobnych zapisów
dziennie w te same obszary.

Najgorsze jest jednak nie to, że pendrive padnie — tylko **jak** padnie. Typowy
scenariusz to nie „nie wykrywa się", lecz ciche uszkodzenie sektorów: system
działa, ale baza się rozjeżdża, kontener startuje z uszkodzonym plikiem, a Ty
backupujesz już zepsute dane. Bez SMART nie masz jak tego zauważyć wcześniej.

A malinka to u Ciebie DNS dla całego domu, reverse proxy, bot i orkiestrator.
Jej awaria to nie „jedna usługa mniej" — to internet przestaje działać domownikom.

## Co kupić

**Rekomendacja: dysk SATA SSD 2,5" 240–500 GB + mostek USB3-SATA z UASP.**

Dlaczego nie NVMe: Raspberry Pi 4B nie ma wyprowadzonego PCIe (to dopiero Pi 5),
więc i tak wszystko idzie przez USB 3.0 — sufit ~350 MB/s. NVMe w obudowie USB
da dokładnie tyle samo, ale pobierze więcej prądu i mocniej się grzeje, a Pi 4
ma ograniczony budżet mocy na USB. SATA SSD jest tu optymalny.

Na co patrzeć:
- **TBW** — im więcej, tym dłużej pożyje. Modele z pamięcią DRAM (np. Crucial
  MX500, WD Blue) mają wyraźnie wyższe TBW niż budżetowe DRAM-less (BX500,
  Green). Przy malince różnica ceny jest niewielka, a życie dysku dłuższe.
- **Pojemność** — 240 GB w zupełności starczy, ale 500 GB daje więcej wolnych
  komórek do rotacji, więc dysk zużywa się wolniej. To najtańszy sposób na
  wydłużenie życia.
- **Mostek USB-SATA** — to element, na którym ludzie się przejeżdżają.
  Szukaj układu **ASMedia ASM1153E** albo **JMicron JMS578** (obsługują UASP).
  Unikaj bezimiennych przejściówek za kilkanaście złotych: część nie obsługuje
  UAS (spadek wydajności i wyższe obciążenie CPU), a część ma buga, który przy
  UAS powoduje losowe odmontowania — wtedy trzeba ratować się `usb-storage.quirks`
  w `cmdline.txt`, co z kolei wyłącza UAS i wracamy do punktu wyjścia.

Sprawdzenie, co masz po podłączeniu:

```bash
lsusb -t                    # szukaj "Driver=uas" a nie "Driver=usb-storage"
sudo smartctl -a /dev/sda   # jeśli zwraca dane SMART — mostek przepuszcza SAT
```

Jeśli `smartctl` nie działa, spróbuj `sudo smartctl -d sat -a /dev/sda`.
Mostek, który nie przepuszcza SMART, odbiera Ci połowę korzyści z przejścia na SSD.

**Zasilanie:** SSD przez USB pobiera ~2–5 W w szczycie. Przy słabym zasilaczu
malinka zacznie zgłaszać under-voltage (skrypt audytowy to wykryje —
`vcgencmd get_throttled`). Miej oficjalny zasilacz 5 V / 3 A. Jeśli podłączasz
też inne rzeczy po USB, rozważ zasilany hub.

## Procedura migracji (bez ryzyka)

Kolejność jest ważna: najpierw backup, potem migracja. Nie odwrotnie.

```bash
# 0. NAJPIERW zrób obraz obecnego pendrive'a nowym backupem (sekcja 2)
sudo /opt/jarvis/scripts/backup-malinka.sh full     # z serwera

# 1. Sprawdź bootloader Pi (musi umieć bootować z USB — nowe firmware umie)
sudo rpi-eeprom-update
vcgencmd bootloader_config | grep BOOT_ORDER    # 0xf41 = SD, potem USB; 0xf14 = USB, potem SD

# 2. Podłącz SSD (na razie jako drugi nośnik) i sprawdź, że działa z UAS
lsblk -o NAME,SIZE,TRAN,MODEL
lsusb -t | grep -i uas

# 3. Klonowanie — rpi-clone (używaj forka geerlingguy; oryginał billw2 jest
#    porzucony i ma problemy z nowszymi Raspberry Pi OS)
curl -sSL https://raw.githubusercontent.com/geerlingguy/rpi-clone/master/install | sudo bash
sudo rpi-clone sda -f          # sda = SSD; -f wymusza formatowanie
#    rpi-clone sam poprawia PARTUUID w /etc/fstab i cmdline.txt

#    Alternatywa bez dodatkowych narzędzi, gdyby rpi-clone sprawiał kłopoty:
#    ręcznie: sfdisk zrzut tablicy partycji -> mkfs -> rsync -aHAX -> ręczna
#    podmiana PARTUUID w /etc/fstab i /boot/firmware/cmdline.txt (blkid poda nowe)

# 4. Wyłącz malinkę, WYJMIJ pendrive, włącz. Powinna wstać z SSD.
sudo poweroff

# 5. Po starcie zweryfikuj
findmnt -no SOURCE /                       # /dev/sda2
lsblk -o NAME,TRAN,MODEL,MOUNTPOINT
sudo smartctl -a /dev/sda | head -30
```

**Pendrive zostaw w szufladzie jako awaryjny nośnik startowy.** Jeśli SSD padnie,
wtykasz pendrive i masz system sprzed migracji w 2 minuty. To najtańszy plan B,
jaki istnieje.

## Po migracji — higiena zapisów (zrób od razu)

```bash
# TRIM — utrzymuje wydajność i zmniejsza zużycie
sudo systemctl enable --now fstrim.timer

# log2ram — logi w RAM-ie, na dysk zrzucane raz dziennie
echo "deb [signed-by=/usr/share/keyrings/azlux.gpg] http://packages.azlux.fr/debian/ stable main" \
  | sudo tee /etc/apt/sources.list.d/azlux.list
sudo wget -O /usr/share/keyrings/azlux.gpg https://azlux.fr/repo.gpg
sudo apt update && sudo apt install -y log2ram
# w /etc/log2ram.conf: SIZE=128M, MAIL=false — potem reboot

# ogranicz journald (domyślnie potrafi zająć 4 GB i pisać bez przerwy)
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=64M\n' \
  | sudo tee /etc/systemd/journald.conf.d/00-jarvis.conf
sudo systemctl restart systemd-journald

# AdGuard: skróć retencję logu zapytań (Ustawienia -> Dziennik zapytań)
# 90 dni -> 7 dni to często największy pojedynczy źródło zapisów na malince
```

Te cztery rzeczy razem potrafią zmniejszyć dobową liczbę zapisów o rząd wielkości.
Warto je zrobić **nawet jeśli zostaniesz przy pendrivie** — wtedy tym bardziej.

---

# 2. Backupy — co się zmienia

## Co było nie tak

Audyt wskazał (P1): backupy leżą na tej samej macierzy co dane. RAID chroni
przed padem dysku, ale nie przed `rm -rf`, błędem skryptu, ransomware ani
pożarem. Do tego **malinka nie była backupowana wcale** — a to ona jest SPOF-em
całego systemu.

## Co dokładają nowe skrypty

**Model PULL, nie PUSH.** To serwer ciągnie dane z malinki, nie odwrotnie.
Konsekwencja jest istotna: malinka nie ma żadnego klucza zapisu do repozytorium
kopii. Gdyby ktoś przejął malinkę (a to ona jest wystawiona na świat przez
Funnela), nie skasuje backupów. Klucz idzie w drugą stronę i przez forced command
potrafi wyłącznie oddać dane — nie da się przez niego dostać powłoki.

**Dwie warstwy, bo ratują z różnych sytuacji:**

| Warstwa | Kiedy | Ratuje z |
|---|---|---|
| `rsync` rootfs → lustro na serwerze | codziennie 03:15 | „skasowałem plik", „zepsułem konfig" — kopiujesz jeden plik z powrotem |
| snapshot `restic` z lustra | codziennie | „zepsułem konfig **tydzień temu** i dopiero teraz zauważyłem" — historia wersji, deduplikacja |
| pełny obraz nośnika `.img.zst` | niedziela 03:40 | „pendrive padł" — wgrywasz obraz na nowy nośnik i malinka wstaje taka, jaka była |

**Retencja 30 dni** — zgodnie z Twoim życzeniem, z dwoma bezpiecznikami:
`restic` zawsze zostawia 7 ostatnich snapshotów, a czyszczenie obrazów nie
skasuje wszystkiego, jeśli nie ma ani jednego świeżego. Backup sprzed pół roku
jest lepszy niż brak backupu.

**Alert przy niepowodzeniu** — Discord i/lub ntfy. Sukces codziennego backupu
jest wyciszony (to byłby szum), ale każdy błąd i każdy backup tygodniowy
wysyła powiadomienie. To zamyka lukę z audytu: „dziś cichy fail backupu
pozostanie niezauważony".

**Lockfile** — skrypt zakłada `/etc/jarvis-no-autoshutdown` na starcie i kasuje
go w `trap EXIT`. To realizuje punkt 3 roadmapy z audytu i eliminuje wyścig
z idle-shutdownem.

## Czego wciąż brakuje do pełnego 3-2-1

Po wdrożeniu tych skryptów masz: **3** kopie (oryginał + lustro + restic),
na **2** nośnikach... ale wszystko **w jednym mieszkaniu**. Brakuje „1 offsite".

Trzy opcje, od najtańszej:

1. **Dysk USB u rodziny/w pracy** — restic przez sftp/tailscale, raz w tygodniu.
   Koszt: zero (masz już Tailscale). Wada: wymaga, żeby ten komputer był włączony.
2. **Backblaze B2** — restic natywnie, szyfrowanie po Twojej stronie, płacisz
   za GB. Dla samych konfiguracji i baz (bez Nextclouda) to grosze. Najprostsze.
3. **Drugi Raspberry Pi u kogoś** — jeśli lubisz sprzęt. Też przez Tailscale.

Do `backup.sh` na serwerze (tego istniejącego, dla danych serwera) dopisz na końcu:

```bash
# offsite — restic do B2, szyfrowane po stronie klienta
export RESTIC_REPOSITORY="b2:jarvis-offsite:/"
export RESTIC_PASSWORD_FILE=/etc/jarvis/restic-pass
export B2_ACCOUNT_ID="<SECRET>" B2_ACCOUNT_KEY="<SECRET>"
restic backup /mnt/data/backups/malinka /mnt/data/backups/latest --tag offsite
restic forget --tag offsite --keep-within 30d --keep-last 7 --prune
```

**I najważniejsze, o czym prawie wszyscy zapominają:** raz na kwartał odtwórz
backup na zapasowy nośnik i sprawdź, czy malinka z niego wstaje. Backup, którego
nigdy nie odtworzyłeś, to nie backup — to nadzieja.

---

# 3. Roadmapa — w co rozwijać ekosystem

Kolejność w każdej sekcji: od najlepszego stosunku efektu do nakładu.

## 3.1. Fundament — zrób to zanim dołożysz cokolwiek nowego

| Co | Nakład | Dlaczego to jest przed resztą |
|---|---|---|
| SSD zamiast pendrive'a + log2ram | 2 h + koszt dysku | Cała reszta stoi na tym nośniku |
| Backup malinki (skrypty z tej paczki) | 2 h | Bez tego każda kolejna zmiana zwiększa to, co masz do stracenia |
| Offsite (B2 albo dysk u rodziny) | 1 h | Domyka 3-2-1 |
| Forced command zamiast root SSH | 1 h | Największa powierzchnia ataku w całym systemie |
| Repo git na całą konfigurację | pół dnia | Odtworzenie systemu przestaje być archeologią |
| Uptime Kuma + ntfy | 2 h | Dziś bota nikt nie monitoruje |

Uwaga o **ntfy**: dopóki jedynym kanałem powiadomień jest Discord, Discord jest
SPOF-em komunikacji — jak padnie, JARVIS staje się niemy dokładnie wtedy, kiedy
najbardziej chcesz wiedzieć, co się dzieje. ntfy to jeden mały kontener na malince
i aplikacja na telefon. Push działa nawet gdy nie masz internetu na komputerze.

## 3.2. Niezawodność sprzętowa

**UPS.** Najbardziej niedoceniana rzecz w home-labie. Malinka pisze po nośniku
24/7 — nagły zanik zasilania to najczęstsza przyczyna uszkodzenia systemu plików.
Mały UPS (nawet ~500 VA) na malinkę + router + switch daje kilka godzin pracy,
a przez `nut` albo `apcupsd` malinka może dodatkowo wydać serwerowi polecenie
graceful shutdown przy dłuższej awarii. Bonus: internet działa, gdy sąsiadom nie.

**Inteligentne gniazdko (Tasmota/Shelly) na serwer.** Audyt już to wskazał jako
fallback dla WoL (który potrafi przestać działać po tygodniu przez ErP). Skoro
i tak wchodzisz w ESP-ki, to naturalne rozszerzenie: bot dostaje
`/hard_power_cycle`, a przy okazji masz pomiar poboru prądu — ładny wykres na
Homepage i realna odpowiedź na pytanie „ile mnie kosztuje ten serwer".

**Czujniki temperatury w miejscu, gdzie stoi sprzęt.** ESP8266 + DS18B20 to
kilkanaście złotych. Po wymianie na GTX 1070 Ti (180 W TDP vs 120 W) serwer
będzie grzał wyraźnie mocniej — warto wiedzieć, jak się to przekłada na
temperaturę w pomieszczeniu, zanim latem coś zacznie throttlować.

**Czujnik zalania przy pralce/bojlerze.** ESP + czujnik wody + ntfy. Kosztuje
tyle co kawa, a ratuje przed remontem.

## 3.3. IoT — skoro już zaczynasz od paska LED

Postaw **Mosquitto** (MQTT) na malince jako szynę dla urządzeń. Jeden mały
kontener, a wszystkie kolejne ESP-ki wpinają się w system bez pisania kodu:
publikują do brokera, n8n subskrybuje. Bez tego każde nowe urządzenie to nowy
webhook i nowy workflow.

Kolejne rzeczy, które wtedy „wpinają się same":

- **Pasek LED jako wskaźnik stanu** — backup padł → czerwony, serwer wstaje →
  pulsujący niebieski, wszystko OK → ciepła biel. Fizyczna informacja zwrotna,
  którą widzisz kątem oka bez patrzenia w telefon.
- **Wykrywanie obecności** — telefon pojawia się w Tailnecie/LAN → JARVIS wita
  i podaje status; wychodzisz → gasi światła, usypia serwer.
- **ESP32-CAM przy drzwiach** — po upgradzie GPU model multimodalny (`qwen2.5vl`)
  mieści się w 8 GB, więc „kto stoi pod drzwiami" da się opisać lokalnie.
- **Home Assistant** jako warstwa urządzeń obok n8n. n8n zostaje mózgiem
  przepływów, HA dostaje zmysły i kończyny. Wtedy „Jarvis, wyłącz wszystko na noc"
  ma co wykonać.

## 3.4. AI i autonomia

Po wymianie na 1070 Ti (8 GB) otwiera się to, co dziś jest zablokowane sufitem VRAM:

| Pomysł | Nakład | Efekt |
|---|---|---|
| `qwen3:8b` jako jedyny model + `KEEP_ALIVE=-1` | 2 h | Koniec żonglerki modelami i zimnych startów; natywny function-calling |
| Whisper na GPU (`faster-whisper small/medium int8_float16`) | 1 h | Latencja głosu spada kilkukrotnie, polszczyzna STT wyraźnie lepsza |
| Narzędzia agenta (`create_task`, `add_event`, `search_docs`, `power`, `set_light`) | 1–2 dni | Skokowy wzrost autonomii — nowe polecenia bez nowych workflow |
| Pamięć automatyczna zamiast słowa „zapamiętaj" | 1–2 dni | RAG przestaje gnić, dedup przez próg podobieństwa 0.9 |
| Piper TTS na malince | pół dnia | Domknięta pętla głosowa — najlepszy stosunek „wow" do nakładu |
| **Open WebUI** wpięte w istniejącą Ollamę | 1 h | Czat z historią i RAG w przeglądarce, zero nowego backendu |
| **Immich** z ML na GPU | pół dnia | Wyszukiwanie zdjęć opisem („zdjęcia z gór zimą") — i agent może po nich szukać |
| **Paperless-AI / paperless-gpt** | 2 h | Automatyczne tagowanie i tytułowanie dokumentów lokalnym modelem |
| **Karakeep** (dawniej Hoarder) | 2 h | Zakładki z automatycznym streszczeniem i tagowaniem; naturalne źródło dla RAG |
| **LiteLLM** jako router lokalny/chmura | pół dnia | Proste pytania lokalnie, trudne do API z limitem kosztów — prywatność domyślnie, bez sufitu VRAM |
| Identyfikacja mówcy (resemblyzer/speechbrain) | 2 dni | JARVIS wie, kto mówi; uprawnienia per osoba (tylko Ty wyłączasz serwer głosem) |
| Dziennik tygodniowy generowany przez LLM | 2 h | Nocne joby już zbierają maile, paragony, zadania — digest to prawie darmowa nadbudowa |

## 3.5. Obserwowalność

- **Beszel** — lekki monitoring (agent + hub), ARM-friendly, ładne wykresy CPU/RAM/
  dysk/kontenery. Znacznie taniej niż stos Prometheus+Grafana, a na home-lab
  w zupełności wystarcza. Jeśli chcesz pełny stos: Prometheus musi stać na
  **malince** (always-on), bo na usypianym serwerze zgubi połowę próbek.
- **Dozzle** — logi wszystkich kontenerów w przeglądarce, bez `docker logs -f`.
- **Diun** — powiadamia o nowych wersjach obrazów zamiast je automatycznie
  wgrywać (jak Watchtower). Aktualizujesz świadomie, po przeczytaniu changeloga.
- **Scrutiny** — SMART wszystkich dysków z historią i wykresami. Po przejściu
  na SSD w malince nabiera sensu też tam.
- **healthchecks** (self-hosted, na malince) — „dead man's switch" dla cronów.
  Jeśli backup nie zapinguje w oknie czasowym, dostajesz alert. To wychwytuje
  przypadek, którego Uptime Kuma nie widzi: skrypt, który w ogóle nie wystartował.

## 3.6. Bezpieczeństwo i porządek

- **Authelia albo Pocket ID** przed Funnelem zamiast wspólnego hasła basic auth —
  konta per osoba, odwoływalny dostęp, audyt logowań.
- **CrowdSec** na logach NPM — skuteczniejszy niż fail2ban, bo korzysta ze
  wspólnej listy adresów.
- **sops + age** — sekrety zaszyfrowane *w* repo git zamiast rozrzucone poza nim.
  Wtedy `git clone` naprawdę wystarcza do odtworzenia systemu.
- **Docker socket proxy** dla kontenerów, które potrzebują dostępu do Dockera
  (Homepage z discovery, Uptime Kuma). Dziś dajesz im pełny socket, co jest
  równoważne z rootem na hoście.
- **unattended-upgrades** na obu maszynach — same poprawki bezpieczeństwa.
- **Renovate albo Diun + git** — przypięte wersje obrazów (`:1.27.3` a nie
  `:latest`) aktualizowane przez PR-a, który sam przeczytasz.
- **Gitea/Forgejo** na serwerze — jeśli nie chcesz trzymać konfiguracji domu
  na GitHubie. Przy okazji dostajesz Actions runner do prostego CI.

## 3.7. Usługi „dla ludzi"

Te nie rozwijają AI, ale sprawiają, że reszta domu zauważa, po co ten serwer stoi:

- **Mealie** — przepisy z importem z linków; agent może zaproponować obiad
  z tego, co jest w spiżarni.
- **Actual Budget** — budżet domowy; pipeline paragonów, który już masz, może
  wpisywać wydatki automatycznie.
- **Linkwarden / Wallabag** — archiwum artykułów (i kolejne źródło dla RAG).
- **Stirling PDF** — scalanie, dzielenie, OCR PDF-ów bez wysyłania ich w świat.
- **Jellyfin** — po wymianie na 1070 Ti masz NVENC z Pascala, czyli sprzętowy
  transcoding wielu strumieni naraz.
- **Vaultwarden** — menedżer haseł. Pasuje tu szczególnie, bo **hasło do
  repozytorium restic musi gdzieś bezpiecznie leżeć** — ale nie na serwerze,
  który backupujesz.

---

# 4. Sugerowana kolejność na najbliższe tygodnie

1. **Puść oba skrypty audytowe** i przyślij raporty — dopiero wtedy wiadomo,
   co z powyższego jest już zrobione, a co nie. Wszystko poniżej może się
   przestawić w zależności od tego, co pokażą.
2. **SSD w malince** + log2ram + fstrim + ograniczenie logów AdGuarda.
3. **Backup malinki** wg `README-instalacja.md`, z testem odtworzenia.
4. **Forced command** zamiast klucza roota (audyt P1, punkt 2 roadmapy).
5. **Pasek LED**: WLED → panel → Homepage. Rzecz na jeden wieczór, a widać ją
   codziennie — dobra nagroda po czterech nudnych punktach wyżej.
6. **Uptime Kuma + ntfy** — system zaczyna sam mówić, że choruje.
7. **Repo git** na całą konfigurację.
8. Dopiero teraz **wymiana GPU** i migracja modeli na wariant A.
