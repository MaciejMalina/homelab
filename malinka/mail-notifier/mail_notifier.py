#!/usr/bin/env python3
"""
JARVIS mail-notifier (malinka) — powiadomienia Discord o nowych mailach z zakładki
„Główne” w Gmailu. Zastępuje n8n-lite: sama biblioteka standardowa, ~20 MB RAM.

- IMAP, skrzynka otwierana TYLKO do odczytu (EXAMINE + BODY.PEEK) — nic nie oznacza
  jako przeczytane.
- Bierze wszystkie nowe nieprzeczytane z Odebranych (FILTR, domyślnie "is:unread") i klasyfikuje
  regułami z /config/reguly.json (przeładowywane co obieg, bez restartu):
  „zawsze” (paczki, okazje; warunek na temat albo treść) > kod 2FA w temacie > ważni nadawcy
  > śmieciowi nadawcy > śmieciowe słowa > karty Oferty/Społeczności/Fora
  > nagłówek List-Unsubscribe (mailing) > ważne słowa w temacie
  > reszta do podsumowania (albo powiadom, gdy "domyslnie_powiadom": true w reguly.json).
  Ważne -> powiadomienie na Discord; reszta -> raz dziennie (DIGEST_GODZINA) lista tematów.
- 🔑 Kod 2FA i 📦 kod odbioru paczki od razu w tytule powiadomienia. Te dwa typy przychodzą
  zawsze, także w ciszy nocnej.
- Cisza nocna (CISZA, domyślnie 23:00-07:00): pozostałe ważne maile czekają i po ciszy
  przychodzą jedną wiadomością.
- Przypomnienie, gdy ważny mail leży nieprzeczytany PRZYPOMNIJ_PO_H godzin (domyślnie 24).
  Sprawdza flagę \\Seen przez IMAP, sam niczego nie oznacza.
- W dziennym podsumowaniu: maks. 3 nadawców, o których często powiadamiamy, a mają nagłówek
  List-Unsubscribe — kandydaci do smieci_nadawcy (ten sam nadawca najwyżej raz na 7 dni).
- Stan (ostatni UID per konto, zaległe, przypomnienia, statystyki) w /state/stan.json — po restarcie
  nie dubluje i nie zalewa zaległościami (pierwsze uruchomienie tylko zapamiętuje pozycję).
- >3 nowe zwykłe maile w jednym obiegu -> jeden zbiorczy embed.
- Opcjonalny heartbeat do Uptime Kuma (KUMA_PUSH_URL) + alert na Discord po
  ALERT_PO kolejnych błędach logowania/połączenia danego konta.

Konfiguracja przez zmienne środowiskowe (.env):
  DISCORD_WEBHOOK, DISCORD_USER_ID, GMAIL_1_USER, GMAIL_1_PASS, [GMAIL_2_USER, GMAIL_2_PASS, ...],
  INTERWAL (s, domyślnie 60), FILTR (domyślnie "is:unread"), KUMA_PUSH_URL, ALERT_PO (5), KUMA_PO (3),
  DIGEST_GODZINA (HH:MM, domyślnie 07:30), REGULY_PLIK (/config/reguly.json),
  CISZA (HH:MM-HH:MM, domyślnie 23:00-07:00; puste = bez ciszy), PRZYPOMNIJ_PO_H (24; 0 = wyłączone)
"""
import email
import email.policy
import html
import imaplib
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "").strip()
USER_ID = os.environ.get("DISCORD_USER_ID", "").strip()
INTERWAL = max(30, int(os.environ.get("INTERWAL", "60")))
FILTR = os.environ.get("FILTR", "is:unread").strip()
KUMA = os.environ.get("KUMA_PUSH_URL", "").strip()
ALERT_PO = int(os.environ.get("ALERT_PO", "5"))
KUMA_PO = int(os.environ.get("KUMA_PO", "3"))   # ile obiegów z błędem, zanim Kuma dostanie "down"
STAN_PLIK = os.environ.get("STAN_PLIK", "/state/stan.json")
MAKS_POBRAN = 20          # ile WAŻNYCH maili maks. pobierać w całości w jednym obiegu (reszta bez zajawki)
MAKS_NAGLOWKOW = 200      # ile nowych maili maks. klasyfikować w jednym obiegu
MAKS_POMINIETYCH = 300    # ile tematów maks. trzymać do dziennego podsumowania
MAKS_ZALEGLYCH = 100      # ile ważnych maks. trzymać w ciszy nocnej
MAKS_PRZYPOMNIEN = 200
MAKS_NADAWCOW = 500       # statystyki pod podpowiedzi
PODPOWIEDZ_PROG = 3       # od ilu powiadomień z List-Unsubscribe (w 30 dni) podpowiadać nadawcę
REGULY_PLIK = os.environ.get("REGULY_PLIK", "/config/reguly.json")
DIGEST_GODZINA = os.environ.get("DIGEST_GODZINA", "07:30").strip()
CISZA = os.environ.get("CISZA", "23:00-07:00").strip()
PRZYPOMNIJ_PO_H = float(os.environ.get("PRZYPOMNIJ_PO_H", "24") or 0)

