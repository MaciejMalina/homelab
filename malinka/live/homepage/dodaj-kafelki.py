#!/usr/bin/env python3
"""Porządkuje ~/homepage/config/services.yaml (malinka), zostawiając resztę pliku bez zmian:
  1) usuwa kafelki pasujące do USUN (np. stary mountain-tracker na :8082),
  2) dopisuje brakujące kafelki z KAFELKI — do grupy GRUPA (nazwa grupy bez względu na wielkość liter),
     za ostatnim istniejącym w niej wpisem. Grupy z NOWE_NA_GORZE, których jeszcze nie ma, zakłada na górze pliku.
Przed zapisem robi kopię .bak-RRRRMMDD-HHMM.
Uruchomienie:  python3 ~/homepage/dodaj-kafelki.py            (zapis)
               python3 ~/homepage/dodaj-kafelki.py --podglad  (tylko pokaż, co by zrobił)"""
import os, re, shutil, sys, time

PLIK = os.path.expanduser("~/homepage/config/services.yaml")
PODGLAD = "--podglad" in sys.argv

KAFELKI = [  # (grupa, nazwa, linie pod nazwą)
    ("Zadania", "Lista TO DO", [
        "icon: mdi-format-list-checks",
        "href: https://malinka.tail0524ca.ts.net:8445",
        "description: Dodawaj tu albo /zadanie na Discordzie",
        "widget:",
        "  type: iframe",
        "  name: jarvis-todo",
        "  src: https://malinka.tail0524ca.ts.net:8445",
        "  classes: h-60 sm:h-60 md:h-60 lg:h-60 xl:h-60 2xl:h-72"]),
    ("Zarządzanie Infrastrukturą", "Vaultwarden", [
        "icon: vaultwarden.png",
        "href: https://malinka.tail0524ca.ts.net:10000",
        "description: Hasła (tylko tailnet)"]),
    ("Pliki i Produktywność", "Paperless GPT", [
        "icon: mdi-robot-outline",
        "href: http://100.93.105.37:8090",
        "description: AI porządkuje dokumenty (tylko tailnet)"]),
    ("Sztuczna Inteligencja", "Trener", [
        "icon: mdi-dumbbell",
        "href: https://malinka.tail0524ca.ts.net:8444",
        "description: Treningi z zegarka, siłownia, plan od AI (tylko tailnet)"]),
    ("Sieć i Bezpieczeństwo", "Łącze (speedtest)", [
        "icon: mdi-speedometer",
        "href: http://malinka:8084/",
        "description: Ostatni pomiar z malinki (uruchamiasz go w panelu, zakładka Sieć)",
        "widget:",
        "  type: customapi",
        "  url: http://192.168.254.10:8084/api/siec/speedtest",
        "  refreshInterval: 300000",
        "  mappings:",
        "    - field: dol",
        "      label: Pobieranie",
        "      format: float",
        '      suffix: " Mb/s"',
        "    - field: gora",
        "      label: Wysyłanie",
        "      format: float",
        '      suffix: " Mb/s"',
        "    - field: ts_ms",
        "      label: Pomiar",
        "      format: relativeDate"]),
]

# Kafelek jest usuwany, gdy jego nazwa albo którakolwiek linia pasuje do wzorca (wielkość liter bez znaczenia).
USUN = [r"mountain", r"localhost:8082\b", r"100\.105\.181\.54:8082\b", r"malinka[^\s]*:8082\b"]
NOWE_NA_GORZE = {"Zadania"}  # tych grup nie ma u Macieja — zakładamy je jako pierwsze w pliku
CHRONIONE = {k[1] for k in KAFELKI}  # nowych kafelków nigdy nie usuwamy

linie = open(PLIK, encoding="utf-8").read().splitlines()
zmiany = 0
wc_ = lambda l: len(l) - len(l.lstrip())

# --- 1) usuwanie ---------------------------------------------------------------
i = 0
while i < len(linie):
    m = re.match(r"^(\s+)-\s*(.+?)\s*:\s*$", linie[i])
    if not m:
        i += 1
        continue
    wc, nazwa = len(m.group(1)), m.group(2).strip("'\"")
    koniec = i + 1
    while koniec < len(linie) and (not linie[koniec].strip() or wc_(linie[koniec]) > wc):
        koniec += 1
    while koniec > i + 1 and not linie[koniec - 1].strip():
        koniec -= 1
    blok = "\n".join(linie[i:koniec])
    if nazwa not in CHRONIONE and any(re.search(w, blok, re.I) for w in USUN):
        print(f"- {nazwa}: usuwam ({koniec - i} linii)")
        del linie[i:koniec]
        zmiany += 1
        continue
    i = koniec

# --- 2) dodawanie --------------------------------------------------------------
for grupa, nazwa, pola in KAFELKI:
    if any(re.match(rf"\s*-\s*{re.escape(nazwa)}\s*:\s*$", l) for l in linie):
        print(f"= {nazwa}: już jest"); continue
    g = next((i for i, l in enumerate(linie) if re.match(rf"-\s*{re.escape(grupa)}\s*:\s*$", l, re.I)), None)
    if g is None and grupa in NOWE_NA_GORZE:
        g = next((i for i, l in enumerate(linie) if re.match(r"-\s*\S.*:\s*$", l)), len(linie))
        linie[g:g] = [f"- {grupa}:", ""]             # pusta linia oddziela od następnej grupy
        print(f"+ grupa „{grupa}”: założona na górze")
    if g is None:
        grupy = [l.strip()[1:].strip().rstrip(":") for l in linie if re.match(r"-\s*\S.*:\s*$", l)]
        print(f"! {nazwa}: nie znalazłem grupy „{grupa}” — pomijam. Grupy w pliku: {', '.join(grupy)}"); continue
    koniec = g + 1                                   # koniec grupy = następna linia bez wcięcia
    while koniec < len(linie) and (linie[koniec].startswith(" ") or not linie[koniec].strip()):
        koniec += 1
    while koniec > g + 1 and not linie[koniec - 1].strip():
        koniec -= 1                                  # nie wklejaj za pustymi liniami
    wpis = next((l for l in linie[g + 1:koniec] if re.match(r"\s+-\s", l)), "    - x:")
    wc = wc_(wpis)                                   # wcięcie wpisu w tej grupie (u Macieja 4)
    blok = [" " * wc + f"- {nazwa}:"] + [" " * (wc + 4) + p for p in pola]
    linie[koniec:koniec] = blok
    zmiany += 1
    print(f"+ {nazwa}: dodany do „{linie[g].strip()[1:].strip().rstrip(':')}”")

if zmiany and not PODGLAD:
    kopia = PLIK + time.strftime(".bak-%Y%m%d-%H%M")
    shutil.copy2(PLIK, kopia)
    open(PLIK, "w", encoding="utf-8").write("\n".join(linie) + "\n")
    print(f"Zapisano (kopia: {kopia}). Odśwież Homepage w przeglądarce.")
elif PODGLAD:
    print(f"Podgląd: {zmiany} zmian, plik bez zmian.")
