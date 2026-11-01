#!/usr/bin/env python3
"""Analiza obu skrzynek Gmail (TYLKO ODCZYT: EXAMINE + BODY.PEEK — nic nie zmienia).
Uruchom na malince:  docker exec -i mail_notifier python - < analiza_skrzynek.py
Pokazuje: ile maili w kategoriach, ile nieprzeczytanych/starych i top nadawców
z ostatnich 6 miesięcy (z informacją, czy mają link do wypisania się)."""
import email, email.policy, imaplib, os, re
from collections import Counter

def ile(im, q):
    t, d = im.uid("SEARCH", None, "X-GM-RAW", f'"{q}"')
    return len((d[0] or b"").split()) if t == "OK" else -1

for n in range(1, 10):
    u = os.environ.get(f"GMAIL_{n}_USER", "")
    p = os.environ.get(f"GMAIL_{n}_PASS", "").replace(" ", "")
    if not (u and p):
        continue
    im = imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=60)
    im.login(u, p)
    im.select("INBOX", readonly=True)
    print(f"\n==================== {u} (Odebrane) ====================")
    for opis, q in [
        ("wszystkie", "in:inbox"), ("nieprzeczytane", "is:unread"),
        ("nieprzecz. starsze niż 30 dni", "is:unread older_than:30d"),
        ("starsze niż 1 rok", "older_than:1y"),
        ("kat. Główne", "category:primary"), ("kat. Oferty", "category:promotions"),
        ("kat. Społeczności", "category:social"), ("kat. Powiadomienia", "category:updates"),
        ("kat. Fora", "category:forums"), ("z załącznikiem > 5 MB", "larger:5M"),
    ]:
        print(f"  {opis:32} {ile(im, q):>6}")
    t, d = im.uid("SEARCH", None, "X-GM-RAW", '"newer_than:6m"')
    uidy = (d[0] or b"").split()[-3000:]
    nad, unsub = Counter(), {}
    for i in range(0, len(uidy), 300):
        t, dd = im.uid("FETCH", b",".join(uidy[i:i + 300]),
                       "(BODY.PEEK[HEADER.FIELDS (FROM LIST-UNSUBSCRIBE)])")
        for x in dd:
            if not isinstance(x, tuple):
                continue
            m = email.message_from_bytes(x[1], policy=email.policy.default)
            try:
                a = m["From"].addresses[0].addr_spec.lower()
            except Exception:
                a = re.sub(r".*<|>.*", "", str(m.get("From", "?"))).lower()
            nad[a] += 1
            unsub[a] = unsub.get(a, False) or bool(m.get("List-Unsubscribe"))
    print(f"  --- top nadawcy z ostatnich 6 mies. ({len(uidy)} maili) ---")
    for a, c in nad.most_common(20):
        print(f"  {c:>5}  {'[wypisz]' if unsub.get(a) else '        '}  {a}")
    im.logout()