TYPY = ("zwykly", "paczka", "okazja", "2fa")
PILNE = {"2fa", "paczka"}            # przychodzą od razu, także w ciszy nocnej
IKONY = {"okazja": "🔥 ", "paczka": "📦 ", "2fa": "🔑 "}

# Kod jednorazowy: fraza o kodzie + liczba 4–8 cyfr w pobliżu (nie część daty, kwoty ani numeru)
WZOR_2FA = re.compile(
    r"kod\w*\s+(weryfik|logowani|bezpiecze|jednorazow|autoryz|dostęp|sms)|"
    r"verification code|security code|login code|sign[- ]in code|one[- ]time (pass)?code|\bOTP\b|\b2FA\b",
    re.I)
LICZBA = re.compile(r"(?<![\d.,:/])(\d{4,8})(?![\d.,:/-])")
KOD_ODBIORU = re.compile(r"kod(?:em)?\s+odbioru\D{0,30}?(\d{4,8})(?!\d)", re.I)

KONTA = []
for i in range(1, 10):
    u, p = os.environ.get(f"GMAIL_{i}_USER", "").strip(), os.environ.get(f"GMAIL_{i}_PASS", "").replace(" ", "")
    if u and p:
        # FILTR_<n> nadpisuje FILTR dla jednego konta (np. konto bez kart Główne/Oferty)
        KONTA.append((u, p, os.environ.get(f"GMAIL_{i}_FILTR", "").strip() or FILTR))

koniec = False


def log(msg):
    print(f"{datetime.now().strftime('%F %T')} {msg}", flush=True)


def stop(*_):
    global koniec
    koniec = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


# ---------------------------------------------------------------- cisza nocna
def _cisza_zakres():
    m = re.fullmatch(r"\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*", CISZA or "")
    return (m.group(1), m.group(2)) if m else None


CISZA_ZAKRES = _cisza_zakres()


def w_ciszy(teraz=None):
    if not CISZA_ZAKRES:
        return False
    od, do = CISZA_ZAKRES
    t = (teraz or datetime.now()).strftime("%H:%M")
    return (t >= od or t < do) if od > do else (od <= t < do)


