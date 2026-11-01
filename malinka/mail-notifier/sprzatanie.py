#!/usr/bin/env python3
"""Sprzątanie skrzynek Gmail (Odebrane) przez IMAP — domyślnie PRÓBA NA SUCHO.

  podgląd:   docker exec -i mail_notifier python - < sprzatanie.py
  wykonanie: docker exec -i -e WYKONAJ=1 mail_notifier python - < sprzatanie.py

Reguły (lista REGULY niżej): oznacz jako przeczytane / przenieś do Kosza.
Kosz: Gmail usuwa z niego maile na stałe po 30 dniach — do tego czasu można je przywrócić.
Używa haseł aplikacji z .env kontenera mail_notifier (GMAIL_<n>_USER / _PASS)."""
import email, email.policy, imaplib, os, re

WYKONAJ = os.environ.get("WYKONAJ") == "1"

# (opis, zapytanie Gmaila, akcja, konta: None = wszystkie, albo zbiór adresów)
REGULY = [
    ("Twitch — wszystko do Kosza",           "from:no-reply@twitch.tv",              "kosz",       None),
    ("Oferty starsze niż 6 mies. do Kosza",   "category:promotions older_than:6m",    "kosz",       None),
    ("Nieprzeczytane > 30 dni → przeczytane", "is:unread older_than:30d",            "przeczytaj", None),
]
PACZKA = 500


def szukaj(im, q):
    t, d = im.uid("SEARCH", None, "X-GM-RAW", f'"{q}"')
    if t != "OK":
        raise RuntimeError(f"SEARCH {q}: {d}")
    return (d[0] or b"").split()


def kosz_folder(im):
    t, lista = im.list()
    for linia in lista or []:
        s = linia.decode(errors="replace")
        if "\\Trash" in s:
            return re.search(r'"([^"]+)"\s*$', s).group(1) if s.rstrip().endswith('"') else s.split()[-1]
    raise RuntimeError("nie znalazłem folderu Kosza (\\Trash)")


def przyklady(im, uidy, n=4):
    if not uidy:
        return []
    t, d = im.uid("FETCH", b",".join(uidy[-n:]), "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
    out = []
    for x in d:
        if isinstance(x, tuple):
            m = email.message_from_bytes(x[1], policy=email.policy.default)
            out.append(f"{str(m.get('Date', ''))[:16]:16} | {str(m.get('From', ''))[:35]:35} | {str(m.get('Subject', ''))[:60]}")
    return out


print("TRYB:", "WYKONANIE" if WYKONAJ else "PRÓBA NA SUCHO (nic nie zmieniam; WYKONAJ=1 aby wykonać)")
for n in range(1, 10):
    u = os.environ.get(f"GMAIL_{n}_USER", "")
    p = os.environ.get(f"GMAIL_{n}_PASS", "").replace(" ", "")
    if not (u and p):
        continue
    im = imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=120)
    im.login(u, p)
    kosz = kosz_folder(im)
    im.select("INBOX", readonly=not WYKONAJ)
    print(f"\n==================== {u}  (Kosz: {kosz}) ====================")
    for opis, q, akcja, konta in REGULY:
        if konta and u not in konta:
            continue
        uidy = szukaj(im, q)
        print(f"\n  ▶ {opis}: {len(uidy)} maili   [{q}]")
        for l in przyklady(im, uidy):
            print("      ", l)
        if not WYKONAJ or not uidy:
            continue
        for i in range(0, len(uidy), PACZKA):
            zbior = b",".join(uidy[i:i + PACZKA])
            if akcja == "przeczytaj":
                t, d = im.uid("STORE", zbior, "+FLAGS.SILENT", "(\\Seen)")
            else:
                t, d = im.uid("COPY", zbior, f'"{kosz}"')
                if t == "OK":
                    im.uid("STORE", zbior, "+FLAGS.SILENT", "(\\Deleted)")
            if t != "OK":
                raise RuntimeError(f"{akcja}: {d}")
        if akcja == "kosz":
            im.expunge()
        print(f"      ✔ wykonano ({akcja})")
    im.logout()
print("\nGotowe.")
