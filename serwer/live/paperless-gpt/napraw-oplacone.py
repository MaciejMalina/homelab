#!/usr/bin/env python3
"""Paperless: oznacza jako opłacone faktury dodane od podanej daty i usuwa z nich „Termin płatności”.

Po co: pierwszy przebieg paperless-gpt (2026-10-20) wpisał termin płatności do starych, dawno
opłaconych faktur, więc poranny brief pokazywał je jako „po terminie”.

Dotyczy dokumentów, które:
  - zostały dodane do Paperlessa OD dnia OD_DNIA (domyślnie 2026-10-20),
  - mają przypięte pole „Termin płatności” (z wartością albo puste).
Zmiana: pole „Termin płatności” zostaje odpięte, „Zapłacone” = tak. Reszta pól (Kwota itd.) bez zmian.

Domyślnie PRÓBA NA SUCHO — tylko wypisuje listę. Uruchomienie na serwerze:
  podgląd:   python3 napraw-oplacone.py
  wykonanie: WYKONAJ=1 python3 napraw-oplacone.py
Token z /opt/jarvis/paperless-gpt/.env (PAPERLESS_API_TOKEN) albo ze zmiennej PAPERLESS_API_TOKEN.
"""
import json, os, sys, urllib.parse, urllib.request
from datetime import date, timedelta

URL = os.environ.get("PAPERLESS_URL", "http://localhost:8010").rstrip("/")
OD_DNIA = os.environ.get("OD_DNIA", "2026-10-20")
WYKONAJ = os.environ.get("WYKONAJ") == "1"
POLE_TERMIN, POLE_ZAPLACONE = "Termin płatności", "Zapłacone"


def token():
    t = os.environ.get("PAPERLESS_API_TOKEN", "").strip()
    if t:
        return t
    try:
        with open("/opt/jarvis/paperless-gpt/.env", encoding="utf-8") as f:
            for linia in f:
                if linia.startswith("PAPERLESS_API_TOKEN="):
                    return linia.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    sys.exit("Brak tokenu: ustaw PAPERLESS_API_TOKEN albo uruchom na serwerze (czyta /opt/jarvis/paperless-gpt/.env)")


NAGLOWKI = {"Authorization": f"Token {token()}", "Accept": "application/json; version=9"}


def api(metoda, sciezka, dane=None):
    url = sciezka if sciezka.startswith("http") else URL + sciezka
    body = json.dumps(dane).encode() if dane is not None else None
    req = urllib.request.Request(url, data=body, method=metoda,
                                 headers={**NAGLOWKI, **({"Content-Type": "application/json"} if body else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def wszystkie(sciezka):
    wynik, url = [], sciezka
    while url:
        s = api("GET", url)
        wynik += s.get("results", [])
        url = s.get("next")
        if url:
            # „next” może mieć inny host/protokół (proxy) — zostaw tylko ścieżkę i pytaj URL-a z góry
            p = urllib.parse.urlsplit(url)
            url = p.path + ("?" + p.query if p.query else "")
    return wynik


pola = {f["name"]: f["id"] for f in wszystkie("/api/custom_fields/?page_size=100")}
if POLE_TERMIN not in pola or POLE_ZAPLACONE not in pola:
    sys.exit(f"Nie ma pól „{POLE_TERMIN}” / „{POLE_ZAPLACONE}” w Paperlessie (są: {', '.join(pola)})")
ID_T, ID_Z = pola[POLE_TERMIN], pola[POLE_ZAPLACONE]
dzien_przed = (date.fromisoformat(OD_DNIA) - timedelta(days=1)).isoformat()
q = urllib.parse.urlencode({"page_size": 100, "custom_fields__id__in": ID_T, "added__date__gt": dzien_przed,
                            "ordering": "added", "fields": "id,title,added,custom_fields"})
docs = wszystkie(f"/api/documents/?{q}")

print("TRYB:", "WYKONANIE" if WYKONAJ else "PRÓBA NA SUCHO (WYKONAJ=1 aby zmienić)")
print(f"Dokumenty dodane od {OD_DNIA} z polem „{POLE_TERMIN}”: {len(docs)}\n")
zmienione = 0
for d in docs:
    cf = d.get("custom_fields") or []
    if not any(c["field"] == ID_T for c in cf):
        continue                                   # filtr API już to robi — bezpiecznik
    termin = next((c["value"] for c in cf if c["field"] == ID_T), None)
    nowe = [{"field": c["field"], "value": c["value"]} for c in cf if c["field"] not in (ID_T, ID_Z)]
    nowe.append({"field": ID_Z, "value": True})
    print(f"  #{d['id']:<5} {str(d.get('added', ''))[:10]}  termin: {termin or '—':<10}  {str(d.get('title', ''))[:70]}")
    if WYKONAJ:
        api("PATCH", f"/api/documents/{d['id']}/", {"custom_fields": nowe})
        zmienione += 1
print(f"\n{'Zmieniono' if WYKONAJ else 'Do zmiany'}: {zmienione if WYKONAJ else len(docs)}")