# ---------------------------------------------------------------- stan
def wczytaj_stan():
    try:
        with open(STAN_PLIK, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def zapisz_stan(stan):
    tmp = STAN_PLIK + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(stan, f, indent=1, ensure_ascii=False)
    os.replace(tmp, STAN_PLIK)


# ---------------------------------------------------------------- Discord / Kuma
def http_post_json(url, payload, proby=3):
    dane = json.dumps(payload).encode()
    for _ in range(proby):
        req = urllib.request.Request(url, data=dane, headers={"Content-Type": "application/json",
                                                              "User-Agent": "jarvis-mail-notifier"})
        try:
            with urllib.request.urlopen(req, timeout=15):
                return True
        except urllib.error.HTTPError as e:
            if e.code == 429:
                try:
                    czekaj = float(json.loads(e.read() or b"{}").get("retry_after", 2))
                except ValueError:
                    czekaj = 2
                time.sleep(min(czekaj, 30) + 0.5)
                continue
            log(f"Discord HTTP {e.code}: {e.read()[:200]!r}")
            return False
        except Exception as e:  # sieć
            log(f"Discord błąd: {e}")
            time.sleep(3)
    return False


def discord(embeds, ping=True):
    if not WEBHOOK:
        log("Brak DISCORD_WEBHOOK — pomijam wysyłkę")
        return False
    payload = {"embeds": embeds}
    if USER_ID and ping:
        payload["content"] = f"<@{USER_ID}> 📧"
        payload["allowed_mentions"] = {"users": [USER_ID]}
    return http_post_json(WEBHOOK, payload)


def kuma(status, msg):
    if not KUMA:
        return
    q = urllib.parse.urlencode({"status": status, "msg": msg[:100], "ping": ""})
    try:
        urllib.request.urlopen(f"{KUMA.split('?')[0]}?{q}", timeout=10).close()
    except Exception as e:
        log(f"Kuma push błąd: {e}")


# ---------------------------------------------------------------- parsowanie maila
def tekst_z_maila(msg):
    czesc_html = None
    for part in msg.walk():
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        typ = part.get_content_type()
        try:
            tresc = part.get_content()
        except Exception:
            continue
        if typ == "text/plain" and isinstance(tresc, str) and tresc.strip():
            return tresc
        if typ == "text/html" and czesc_html is None and isinstance(tresc, str):
            czesc_html = tresc
    if czesc_html:
        t = re.sub(r"(?is)<(script|style|head)\b.*?</\1>", " ", czesc_html)
        return html.unescape(re.sub(r"<[^>]+>", " ", t))
    return ""


def zajawka(tekst, n=300):
    t = re.sub(r"(?m)^>.*$", "", tekst)                 # cytaty
    t = re.sub(r"\s+", " ", t).strip()
    return (t[:n] + "…") if len(t) > n else t


def nadawca(msg):
    od = msg.get("From", "") or ""
    try:
        adr = msg["From"].addresses[0]
        return adr.display_name or adr.addr_spec
    except Exception:
        return re.sub(r"\s*<[^>]+>$", "", str(od)) or "(nieznany)"


def adres_nadawcy(msg):
    try:
        return msg["From"].addresses[0].addr_spec.lower()
    except Exception:
        m = re.search(r"[\w.+-]+@[\w.-]+", str(msg.get("From", "")))
        return m.group(0).lower() if m else ""


def kod_2fa(temat, tekst="", pewny=False):
    """Kod jednorazowy z tematu albo treści; None, gdy nie ma frazy o kodzie z liczbą obok.
    pewny=True (temat już mówi o kodzie): awaryjnie pierwsza samodzielna liczba 6-cyfrowa z treści."""
    tekst = re.sub(r"\s+", " ", tekst or "")[:6000]
    for zrodlo in (temat or "", tekst):
        for m in WZOR_2FA.finditer(zrodlo):
            po = [k.group(1) for k in LICZBA.finditer(zrodlo[m.end():m.end() + 120])]
            przed = [k.group(1) for k in LICZBA.finditer(zrodlo[max(0, m.start() - 60):m.start()])][::-1]
            for k in po + przed:            # najpierw po frazie, potem najbliższa przed nią
                if len(k) == 4 and k[:2] in ("19", "20"):
                    continue                # rok, nie kod
                return k
    if pewny:
        k = next((k.group(1) for k in LICZBA.finditer(tekst[:2000]) if len(k.group(1)) == 6), None)
        if k:
            return k
    return None


def kod_odbioru(tekst):
    m = KOD_ODBIORU.search(re.sub(r"\s+", " ", tekst or ""))
    return m.group(1) if m else None


# ---------------------------------------------------------------- reguły
def wczytaj_reguly():
    """dict z listami; {} gdy brak pliku; None gdy plik jest błędny (zostają poprzednie reguły)."""
    try:
        with open(REGULY_PLIK, encoding="utf-8") as f:
            r = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as e:
        log(f"reguly.json: błąd ({e}) — zostają poprzednie reguły")
        return None
    wynik = {}
    for k in ("wazne_nadawcy", "smieci_nadawcy"):
        wynik[k] = [str(x).lower().strip() for x in r.get(k, []) if str(x).strip()]
    for k in ("wazne_slowa", "smieci_slowa"):
        wynik[k] = []
        for x in r.get(k, []):
            try:
                wynik[k].append(re.compile(str(x), re.I))
            except re.error as e:
                log(f"reguly.json: pomijam błędny wzorzec {x!r} ({e})")
    wynik["zawsze"] = []
    for x in r.get("zawsze", []):
        if not isinstance(x, dict) or not x.get("nadawca"):
            continue
        nad = x["nadawca"] if isinstance(x["nadawca"], list) else [x["nadawca"]]
        try:
            wynik["zawsze"].append({
                "nadawca": [str(n).lower().strip() for n in nad if str(n).strip()],
                "temat": re.compile(str(x["temat"]), re.I) if x.get("temat") else None,
                "bez": re.compile(str(x["bez"]), re.I) if x.get("bez") else None,
                "tresc": re.compile(str(x["tresc"]), re.I) if x.get("tresc") else None,
                "typ": x.get("typ") if x.get("typ") in TYPY else "zwykly",
            })
        except re.error as e:
            log(f"reguly.json: pomijam regułę zawsze {x!r} ({e})")
    wynik["domyslnie_powiadom"] = bool(r.get("domyslnie_powiadom", False))
    return wynik


def pasuje_adres(adres, lista):
    """Wpis z @ = dokładny adres; bez @ = domena razem z subdomenami; "*" = każdy nadawca."""
    dom = adres.rsplit("@", 1)[-1]
    for w in lista:
        if w == "*" or ("@" in w and adres == w) or ("@" not in w and (dom == w or dom.endswith("." + w))):
            return True
    return False


def klasyfikuj(adres, temat, kategoria, mailing, r, tresc=lambda: ""):
    """(True = powiadom / False = do podsumowania, powód, typ).
    tresc() zwraca tekst maila — pobierany tylko, gdy reguła „zawsze” ma warunek „tresc”."""
    for z in r.get("zawsze", []):
        if not pasuje_adres(adres, z["nadawca"]):
            continue
        if z["temat"] and not z["temat"].search(temat):
            continue
        if z["bez"] and z["bez"].search(temat):
            continue
        if z.get("tresc") and not z["tresc"].search(tresc()):
            continue
        return True, f"zawsze ({z['typ']})", z["typ"]
    if WZOR_2FA.search(temat):
        return True, "kod 2FA w temacie", "2fa"
    if pasuje_adres(adres, r.get("wazne_nadawcy", [])):
        return True, "ważny nadawca", "zwykly"
    if pasuje_adres(adres, r.get("smieci_nadawcy", [])):
        return False, "śmieciowy nadawca", None
    for w in r.get("smieci_slowa", []):
        if w.search(temat):
            return False, f"śmieciowe słowo /{w.pattern}/", None
    if kategoria:
        return False, f"karta {kategoria}", None
    if mailing:                                     # mailing przed ważnymi słowami: reklama „płatności” to nadal reklama
        return False, "mailing (List-Unsubscribe)", None
    for w in r.get("wazne_slowa", []):
        if w.search(temat):
            return True, f"ważne słowo /{w.pattern}/", "zwykly"
    if r.get("domyslnie_powiadom"):
        return True, "domyślnie", "zwykly"
    return False, "nie pasuje do żadnej reguły ważnych", None


# ---------------------------------------------------------------- statystyki pod podpowiedzi
def notuj_nadawce(stan, adres, nazwa, mailing):
    if not adres:
        return
    st = stan.setdefault("nadawcy", {})
    s = st.setdefault(adres, {"n": 0, "mailing": 0})
    s["n"] += 1
    s["mailing"] += 1 if mailing else 0
    s["nazwa"] = nazwa[:60]
    s["ostatnio"] = date.today().isoformat()
    if len(st) > MAKS_NADAWCOW:                     # wyrzuć najdawniej widzianych
        for a, _ in sorted(st.items(), key=lambda kv: kv[1].get("ostatnio", ""))[:len(st) - MAKS_NADAWCOW]:
            del st[a]


def podpowiedzi(stan, reguly):
    """Do 3 nadawców: często powiadamiani, z List-Unsubscribe, nie w żadnej liście, nie podpowiadani od 7 dni."""
    dzis = date.today()
    granica = (dzis - timedelta(days=30)).isoformat()
    st = stan.get("nadawcy", {})
    for a in [a for a, s in st.items() if s.get("ostatnio", "") < granica]:
        del st[a]
    pp = stan.get("podpowiedziane", {})
    kand = []
    for adr, s in st.items():
        if s.get("mailing", 0) < PODPOWIEDZ_PROG:
            continue
        if pasuje_adres(adr, reguly.get("wazne_nadawcy", [])) or pasuje_adres(adr, reguly.get("smieci_nadawcy", [])):
            continue
        ost = pp.get(adr)
        if ost and (dzis - date.fromisoformat(ost)).days < 7:
            continue
        kand.append((s["mailing"], adr, s))
    kand.sort(key=lambda k: (-k[0], k[1]))
    return [(adr, s) for _, adr, s in kand[:3]]


# ---------------------------------------------------------------- IMAP
def uidy_z(im, ostatni, zapytanie):
    typ, dane = im.uid("SEARCH", None, "UID", f"{ostatni + 1}:*", "X-GM-RAW", f'"{zapytanie}"')
    if typ != "OK":
        raise RuntimeError(f"SEARCH {zapytanie}: {dane}")
    return {u for u in (int(x) for x in (dane[0] or b"").split()) if u > ostatni}


def do_przypomnienia(im, user, uidvalidity, stan):
    """Ważne maile sprzed PRZYPOMNIJ_PO_H godzin, które nadal są nieprzeczytane w Odebranych."""
    lista = stan.get("przypomnienia", [])
    if PRZYPOMNIJ_PO_H <= 0 or w_ciszy() or not lista:
        return []
    teraz = time.time()
    dojrzale = [p for p in lista if p["konto"] == user
                and (p.get("uv") != uidvalidity or teraz - p["ts"] >= PRZYPOMNIJ_PO_H * 3600)]
    if not dojrzale:
        return []
    sprawdz = [p for p in dojrzale if p.get("uv") == uidvalidity]
    nieprzeczytane = set()
    if sprawdz:
        typ, d = im.uid("SEARCH", None, "UID", ",".join(str(p["uid"]) for p in sprawdz), "UNSEEN")
        if typ != "OK":
            return []                               # spróbuje w następnym obiegu
        nieprzeczytane = {int(x) for x in (d[0] or b"").split()}
    usun = {id(p) for p in dojrzale}
    stan["przypomnienia"] = [p for p in lista if id(p) not in usun]
    return [p for p in sprawdz if p["uid"] in nieprzeczytane]


def sprawdz_konto(user, haslo, filtr, stan, reguly):
    """Zwraca (ważne [dict], pominięte [{konto, temat}], przypomnienia [dict])."""
    s = stan.setdefault(user, {})
    konto = user.split("@")[0]
    with imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=30) as im:
        im.login(user, haslo)
        typ, d = im.status("INBOX", "(UIDNEXT UIDVALIDITY)")
        if typ != "OK":
            raise RuntimeError(f"STATUS INBOX: {d}")
        st = d[0].decode(errors="replace")
        maks_uid = int(re.search(r"UIDNEXT (\d+)", st).group(1)) - 1
        uidvalidity = int(re.search(r"UIDVALIDITY (\d+)", st).group(1))
        typ, _ = im.select("INBOX", readonly=True)        # EXAMINE — tylko odczyt
        if typ != "OK":
            raise RuntimeError("nie mogę otworzyć INBOX")
        if s.get("uidvalidity") != uidvalidity or "ostatni_uid" not in s:
            s.update(uidvalidity=uidvalidity, ostatni_uid=maks_uid)
            log(f"{user}: start od UID {maks_uid} (bez powiadomień o starszych)")
            return [], [], []
        przypomnij = do_przypomnienia(im, user, uidvalidity, stan)
        ostatni = int(s["ostatni_uid"])
        if maks_uid <= ostatni:
            return [], [], przypomnij
        uidy = sorted(uidy_z(im, ostatni, filtr))
        kategoria = {}
        if uidy:
            for nazwa, q in (("Oferty", "category:promotions"), ("Społeczności", "category:social"),
                             ("Fora", "category:forums")):
                for u in uidy_z(im, ostatni, q):
                    kategoria.setdefault(u, nazwa)
        if len(uidy) > MAKS_NAGLOWKOW:
            log(f"{user}: {len(uidy)} nowych — klasyfikuję tylko {MAKS_NAGLOWKOW} najnowszych")
            uidy = uidy[-MAKS_NAGLOWKOW:]
        wazne, pominiete = [], []
        for uid in uidy:
            typ, d = im.uid("FETCH", str(uid), "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT LIST-UNSUBSCRIBE)])")
            surowe = next((x[1] for x in d if isinstance(x, tuple)), None)
            if not surowe:
                continue
            h = email.message_from_bytes(surowe, policy=email.policy.default)
            adres = adres_nadawcy(h)
            temat = str(h.get("Subject", "") or "(bez tematu)")
            mailing = bool(h.get("List-Unsubscribe"))
            cache = {}

            def tresc(uid=uid, cache=cache):          # treść pobierana raz i tylko gdy potrzebna
                if "t" not in cache:
                    cache["t"] = ""
                    typ_, d_ = im.uid("FETCH", str(uid), "(BODY.PEEK[]<0.65536>)")
                    cale = next((x[1] for x in d_ if isinstance(x, tuple)), None)
                    if cale:
                        cache["t"] = tekst_z_maila(email.message_from_bytes(cale, policy=email.policy.default))
                return cache["t"]

            powiadom, powod, typ_maila = klasyfikuj(adres, temat, kategoria.get(uid), mailing, reguly, tresc)
            log(f"{konto}: {'POWIADOM' if powiadom else 'pomijam '} [{powod}] {adres} — {temat[:80]}")
            if not powiadom:
                pominiete.append({"konto": konto, "temat": temat[:150]})
                continue
            tekst = tresc() if (len(wazne) < MAKS_POBRAN or "t" in cache) else ""
            kod = None
            if typ_maila == "paczka":
                kod = kod_odbioru(tekst)
            elif typ_maila in ("2fa", "zwykly"):
                kod = kod_2fa(temat, tekst, pewny=typ_maila == "2fa")
                if kod:
                    typ_maila = "2fa"
            if typ_maila == "zwykly" and (powod == "domyślnie" or powod.startswith("ważne słowo")):
                notuj_nadawce(stan, adres, nadawca(h), mailing)
            wazne.append({"konto": user, "uid": uid, "uv": uidvalidity, "od": nadawca(h), "temat": temat,
                          "zajawka": zajawka(tekst), "typ": typ_maila, "kod": kod})
        s["ostatni_uid"] = maks_uid
        return wazne, pominiete, przypomnij


