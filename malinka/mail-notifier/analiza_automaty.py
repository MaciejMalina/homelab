#!/usr/bin/env python3
"""TYLKO ODCZYT. Rozpoznanie pod nowe automaty:
  - jak wyglądają maile o paczkach (InPost/DPD/DHL/Poczta) — temat + fragment z kodem
  - kto przysyła faktury PDF (ostatnie 12 mies.) — pod pobieranie poczty w Paperlessie
  - czy są już maile z Peppera
Uruchom: docker exec -i mail_notifier python - < analiza_automaty.py"""
import email, email.policy, imaplib, os, re
from collections import Counter

def szukaj(im, q):
    if q.isascii():
        t, d = im.uid("SEARCH", None, "X-GM-RAW", f'"{q}"')
    else:  # polskie znaki: zapytanie jako literał UTF-8 (imaplib wysyła argumenty w ASCII)
        im.literal = q.encode("utf-8")
        t, d = im.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW")
    return (d[0] or b"").split() if t == "OK" else []

def pobierz(im, uidy, czesc="BODY.PEEK[]<0.40000>"):
    if not uidy:
        return []
    t, d = im.uid("FETCH", b",".join(uidy), f"({czesc})")
    return [email.message_from_bytes(x[1], policy=email.policy.default) for x in d if isinstance(x, tuple)]

def folder_wszystkie(im):
    """Folder „Wszystkie” (\\All) — nazwa zależy od języka Gmaila; brak → INBOX."""
    t, lista = im.list()
    for linia in lista or []:
        s = linia.decode(errors="replace")
        if "\\All" in s:
            m = re.search(r'"([^"]+)"\s*$', s)
            return m.group(1) if m else s.split()[-1]
    return "INBOX"

def tekst(m):
    for p in m.walk():
        if p.get_content_type() == "text/plain":
            try: return p.get_content()
            except Exception: pass
    for p in m.walk():
        if p.get_content_type() == "text/html":
            try: return re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(style|script|head)\b.*?</\1>", " ", p.get_content()))
            except Exception: pass
    return ""

for n in range(1, 10):
    u, p = os.environ.get(f"GMAIL_{n}_USER", ""), os.environ.get(f"GMAIL_{n}_PASS", "").replace(" ", "")
    if not (u and p):
        continue
    im = imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=120); im.login(u, p)
    folder = folder_wszystkie(im)
    im.select(f'"{folder}"', readonly=True)
    print(f"\n==================== {u}  [{folder}] ====================")

    print("\n--- PACZKI (ostatnie 8, 6 mies.) ---")
    uidy = szukaj(im, "newer_than:6m from:(inpost OR dpd OR dhl OR poczta-polska OR orlenpaczka OR gls)")
    print(f"  razem: {len(uidy)}")
    for m in pobierz(im, uidy[-8:]):
        t = re.sub(r"\s+", " ", tekst(m))
        kod = re.search(r"(kod(?:em)?\s+(?:odbioru|odbioru paczki)?[^0-9]{0,30})(\d{4,8})", t, re.I)
        print(f"  [{str(m.get('Date',''))[:16]}] {str(m.get('From',''))[:40]}")
        print(f"      temat: {str(m.get('Subject',''))[:90]}")
        print(f"      kod:   {kod.group(2) if kod else '—'}   | {t[:160]}")

    print("\n--- FAKTURY PDF (12 mies.) — nadawcy ---")
    uidy = szukaj(im, "newer_than:12m has:attachment filename:pdf (faktura OR fakturę OR rachunek OR invoice OR FV)")
    c = Counter()
    for m in pobierz(im, uidy[-400:], "BODY.PEEK[HEADER.FIELDS (FROM)]"):
        try: c[m["From"].addresses[0].addr_spec.lower()] += 1
        except Exception: pass
    print(f"  razem maili: {len(uidy)}")
    for a, k in c.most_common(20):
        print(f"  {k:>4}  {a}")

    print("\n--- PEPPER ---")
    uidy = szukaj(im, "from:pepper.pl")
    print(f"  maili z pepper.pl: {len(uidy)}")
    for m in pobierz(im, uidy[-3:], "BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]"):
        print(f"  [{str(m.get('Date',''))[:16]}] {str(m.get('From',''))[:40]} | {str(m.get('Subject',''))[:70]}")
    im.logout()