# ---------------------------------------------------------------- wysyłka
def _teraz_iso():
    return datetime.now(timezone.utc).isoformat()


def embed_pilny(m):
    konto = m["konto"].split("@")[0]
    if m["typ"] == "2fa":
        tytul = f"🔑 {m['kod']} — {m['temat']}" if m.get("kod") else f"🔑 {m['temat']}"
        opis = f"**Od:** {m['od']}\n{m['zajawka']}"
        kolor = 15844367
    else:
        tytul = f"📦 Paczka do odbioru — kod {m['kod']}" if m.get("kod") else f"📦 {m['temat']}"
        opis = f"**Od:** {m['od']}\n**Temat:** {m['temat']}\n{m['zajawka']}"
        kolor = 15105570
    return {"title": tytul[:250], "description": opis[:1000], "color": kolor,
            "footer": {"text": f"JARVIS • {konto}"}, "timestamp": _teraz_iso()}


def embedy(user, nowe, ile):
    konto = user.split("@")[0]
    ts = _teraz_iso()
    if ile > 3:
        linie = [f"• {IKONY.get(m.get('typ'), '')}**{m['od']}** — {m['temat']}"[:180] for m in nowe]
        opis = ""
        for l in linie:
            if len(opis) + len(l) > 3800:
                break
            opis += l + "\n"
        if ile > len(opis.splitlines()):
            opis += f"…i {ile - len(opis.splitlines())} więcej"
        return [{"title": f"📬 {ile} nowych maili", "description": opis, "color": 3447003,
                 "footer": {"text": f"JARVIS • {konto}"}, "timestamp": ts}]
    return [{"title": (IKONY.get(m.get("typ"), "") + m["temat"])[:250],
             "description": f"**Od:** {m['od']}\n{m['zajawka']}"[:1000],
             "color": 15548997 if m.get("typ") == "okazja" else 3447003,
             "footer": {"text": f"JARVIS • {konto}"}, "timestamp": ts} for m in nowe]


def dodaj_przypomnienia(stan, maile):
    if PRZYPOMNIJ_PO_H <= 0:
        return
    p = stan.setdefault("przypomnienia", [])
    teraz = time.time()
    for m in maile:
        if m.get("typ") == "zwykly" and m.get("uid"):
            p.append({"konto": m["konto"], "uid": m["uid"], "uv": m.get("uv"), "od": m["od"][:80],
                      "temat": m["temat"][:150], "ts": teraz})
    del p[:-MAKS_PRZYPOMNIEN]


MAKS_PACZEK = 15


def zapisz_paczki(stan, wazne):
    """Paczki do odbioru (z kodem) dla panelu na malince — zakładka Dzień, brief i komunikat przy siadaniu."""
    p = stan.setdefault("paczki", [])
    for m in wazne:
        if m.get("typ") == "paczka":
            p.append({"id": f"{m['konto']}:{m.get('uv')}:{m.get('uid')}", "ts": time.time(),
                      "od": m["od"][:80], "temat": m["temat"][:150], "kod": m.get("kod")})
    del p[:-MAKS_PACZEK]


def wyslij_wazne(user, wazne, stan):
    pilne = [m for m in wazne if m["typ"] in PILNE]
    reszta = [m for m in wazne if m["typ"] not in PILNE]
    for i in range(0, len(pilne), 5):
        discord([embed_pilny(m) for m in pilne[i:i + 5]])
    if not reszta:
        return
    if w_ciszy():
        z = stan.setdefault("zalegle", [])
        z.extend({k: m[k] for k in ("konto", "uid", "uv", "od", "temat", "typ")} for m in reszta)
        del z[:-MAKS_ZALEGLYCH]
        log(f"{user}: cisza nocna — {len(reszta)} ważnych czeka do rana")
        return
    if discord(embedy(user, reszta, len(reszta))):
        dodaj_przypomnienia(stan, reszta)


def wyslij_zalegle(stan):
    """Pierwszy obieg po ciszy nocnej: jedna wiadomość z ważnymi mailami z nocy."""
    z = stan.get("zalegle") or []
    if not z or w_ciszy():
        return
    opis, n = "", 0
    for m in z:
        linia = f"• {IKONY.get(m.get('typ'), '')}**{m['od']}** — {m['temat']} _({m['konto'].split('@')[0]})_\n"
        if len(opis) + len(linia) > 3800:
            break
        opis += linia
        n += 1
    if n < len(z):
        opis += f"…i {len(z) - n} więcej"
    emb = [{"title": f"🌅 Ważne maile z nocy ({len(z)})", "description": opis, "color": 3447003,
            "footer": {"text": "JARVIS • mail-notifier"}, "timestamp": _teraz_iso()}]
    if discord(emb):
        log(f"Po ciszy nocnej: wysłano {len(z)} ważnych")
        dodaj_przypomnienia(stan, z)
        stan["zalegle"] = []
        zapisz_stan(stan)


def wyslij_przypomnienia(przyp):
    if not przyp:
        return
    opis = ""
    for p in przyp:
        linia = f"• **{p['od']}** — {p['temat']} _({p['konto'].split('@')[0]})_\n"
        if len(opis) + len(linia) > 3800:
            break
        opis += linia
    h = f"{PRZYPOMNIJ_PO_H:g}"
    discord([{"title": f"⏰ Nieprzeczytane od {h} h ({len(przyp)})", "description": opis, "color": 15105570,
              "footer": {"text": "JARVIS • mail-notifier"}, "timestamp": _teraz_iso()}])
    log(f"Przypomnienie: {len(przyp)} nieprzeczytanych ważnych")


def podsumowanie_dnia(stan, reguly):
    """Raz dziennie po DIGEST_GODZINA: tematy pominiętych maili + podpowiedzi nadawców (bez pingowania)."""
    teraz = datetime.now()
    dzis = teraz.strftime("%F")
    if teraz.strftime("%H:%M") < DIGEST_GODZINA or stan.get("podsumowanie_dzien") == dzis:
        return
    lista = sorted(stan.get("pominiete", []), key=lambda p: p["konto"])
    podp = podpowiedzi(stan, reguly)
    if lista or podp:
        opis, n, konto = "", 0, None
        for p in lista:
            linia = (f"**{p['konto']}**\n" if p["konto"] != konto else "") + f"• {p['temat']}\n"
            if len(opis) + len(linia) > 3800:
                break
            opis += linia
            n += 1
            konto = p["konto"]
        if n < len(lista):
            opis += f"…i {len(lista) - n} więcej"
        emb = {"title": f"📭 Pominięte maile ({len(lista)})", "description": opis or "Brak pominiętych.",
               "color": 9807270, "footer": {"text": "JARVIS • mail-notifier"}, "timestamp": _teraz_iso()}
        if podp:
            linie = [f"• {s.get('nazwa') or adr} `{adr}` — {s['n']}× powiadomienie, {s['mailing']}× mailing"
                     for adr, s in podp]
            wartosc = "\n".join(linie) + "\nJeśli to śmieci, dopisz adres do `smieci_nadawcy` w reguly.json."
            emb["fields"] = [{"name": "💡 Wyglądają na mailing — może do śmieci?", "value": wartosc[:1024]}]
        if not WEBHOOK or not http_post_json(WEBHOOK, {"embeds": [emb]}):
            return                      # spróbuje w następnym obiegu
        log(f"Podsumowanie: wysłano {len(lista)} tematów, {len(podp)} podpowiedzi")
        pp = stan.setdefault("podpowiedziane", {})
        for adr, _ in podp:
            pp[adr] = dzis
        granica = (date.today() - timedelta(days=30)).isoformat()
        for a in [a for a, d in pp.items() if d < granica]:
            del pp[a]
    stan["pominiete"] = []
    stan["podsumowanie_dzien"] = dzis
    zapisz_stan(stan)


def main():
    if not KONTA:
        log("Brak kont (GMAIL_1_USER / GMAIL_1_PASS) — koniec")
        sys.exit(1)
    if CISZA and not CISZA_ZAKRES:
        log(f"CISZA={CISZA!r} nie jest w formacie HH:MM-HH:MM — cisza nocna wyłączona")
    cisza = "-".join(CISZA_ZAKRES) if CISZA_ZAKRES else "wyłączona"
    przyp = f"po {PRZYPOMNIJ_PO_H:g} h" if PRZYPOMNIJ_PO_H > 0 else "wyłączone"
    log(f"Start: {len(KONTA)} kont(a), co {INTERWAL}s, podsumowanie pominiętych o {DIGEST_GODZINA}, "
        f"cisza nocna {cisza}, przypomnienia {przyp}")
    for u, _, f in KONTA:
        log(f"  {u}: filtr \"{f}\"")
    stan = wczytaj_stan()
    reguly = wczytaj_reguly() or {}
    log("Reguły: " + ", ".join(f"{k}={len(v) if isinstance(v, list) else v}" for k, v in reguly.items())
        if reguly else f"Reguły: brak {REGULY_PLIK}")
    bledy = {u: 0 for u, _, _ in KONTA}
    ostatni_blad = {u: "" for u, _, _ in KONTA}
    while not koniec:
        r = wczytaj_reguly()
        if r is not None:
            reguly = r
        ok_wszystkie = True
        wyslij_zalegle(stan)
        for user, haslo, filtr in KONTA:
            try:
                wazne, pominiete, przypomnij = sprawdz_konto(user, haslo, filtr, stan, reguly)
                if pominiete:
                    p = stan.setdefault("pominiete", [])
                    p.extend(pominiete)
                    del p[:-MAKS_POMINIETYCH]
                if bledy[user] >= ALERT_PO:
                    discord([{"title": f"✅ mail-notifier: {user} znów działa", "color": 3066993}])
                bledy[user] = 0
                if wazne or pominiete:
                    log(f"{user}: {len(wazne)} ważnych, {len(pominiete)} do podsumowania")
                if wazne:
                    zapisz_paczki(stan, wazne)
                    wyslij_wazne(user, wazne, stan)
                wyslij_przypomnienia(przypomnij)
                zapisz_stan(stan)
            except Exception as e:
                ok_wszystkie = False
                bledy[user] += 1
                ostatni_blad[user] = str(e)
                log(f"{user}: błąd ({bledy[user]}): {e}")
                if bledy[user] == ALERT_PO:
                    discord([{"title": f"⚠️ mail-notifier: {user} nie działa",
                              "description": f"{ALERT_PO} prób z rzędu nieudanych.\n`{str(e)[:300]}`\n"
                                             "Sprawdź hasło aplikacji / dostęp IMAP.", "color": 15158332}])
        zle = [f"{u.split('@')[0]}: {ostatni_blad[u]}" for u in bledy if bledy[u] >= KUMA_PO]
        kuma("down" if zle else "up", "; ".join(zle) if zle else ("ok" if ok_wszystkie else "chwilowy błąd IMAP"))
        podsumowanie_dnia(stan, reguly)
        for _ in range(INTERWAL):
            if koniec:
                break
            time.sleep(1)
    log("Stop")


if __name__ == "__main__":
    main()
