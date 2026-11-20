#!/usr/bin/env python3
"""JARVIS — panel na starym telefonie (malinka).

Strona (static/) + API, z którego ją zasilamy. Sama biblioteka standardowa, jak jarvis_todo.
Kontener chodzi w network_mode: host (WoL musi wyjść broadcastem do LAN-u), więc
todo/trener/Kuma/AdGuard są pod 127.0.0.1. Źródła danych zakładek: zrodla.py.

API (JSON):
  GET  /api/dash                       zakładka Przegląd
  GET  /api/tab/<nazwa>                dzien | pc | muzyka (z Discordem) | claude | media | serwery | siec | trening | swiatlo
                                       + widoki szczegółowe: pogoda (godzinowa i 7 dni) | docker (kontenery)
  GET  /api/screen                     stan ekranu: {ver, mode, until, alert, now} (zapas, gdy nie działa strumień)
  GET  /api/stream                     SSE: zdarzenia "ekran" (zmiana ekranu/alertu), "discord", "ping" co 15 s
  POST /api/docker/<host>/<kontener>/logi      {"tail"?: 10..300} -> {"logi": "..."}   (POST, żeby obowiązywał token)
  POST /api/docker/<host>/<kontener>/restart   host musi być rw w DOCKER_HOSTS
  POST /api/screen                     {"mode": "on"|"sleep"|"auto", "minutes"?: N}   <- JARVIS / bot / n8n
  POST /api/alert                      {"text", "level"?: info|warn|crit, "minutes"?: N}  budzi ekran + baner
  POST /api/alert/clear
  POST /api/heartbeat                  {"battery": {...}, "sleeping": bool}           <- telefon co 60 s
  POST /api/serwer/<wake|sleep|reboot> (stare: /api/action/wake|sleep|sync)
  POST /api/pc/<id>/wol                WoL komputera z PCS
  POST /api/gniazdo/<id>/<on|off|toggle>  para gniazd w przedłużaczu ESPHome (GNIAZDA w .env)
  POST /api/obecnosc                   {"twarz": bool}  <- telefon: ktoś przy biurku (twarz/dłoń w kamerze) -> monitor
                                       pierwsze siadanie danego dnia -> {"brief": {"odp", "mow"}} (strona czyta na głos)
  POST /api/pc/<id>/<polecenie>        przekazane do agenta C# (audio/…, media/…, zasilanie/…, discord/…, speedtest)
  GET  /api/pc/<id>/okladka/<oid>      okładka z agenta
  POST /api/discord                    {"kanaly": [...]}  <- cog panel.py w bocie (tylko z 127.0.0.1)
  POST /api/media/qbit/<hash>/<start|stop>
  GET  /api/siec/speedtest        ostatni wynik (ts, ts_ms, ping, dol, gora) - dla kafelka w Homepage
POST /api/siec/speedtest
  POST /api/paczka/<id>/odebrana       chowa paczkę z listy (zakładka Dzień, brief)
  POST /api/budzik                     {"godzina": "6:30", "dni"?: [0..6] | "pn-pt"|"weekend"|"codziennie"|"jednorazowy"}
  POST /api/budzik/<stop|drzemka>      wyłącza dzwoniący budzik / drzemka BUDZIK_DRZEMKA_MIN
  POST /api/budzik/<id>/<wl|wyl|usun>  stały budzik: włącz / wyłącz, każdy: usuń  (lista: GET /api/tab/budziki)
  POST /api/claude-limity/odswiez      limity Claude teraz (najwyżej raz na minutę; samo co CLAUDE_CO_S)
  POST /api/siec/urzadzenie/<MAC>      {"znane"?: bool, "nazwa"?: str}  zatwierdzenie / nazwa urządzenia w sieci
  POST /api/claude                     {"zdarzenie": UserPromptSubmit|Stop|Notification, "typ", "sesja", "projekt"}
                                       <- hook Claude Code z laptopa: „skończył” (>= CLAUDE_MIN_S) / „czeka na zgodę”
  POST /api/dobranoc/anuluj             przerywa odliczanie „Dobranoc” (dotknięcie ekranu)
  SSE "przypomnienie" {"mow", "tekst"}    minutnik / przypomnienie głosowe (do tego alert budzi ekran)
  POST /api/swiatlo                    {"on"?, "bri"?, "kolor"?: [r,g,b], "ps"?}  -> WLED
  POST /api/todo, PATCH /api/todo/<id> -> jarvis_todo
  GET  /api/health

Zapisy wymagają Content-Type: application/json (ochrona przed CSRF), a jeśli ustawisz
PANEL_TOKEN, także nagłówka X-Panel-Token.
"""
import base64
import collections
import hmac
import json
import os
import queue
import re
import socket
import subprocess
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import zrodla as Z

E = os.environ.get
PORT = int(E("PORT", "8084"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def _wersja_ui():
    """Skrót plików strony - telefon porównuje go w /api/dash i po wdrożeniu nowej wersji sam przeładowuje stronę."""
    import hashlib
    h = hashlib.sha1()
    for nazwa in sorted(os.listdir(STATIC)):
        p = os.path.join(STATIC, nazwa)
        if os.path.isfile(p):
            with open(p, "rb") as f:
                h.update(nazwa.encode() + f.read())
    return h.hexdigest()[:12]


WERSJA_UI = _wersja_ui()
DATA_DIR = E("DATA_DIR", "/data")

TODO_URL = E("TODO_URL", "http://127.0.0.1:8083").rstrip("/")
TRENER_URL = E("TRENER_URL", "http://127.0.0.1:8082").rstrip("/")
KUMA_URL = E("KUMA_URL", "http://127.0.0.1:3001").rstrip("/")
KUMA_API_KEY = E("KUMA_API_KEY", "")
KUMA_STATUS_SLUG = E("KUMA_STATUS_SLUG", "")
KUMA_PUSH_PANEL = E("KUMA_PUSH_PANEL", "")  # opcjonalny push-monitor "panel żyje"

SERVER_IP = E("SERVER_IP", "")
SERVER_MAC = E("SERVER_MAC", "")
WOL_BROADCAST = E("WOL_BROADCAST", "255.255.255.255")
N8N_PORT = int(E("N8N_PORT", "5678"))
SSH_USER = E("SERVER_SSH_USER", "jpower")
SSH_KEY = E("SSH_KEY", "/ssh/id_rsa")
KNOWN_HOSTS = os.path.join(DATA_DIR, "known_hosts")

LAT = E("LAT", "49.8378")   # Sułkowice
LON = E("LON", "19.7956")
WAKE_MIN = float(E("WAKE_MIN", "2"))        # na ile minut budzi dotyk
ALERT_MIN = float(E("ALERT_MIN", "30"))     # domyślnie tyle świeci ekran z alertem
PANEL_TOKEN = E("PANEL_TOKEN", "")

HTTP_TIMEOUT = 6


# --------------------------------------------------------------------------- pomocnicze
def http_json(url, method="GET", body=None, headers=None, timeout=HTTP_TIMEOUT):
    data = None if body is None else json.dumps(body).encode("utf-8")
    h = {"Accept": "application/json", **(headers or {})}
    if data is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return r.status, (json.loads(raw) if raw else None)


def tcp_open(host, port, timeout=1.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def teraz():
    return time.time()


class Cache:
    """Wynik funkcji trzymany przez ttl sekund. Przy błędzie oddaje ostatni dobry wynik
    (z "stale": true), żeby jedna niedostępna usługa nie czyściła kafelka na panelu."""

    def __init__(self):
        self.d = {}
        self.lock = threading.Lock()

    def get(self, key, ttl, fn):
        with self.lock:
            hit = self.d.get(key)
        if hit and teraz() - hit[0] < ttl:
            return hit[1]
        try:
            val = {"ok": True, "data": fn()}
        except Exception as e:  # noqa: BLE001
            val = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
            if hit and hit[1].get("ok"):
                val = {**hit[1], "stale": True, "error": val["error"]}
        with self.lock:
            # przy błędzie spróbuj ponownie szybciej niż pełne ttl
            self.d[key] = (teraz() if val.get("ok") and not val.get("stale") else teraz() - ttl + min(ttl, 15), val)
        return val

    def drop(self, *keys):
        with self.lock:
            for k in keys:
                self.d.pop(k, None)


cache = Cache()


# --------------------------------------------------------------------------- źródła: Przegląd
def pogoda():
    q = urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON, "timezone": "Europe/Warsaw", "forecast_days": 5,
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,is_day",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    })
    _, d = http_json(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=10)
    c, dl = d.get("current") or {}, d.get("daily") or {}
    dni = []
    for i, data in enumerate(dl.get("time") or []):
        def v(k):
            arr = dl.get(k) or []
            return arr[i] if i < len(arr) else None
        dni.append({"date": data, "code": v("weather_code"), "max": v("temperature_2m_max"),
                    "min": v("temperature_2m_min"), "pp": v("precipitation_probability_max"),
                    "sunrise": (v("sunrise") or "")[11:16], "sunset": (v("sunset") or "")[11:16]})
    return {"temp": c.get("temperature_2m"), "feels": c.get("apparent_temperature"),
            "code": c.get("weather_code"), "wind": c.get("wind_speed_10m"),
            "precip": c.get("precipitation"), "is_day": c.get("is_day"), "days": dni}


def pogoda_szczegoly():
    """Widok po dotknięciu kafla pogody: bieżące, najbliższe 24 godziny i 7 dni. Czasy lokalne (Europe/Warsaw)."""
    q = urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON, "timezone": "Europe/Warsaw", "forecast_days": 7,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,surface_pressure,weather_code,"
                   "wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,is_day",
        "hourly": "temperature_2m,weather_code,precipitation_probability,precipitation,wind_speed_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,"
                 "wind_speed_10m_max,uv_index_max,sunrise,sunset",
    })
    _, d = http_json(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=10)
    c, h, dl = d.get("current") or {}, d.get("hourly") or {}, d.get("daily") or {}

    def kol(zrodlo, k, i):
        arr = zrodlo.get(k) or []
        return arr[i] if i < len(arr) else None

    # pierwsza godzina >= bieżącej (obie wartości są lokalne, więc porównanie tekstów wystarcza)
    teraz_h = (c.get("time") or "")[:13]
    czasy = h.get("time") or []
    start = next((i for i, t in enumerate(czasy) if t[:13] >= teraz_h), 0)
    godziny = [{"t": czasy[i][11:16], "data": czasy[i][:10], "code": kol(h, "weather_code", i),
                "temp": kol(h, "temperature_2m", i), "pp": kol(h, "precipitation_probability", i),
                "opad": kol(h, "precipitation", i), "wiatr": kol(h, "wind_speed_10m", i)}
               for i in range(start, min(start + 24, len(czasy)))]
    dni = [{"date": data, "code": kol(dl, "weather_code", i), "max": kol(dl, "temperature_2m_max", i),
            "min": kol(dl, "temperature_2m_min", i), "pp": kol(dl, "precipitation_probability_max", i),
            "opad": kol(dl, "precipitation_sum", i), "wiatr": kol(dl, "wind_speed_10m_max", i),
            "uv": kol(dl, "uv_index_max", i), "sunrise": (kol(dl, "sunrise", i) or "")[11:16],
            "sunset": (kol(dl, "sunset", i) or "")[11:16]}
           for i, data in enumerate(dl.get("time") or [])]
    return {"temp": c.get("temperature_2m"), "feels": c.get("apparent_temperature"), "wilg": c.get("relative_humidity_2m"),
            "cisnienie": c.get("surface_pressure"), "code": c.get("weather_code"), "wiatr": c.get("wind_speed_10m"),
            "porywy": c.get("wind_gusts_10m"), "kierunek": c.get("wind_direction_10m"), "opad": c.get("precipitation"),
            "is_day": c.get("is_day"), "godziny": godziny, "dni": dni}


ETYKIETA_RE = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')
METRYKA_RE = re.compile(r"^monitor_status\{(.*)\}\s+(\S+)$")
KUMA_STAN = {1: "up", 0: "down", 2: "pending", 3: "maintenance"}


def kuma():
    """Wszystkie monitory: z /metrics (klucz API) albo ze strony statusu (KUMA_STATUS_SLUG, bez klucza)."""
    monitory = []
    if KUMA_API_KEY:
        auth = base64.b64encode(f":{KUMA_API_KEY}".encode()).decode()
        req = urllib.request.Request(f"{KUMA_URL}/metrics", headers={"Authorization": f"Basic {auth}"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            tekst = r.read().decode("utf-8", "replace")
        for linia in tekst.splitlines():
            m = METRYKA_RE.match(linia.strip())
            if not m:
                continue
            et = dict(ETYKIETA_RE.findall(m.group(1)))
            try:
                st = int(float(m.group(2)))
            except ValueError:
                continue
            monitory.append({"nazwa": et.get("monitor_name", "?").replace('\\"', '"'), "typ": et.get("monitor_type"),
                             "stan": KUMA_STAN.get(st, "pending"),
                             "adres": f"{et.get('monitor_url', '')} {et.get('monitor_hostname', '')}"})
    elif KUMA_STATUS_SLUG:
        _, strona = http_json(f"{KUMA_URL}/api/status-page/{KUMA_STATUS_SLUG}")
        _, bicie = http_json(f"{KUMA_URL}/api/status-page/heartbeat/{KUMA_STATUS_SLUG}")
        hb = (bicie or {}).get("heartbeatList") or {}
        for g in (strona or {}).get("publicGroupList") or []:
            for mon in g.get("monitorList") or []:
                lista = hb.get(str(mon.get("id"))) or []
                st = lista[-1].get("status") if lista else 2
                monitory.append({"nazwa": mon.get("name"), "typ": mon.get("type"), "grupa": g.get("name"),
                                 "stan": KUMA_STAN.get(st, "pending")})
    else:
        return {"disabled": True}
    po = lambda s: sorted(m["nazwa"] for m in monitory if m["stan"] == s)  # noqa: E731
    return {"total": len(monitory), "up": len(po("up")), "down": po("down"), "pending": po("pending"),
            "maintenance": len(po("maintenance")), "monitory": sorted(monitory, key=lambda m: (m["stan"] == "up", m["nazwa"]))}


_serwer_stan = {"up": None, "since": None}
_budzenie = {"ts": 0.0}


def serwer():
    if not SERVER_IP:
        return {"disabled": True}
    up = tcp_open(SERVER_IP, 22)
    n8n = None
    if up:
        try:
            st, _ = http_json(f"http://{SERVER_IP}:{N8N_PORT}/healthz", timeout=3)
            n8n = st == 200
        except Exception:  # noqa: BLE001
            n8n = False
    if up != _serwer_stan["up"]:
        _serwer_stan.update(up=up, since=teraz())
    if up:
        _budzenie["ts"] = 0.0
    waking = bool(_budzenie["ts"]) and teraz() - _budzenie["ts"] < 300
    return {"up": up, "n8n": n8n, "since": _serwer_stan["since"],
            "waking_since": _budzenie["ts"] if waking else None}


def serwer_up():
    s = cache.get("serwer", 10, serwer)
    return bool(s.get("ok") and s["data"].get("up"))


def malinka():
    out = {}
    try:
        with open("/proc/loadavg") as f:
            out["load"] = float(f.read().split()[0])
    except OSError:
        pass
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            out["temp"] = round(int(f.read().strip()) / 1000, 1)
    except (OSError, ValueError):
        pass
    try:
        mem = {}
        with open("/proc/meminfo") as f:
            for linia in f:
                k, v = linia.split(":", 1)
                mem[k] = int(v.split()[0])
        out["mem_used_pct"] = round(100 * (1 - mem["MemAvailable"] / mem["MemTotal"]))
        out["mem_total_gb"] = round(mem["MemTotal"] / 1024 / 1024, 1)
    except (OSError, KeyError, ValueError, ZeroDivisionError):
        pass
    try:
        with open("/proc/uptime") as f:
            out["uptime_s"] = int(float(f.read().split()[0]))
    except (OSError, ValueError):
        pass
    try:  # / kontenera = overlay na dysku malinki (SSD), więc to zajętość jej dysku
        sv = os.statvfs("/")
        out["dysk_pct"] = round(100 * (1 - sv.f_bavail / sv.f_blocks)) if sv.f_blocks else None
    except OSError:
        pass
    return out


def todo():
    _, d = http_json(f"{TODO_URL}/api/todos?open=1")
    return {"tasks": (d or {}).get("tasks", [])}


def trening_brief():
    _, d = http_json(f"{TRENER_URL}/api/brief", timeout=10)
    return {"lines": (d or {}).get("lines", [])}


# --------------------------------------------------------------------------- Docker (malinka + serwer)
def _host_na_serwerze(h):
    return bool(SERVER_IP) and urllib.parse.urlsplit(h["url"]).hostname == SERVER_IP


def docker_wszystko():
    """Kontenery ze wszystkich hostów z DOCKER_HOSTS. Host na serwerze pomijamy, gdy serwer śpi (nie budzimy go)."""
    hosty = Z.docker_hosty()
    if not hosty:
        return {"disabled": True}

    def jeden(h):
        w = {"id": h["id"], "nazwa": h["nazwa"], "rw": h["rw"], "kontenery": []}
        if _host_na_serwerze(h) and not serwer_up():
            return {**w, "spi": True}
        try:
            return {**w, "kontenery": Z.docker_lista(h)}
        except Exception as e:  # noqa: BLE001
            return {**w, "error": f"{type(e).__name__}: {e}"[:200]}
    return {"hosty": list(Z.pula.map(jeden, hosty))}


def docker_akcja(hid, nazwa, akcja, body):
    h = Z.docker_host(hid)
    if _host_na_serwerze(h) and not serwer_up():
        raise RuntimeError("serwer śpi")
    if akcja == "logi":
        return {"ok": True, "logi": Z.docker_logi(h, nazwa, body.get("tail", 80))}
    Z.docker_restart(h, nazwa)
    cache.drop("docker")
    return {"ok": True, "msg": f"Restart: {nazwa} ({h['nazwa']})"}


# --------------------------------------------------------------------------- ekran / alerty / telefon
stan_lock = threading.Lock()
EKRAN = {"ver": 1, "mode": "auto", "until": 0, "alert": None}
PANEL = {"ts": None, "battery": None, "sleeping": None}
_ostatni_push = {"ts": 0.0}


class Szyna:
    """Zdarzenia dla telefonu (SSE). Każdy klient ma własną kolejkę; zapchany klient po prostu traci zdarzenia
    (telefon i tak ma zapasowe odpytywanie), więc jedna zawieszona sesja nie blokuje reszty."""

    def __init__(self):
        self.klienci = set()
        self.lock = threading.Lock()

    def dolacz(self):
        q = queue.Queue(maxsize=50)
        with self.lock:
            self.klienci.add(q)
        return q

    def odlacz(self, q):
        with self.lock:
            self.klienci.discard(q)

    def publikuj(self, typ, dane=None):
        with self.lock:
            klienci = list(self.klienci)
        for q in klienci:
            try:
                q.put_nowait((typ, dane))
            except queue.Full:
                pass


szyna = Szyna()


def wake_min():
    """Po ilu minutach bez dotyku ekran gaśnie: ustawione z Discorda (/ekran auto minuty:N, trzymane w pamiec.json),
    a gdy nie ustawiono — WAKE_MIN z .env."""
    try:
        v = float(Z.pamiec_get("wake_min", WAKE_MIN))
        return v if 0 < v <= 240 else WAKE_MIN
    except (TypeError, ValueError):
        return WAKE_MIN


def stan_ekranu():
    with stan_lock:
        s = dict(EKRAN)
    return {**s, "now": teraz(), "wake_min": wake_min(), "budzik": {**BUDZIK, "drzemka_min": BUDZIK_DRZEMKA_MIN}}


def ustaw_ekran(mode, minutes=None):
    if mode not in ("on", "sleep", "auto"):
        raise ValueError("mode: on | sleep | auto")
    if mode == "auto" and minutes not in (None, ""):
        m = float(minutes)
        if not 0.5 <= m <= 240:
            raise ValueError("minutes przy auto: 0.5..240 (po ilu minutach bez dotyku ekran gaśnie)")
        Z.pamiec_set("wake_min", m)
    until = 0
    if mode == "on":
        m = float(minutes) if minutes not in (None, "") else 0
        if m < 0 or m > 24 * 60:
            raise ValueError("minutes: 0..1440 (0 = do odwołania)")
        until = teraz() + m * 60 if m else 0
    with stan_lock:
        EKRAN.update(ver=EKRAN["ver"] + 1, mode=mode, until=until)
        wynik = dict(EKRAN)
    szyna.publikuj("ekran", stan_ekranu())
    return wynik


def ustaw_alert(text, level="info", minutes=None):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text: puste")
    if level not in ("info", "warn", "crit"):
        raise ValueError("level: info | warn | crit")
    m = float(minutes) if minutes not in (None, "") else ALERT_MIN
    with stan_lock:
        EKRAN["alert"] = {"text": " ".join(text.split())[:300], "level": level, "ts": teraz()}
    return ustaw_ekran("on", m)


def wyczysc_alert():
    # zamknięty alert = koniec wymuszonego świecenia; ekran wraca do zwykłego trybu (gaśnie po WAKE_MIN)
    with stan_lock:
        EKRAN.update(ver=EKRAN["ver"] + 1, alert=None, mode="auto", until=0)
        wynik = dict(EKRAN)
    szyna.publikuj("ekran", stan_ekranu())
    return wynik


def heartbeat(b):
    with stan_lock:
        PANEL.update(ts=teraz(), battery=b.get("battery"), sleeping=b.get("sleeping"))
    obecnosc((b.get("battery") or {}).get("twarz"))   # co 60 s potwierdzenie stanu z kamery
    if KUMA_PUSH_PANEL and teraz() - _ostatni_push["ts"] > 55:
        _ostatni_push["ts"] = teraz()

        def push():
            try:
                urllib.request.urlopen(KUMA_PUSH_PANEL, timeout=HTTP_TIMEOUT).read()
            except Exception:  # noqa: BLE001
                pass
        threading.Thread(target=push, daemon=True).start()


# --------------------------------------------------------------------------- obecność przy biurku -> monitor
# Telefon (kamera panelu) zgłasza, czy przy biurku jest twarz albo dłoń. Pojawienie się = włącz gniazdo monitora.
# Wyłączanie: domyślnie TYLKO ręcznie („wyłącz stanowisko”, przycisk). Opcjonalnie OBECNOSC_WYLACZ_MIN > 0 = wyłącz po
# tylu minutach braku obecności, i to tylko gdy telefon świeżo (< 3 min) potwierdza brak (padnięty telefon nic nie gasi).
OBECNOSC_GNIAZDO = E("OBECNOSC_GNIAZDO", "monitor")      # id z GNIAZDA; puste = automat wyłączony
OBECNOSC_WYLACZ_MIN = float(E("OBECNOSC_WYLACZ_MIN", "0"))   # 0 = nigdy samo (decyzja 2026-11-11)
# „włącz / wyłącz stanowisko” (głos): te gniazda z GNIAZDA, po przecinku; później dojdzie LED
STANOWISKO = [g.strip() for g in E("STANOWISKO", "monitor").split(",") if g.strip()]
# brief dnia: przy PIERWSZYM wykryciu obecności danego dnia (w godzinach BRIEF_OD..BRIEF_DO) JARVIS mówi pogodę,
# kalendarz, ważne maile, trening i niedziałające usługi. Ręcznie: „dzień dobry”, „co dziś”, „brief”.
BRIEF_AUTO = E("BRIEF_AUTO", "1").strip().lower() not in ("0", "false", "nie", "")
BRIEF_OD = int(E("BRIEF_OD", "0"))     # godzina od (włącznie)
BRIEF_DO = int(E("BRIEF_DO", "24"))    # godzina do (bez) — 0..24 = cały dzień (decyzja 2026-11-14)
BRIEF_ZNAKI = 900                      # tyle najwyżej czyta na głos (zwykłe odpowiedzi: 500)
OBECNOSC = {"jest": None, "od": 0, "ts": 0, "wylaczone_po": 0}


def _obecnosc_gniazdo(akcja, powod):
    try:
        w = Z.gniazdo_ustaw(OBECNOSC_GNIAZDO, akcja)
        cache.drop("dash-gniazda")
        print(f"obecnosc: {powod} -> {w['msg']}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"obecnosc: {powod} -> {akcja} NIEUDANE: {e}", flush=True)


def _obecnosc_pauza():
    """Po „Dobranoc” do DOBRANOC_DO_H rano kamera nie włącza monitora ani nie odpala briefu."""
    try:
        return teraz() < float(Z.pamiec_get("obecnosc_pauza_do", 0) or 0)
    except (TypeError, ValueError):
        return False


def obecnosc(jest):
    if not isinstance(jest, bool):
        return
    t = teraz()
    with stan_lock:
        zmiana = jest != OBECNOSC["jest"]
        if zmiana:
            OBECNOSC.update(jest=jest, od=t)
        OBECNOSC["ts"] = t
    if zmiana:
        print(f"obecnosc: {'ktoś przy biurku' if jest else 'nikogo przy biurku'}", flush=True)
        if jest and OBECNOSC_GNIAZDO and not _obecnosc_pauza():
            threading.Thread(target=_obecnosc_gniazdo, args=("on", "obecność"), daemon=True).start()


def straznik_obecnosci():
    while True:
        time.sleep(30)
        if not OBECNOSC_GNIAZDO or OBECNOSC_WYLACZ_MIN <= 0:
            continue
        t = teraz()
        with stan_lock:
            o = dict(OBECNOSC)
            wylacz = (o["jest"] is False and t - o["ts"] < 180 and t - o["od"] >= OBECNOSC_WYLACZ_MIN * 60
                      and o["wylaczone_po"] != o["od"])
            if wylacz:
                OBECNOSC["wylaczone_po"] = o["od"]   # raz na jedną nieobecność
        if wylacz:
            _obecnosc_gniazdo("off", f"brak obecności od {int((t - o['od']) // 60)} min")


# --------------------------------------------------------------------------- brief dnia
DNI_TYG = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"]
MIESIACE = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września",
            "października", "listopada", "grudnia"]
_brief_lock = threading.Lock()


def _teraz_pl():
    return Z.datetime.now(Z.TZ)


def _bez_emoji(s):
    """Do czytania na głos: bez **pogrubień** i emoji (zostają litery, cyfry i zwykła interpunkcja)."""
    s = re.sub(r"\*\*", "", str(s or ""))
    s = re.sub(r"[^\w\s.,:;()/%„”\"'+\-–—…!?]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _brief_kalendarz(dzien=0):
    k = _z_pamieci("kalendarz", Z.kalendarz_pobierz)
    d = (k.get("data") or {}) if k.get("ok") else {}
    n = _teraz_pl()
    data = n.date() + Z.timedelta(days=dzien)
    godz, cale = [], []
    for w in d.get("wydarzenia") or []:
        start = Z.datetime.fromisoformat(w["start"]).astimezone(Z.TZ)
        if start.date() != data:
            continue
        if w.get("caly_dzien"):
            cale.append(w.get("tytul") or "wydarzenie")
            continue
        koniec = Z.datetime.fromisoformat(w["koniec"]).astimezone(Z.TZ) if w.get("koniec") else start
        if koniec < n:
            continue   # już się skończyło
        godz.append(f"o {start.hour}:{start.minute:02d} {w.get('tytul') or 'wydarzenie'}")
    czesci = []
    if godz:
        czesci.append(", ".join(godz[:4]) + (f" i jeszcze {len(godz) - 4}" if len(godz) > 4 else ""))
    if cale:
        czesci.append("cały dzień: " + ", ".join(cale[:2]))
    return f"W kalendarzu: {'; '.join(czesci)}." if czesci else None


def _brief_poczta():
    p = _poczta()
    d = (p.get("data") or {}) if p.get("ok") else {}
    wazne = d.get("wazne") or []
    if not wazne:
        return None
    od = list(dict.fromkeys(re.sub(r"\s*<[^>]*>", "", str(m.get("od") or "")).strip().strip('"') or "?" for m in wazne))[:2]
    n = len(wazne)
    if n == 1:
        return f"Czeka jeden ważny nieprzeczytany mail, od {od[0]}."
    slowo = "ważne nieprzeczytane maile" if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else "ważnych nieprzeczytanych maili"
    return f"Czeka {n} {slowo}, między innymi od {', '.join(od)}."


def _brief_trening():
    t = cache.get("trening-brief", 600, trening_brief)
    lines = ((t.get("data") or {}).get("lines") or []) if t.get("ok") else []
    if not lines:
        return None
    linia = _bez_emoji(lines[0])
    if not linia or "nic zaplanowanego" in linia:
        return None
    return f"Trening: {linia}" + ("" if linia.endswith((".", "!", "?")) else ".")


def _brief_uslugi():
    """Niedziałające monitory Kumy, bez grup. Gdy serwer śpi (normalny stan, budzony WoL), jego usługi pomijamy."""
    k = cache.get("kuma", 30, kuma)
    d = (k.get("data") or {}) if k.get("ok") else {}
    spi = bool(SERVER_IP) and not serwer_up()
    down = [m["nazwa"] for m in d.get("monitory") or []
            if m.get("stan") == "down" and m.get("typ") != "group" and not (spi and SERVER_IP in (m.get("adres") or ""))]
    if not down:
        return None
    return "Nie działa: " + ", ".join(down[:4]) + (f" i jeszcze {len(down) - 4}" if len(down) > 4 else "") + "."


def brief_tekst():
    """Każda część osobno: błąd albo brak danych w jednej nie psuje reszty, pusta część jest pomijana."""
    n = _teraz_pl()
    out = [f"{'Dzień dobry' if 5 <= n.hour < 18 else 'Dobry wieczór'}. Jest {n.hour}:{n.minute:02d}, "
           f"{DNI_TYG[n.weekday()]} {n.day} {MIESIACE[n.month - 1]}."]
    for fn in (_pogoda_zdanie, _brief_kalendarz, _brief_przypomnienia, _brief_poczta, _brief_paczki, _brief_media,
               _brief_trening, _brief_uslugi, _brief_siec, _brief_claude):
        try:
            z = fn()
            if z:
                out.append(z)
        except Exception as e:  # noqa: BLE001
            print(f"brief: {fn.__name__}: {e}", flush=True)
    return " ".join(out)


def _brief_oznacz_dzis():
    """True = dziś jeszcze nie było briefu (i od teraz jest oznaczony). Zapis w pamięci przetrwa restart kontenera."""
    dzis = _teraz_pl().date().isoformat()
    with _brief_lock:
        if Z.pamiec_get("brief_dzien") == dzis:
            return False
        Z.pamiec_set("brief_dzien", dzis)
        return True


def brief_auto():
    """Wołane, gdy telefon zgłasza obecność: brief tylko raz dziennie i tylko w oknie BRIEF_OD..BRIEF_DO."""
    if not BRIEF_AUTO or _obecnosc_pauza() or not BRIEF_OD <= _teraz_pl().hour < BRIEF_DO or not _brief_oznacz_dzis():
        return None
    t = brief_tekst()
    print(f"brief: pierwsze siadanie dziś ({len(t)} znaków)", flush=True)
    return {"odp": t, "mow": _do_mowy(t, BRIEF_ZNAKI)}


# --------------------------------------------------------------------------- minutniki i przypomnienia głosowe
# „ustaw minutnik na 10 minut”, „przypomnij mi o 18 o praniu”, „przypomnij mi za 20 minut wyjąć pranie”,
# „jakie mam przypomnienia”, „anuluj minutnik / przypomnienie / wszystkie przypomnienia”.
# Lista w pamiec.json (przetrwa restart kontenera). O czasie: alert (budzi ekran, baner zostaje) + zdarzenie SSE
# "przypomnienie" -> telefon pika i czyta tekst na głos.
_przyp_lock = threading.Lock()
LICZBY_SLOWA = {"jeden": 1, "jedna": 1, "dwa": 2, "dwie": 2, "trzy": 3, "cztery": 4, "piec": 5, "szesc": 6,
                "siedem": 7, "osiem": 8, "dziewiec": 9, "dziesiec": 10, "pietnascie": 15, "dwadziescia": 20,
                "trzydziesci": 30, "czterdziesci": 40, "piecdziesiat": 50}


def _odmiana(n, jeden, kilka, wiele):
    n = abs(int(n))
    if n == 1:
        return jeden
    return kilka if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else wiele


def _cyfry(t):
    """Liczebniki słowami -> cyframi, z dopełnieniem spacjami do tej samej długości (indeksy pasują do oryginału)."""
    return re.sub(r"\b(" + "|".join(LICZBY_SLOWA) + r")\b",
                  lambda m: str(LICZBY_SLOWA[m.group(1)]).ljust(len(m.group(1))), t)


def _trwanie(t):
    """Czas trwania z tekstu bez ogonków: '10 minut', '1 godzine 30 minut', 'pol godziny', 'kwadrans'... -> sekundy."""
    t = _cyfry(t)
    suma, spany = 0.0, []
    for m in re.finditer(r"(\d+(?:[.,]\d+)?)\s*(godzin\w*|godz\w*|minut\w*|min\b|sekund\w*|sek\b)", t):
        v = float(m.group(1).replace(",", "."))
        u = m.group(2)
        suma += v * (3600 if u.startswith("godz") else 60 if u.startswith("min") else 1)
        spany.append(m.span())
    for wzor, sek in ((r"\bpoltorej godziny\b", 5400), (r"\bpol godziny\b", 1800), (r"\bkwadrans\w*", 900),
                      (r"\bgodzine\b", 3600), (r"\bminute\b", 60)):
        for m in re.finditer(wzor, t):
            if not any(a < m.end() and m.start() < b for a, b in spany):
                suma += sek
                spany.append(m.span())
    return suma, spany


def _czas_opis(sek):
    sek = int(round(sek))
    h, m, s = sek // 3600, sek % 3600 // 60, sek % 60
    czesci = []
    if h:
        czesci.append(f"{h} {_odmiana(h, 'godzinę', 'godziny', 'godzin')}")
    if m:
        czesci.append(f"{m} {_odmiana(m, 'minutę', 'minuty', 'minut')}")
    if s and not h:
        czesci.append(f"{s} {_odmiana(s, 'sekundę', 'sekundy', 'sekund')}")
    return " i ".join(czesci) or "chwilę"


def _kiedy_opis(ts):
    n = _teraz_pl()
    d = Z.datetime.fromtimestamp(ts, Z.TZ)
    godz = f"{d.hour}:{d.minute:02d}"
    dni = (d.date() - n.date()).days
    return f"o {godz}" if dni == 0 else f"jutro o {godz}" if dni == 1 else f"{d.day} {MIESIACE[d.month - 1]} o {godz}"


def _przyp_lista():
    return sorted(Z.pamiec_get("przypomnienia", []) or [], key=lambda p: p["ts"])


def _przyp_dodaj(p):
    with _przyp_lock:
        lista = _przyp_lista()
        lista.append(p)
        Z.pamiec_set("przypomnienia", lista)


def _przyp_mowa(tekst):
    tl = _bez_ogonkow(tekst)
    if not tekst:
        return "Przypominam."
    if re.match(r"(ze|zeby|aby|by)\b", tl):
        return f"Przypominam, {tekst}."
    if re.match(r"o\b", tl):
        return f"Przypominam {tekst}."
    return f"Przypominam: {tekst}."


def _przypomnij(src, t, od):
    """src/t od indeksu `od` (po „przypomnij mi”): czas (o HH[:MM] / za X / jutro) + tekst przypomnienia."""
    reszta_t = t[od:]
    spany = []
    dni = 0
    if m := re.search(r"\b(jutro|pojutrze)\b", reszta_t):
        dni = 1 if m.group(1) == "jutro" else 2
        spany.append(m.span())
    cel = None
    if m := re.search(r"\b(?:o|na)\s+(?:godzin\w*\s+)?(\d{1,2})(?:[:.\s](\d{2}))?\b", reszta_t):
        h, mi = int(m.group(1)), int(m.group(2) or 0)
        if h <= 23 and mi <= 59:
            n = _teraz_pl()
            c = n.replace(hour=h, minute=mi, second=0, microsecond=0) + Z.timedelta(days=dni)
            if dni == 0 and c <= n:
                c += Z.timedelta(hours=12) if h < 12 and c + Z.timedelta(hours=12) > n else Z.timedelta(days=1)
            cel = c.timestamp()
            spany.append(m.span())
    if cel is None and (m := re.search(r"\bza\s+", reszta_t)):
        ogon = reszta_t[m.end():]
        koniec = re.search(r"\s(?:ze|zeby|aby|by|o(?!\s*\d))\s|,", ogon)
        kawalek = ogon[:koniec.start()] if koniec else ogon
        sek, sp = _trwanie(kawalek)
        if sek > 0:
            cel = teraz() + sek
            spany.append((m.start(), m.end() + max(b for _, b in sp)))   # tylko „za X”, reszta to tekst
    if cel is None:
        return {"odp": "Kiedy przypomnieć? Powiedz na przykład: przypomnij mi o 18 o praniu, albo za 20 minut wyjąć pranie."}
    reszta = src[od:]
    for a, b in sorted(spany, reverse=True):
        reszta = reszta[:a] + " " + reszta[b:]
    tekst = re.sub(r"\s+", " ", reszta).strip(" ,.:")
    tekst = re.sub(r"^(?:mi|mnie)\s+", "", tekst, flags=re.I)
    _przyp_dodaj({"id": os.urandom(6).hex(), "ts": cel, "typ": "przypomnienie", "tekst": tekst or "przypomnienie",
                  "mow": _przyp_mowa(tekst)})
    print(f"przypomnienie: {_kiedy_opis(cel)} - {tekst}", flush=True)
    return {"odp": f"Dobrze, przypomnę {_kiedy_opis(cel)}" + (f": {tekst}." if tekst else ".")}


def _minutnik(t):
    sek, _ = _trwanie(t)
    if not 1 <= sek <= 24 * 3600:
        return {"odp": "Na ile ustawić minutnik? Powiedz na przykład: minutnik na 10 minut."}
    opis = _czas_opis(sek)
    cel = teraz() + sek
    _przyp_dodaj({"id": os.urandom(6).hex(), "ts": cel, "typ": "minutnik", "tekst": f"Minutnik na {opis}",
                  "mow": f"Minutnik na {opis} — koniec."})
    print(f"minutnik: {opis}", flush=True)
    return {"odp": f"Minutnik na {opis}, do {_kiedy_opis(cel)[2:]}."}


def _przyp_status():
    lista = _przyp_lista()
    if not lista:
        return "Nie masz żadnych minutników ani przypomnień."
    t = teraz()
    out = []
    for p in lista[:5]:
        if p["typ"] == "minutnik":
            out.append(f"{p['tekst']}: zostało {_czas_opis(max(0, p['ts'] - t))}")
        else:
            out.append(f"{_kiedy_opis(p['ts'])}: {p['tekst']}")
    return ". ".join(out) + (f". I jeszcze {len(lista) - 5}." if len(lista) > 5 else ".")


def _przyp_anuluj(t):
    minutniki = bool(re.search(r"minutnik|timer", t))
    wszystkie = bool(re.search(r"\bwszystk", t))
    with _przyp_lock:
        lista = _przyp_lista()
        typ = "minutnik" if minutniki else "przypomnienie"
        pasujace = [p for p in lista if p["typ"] == typ]
        if not pasujace:
            return "Nie ma czego anulować."
        usun = pasujace if wszystkie else pasujace[:1]   # bez „wszystkie” = najbliższy
        ids = {p["id"] for p in usun}
        Z.pamiec_set("przypomnienia", [p for p in lista if p["id"] not in ids])
    if minutniki:
        return (f"Anulowałem minutnik, zostało mu {_czas_opis(max(0, usun[0]['ts'] - teraz()))}." if len(usun) == 1
                else f"Anulowałem wszystkie minutniki ({len(usun)}).")
    if len(usun) == 1:
        return f"Anulowałem przypomnienie {_kiedy_opis(usun[0]['ts'])}: {usun[0]['tekst']}."
    return f"Anulowałem wszystkie przypomnienia ({len(usun)})."


def straznik_przypomnien():
    while True:
        time.sleep(2)
        try:
            t = teraz()
            with _przyp_lock:
                lista = _przyp_lista()
                teraz_do = [p for p in lista if p["ts"] <= t]
                if teraz_do:
                    Z.pamiec_set("przypomnienia", [p for p in lista if p["ts"] > t])
            for p in teraz_do:
                spoznienie = t - p["ts"]
                mow = p["mow"] + (f" Z opóźnieniem {_czas_opis(round(spoznienie / 60) * 60)}." if spoznienie > 120 else "")
                print(f"przypomnienie: TERAZ {p['tekst']} (spóźnienie {int(spoznienie)} s)", flush=True)
                ustaw_alert(f"⏰ {p['mow']}", "warn", 30)
                szyna.publikuj("przypomnienie", {"mow": mow, "tekst": p["tekst"]})
        except Exception as e:  # noqa: BLE001  strażnik ma żyć dalej
            print(f"przypomnienia: błąd {e}", flush=True)


def _brief_przypomnienia(dzien=0):
    dzis = _teraz_pl().date() + Z.timedelta(days=dzien)
    lista = [p for p in _przyp_lista() if p["typ"] == "przypomnienie"
             and Z.datetime.fromtimestamp(p["ts"], Z.TZ).date() == dzis]
    if not lista:
        return None
    return "Przypomnienia: " + ", ".join(f"{_kiedy_opis(p['ts'])} {p['tekst']}" for p in lista[:3]) + "."


# --------------------------------------------------------------------------- budzik
# Jednorazowe („obudź mnie o 7”, „nastaw budzik na 6:30”, „obudź mnie za 20 minut”, /budzik na Discordzie) i stałe
# na dni tygodnia (widok Budziki z zakładki Dzień, /budzik z dniami). BUDZIK_SWIT_S przed czasem ekran budzi się
# i rozjaśnia z czerni, o czasie strona pika coraz głośniej (WebAudio — głośność multimediów telefonu) i co minutę
# mówi godzinę. „Wyłącz” / „Drzemka” przyciskami albo głosem; po BUDZIK_MAX_MIN milknie sam.
# Decyzje 2026-11-20: bez nowego APK, świt kilka sekund (nie minut), bez briefu po wyłączeniu.
BUDZIK_SWIT_S = int(E("BUDZIK_SWIT_S", "3"))
BUDZIK_DRZEMKA_MIN = int(E("BUDZIK_DRZEMKA_MIN", "9"))
BUDZIK_MAX_MIN = int(E("BUDZIK_MAX_MIN", "15"))
DNI_PN = ["pn", "wt", "śr", "cz", "pt", "sb", "nd"]
BUDZIK = {"dzwoni": False, "od": 0.0, "swit_do": 0.0, "drzemka_do": 0.0, "tekst": ""}
_budzik_lock = threading.Lock()
GODZ_SLOWA = {"pierwsz": 1, "drug": 2, "trzeci": 3, "czwart": 4, "piat": 5, "szost": 6, "siodm": 7, "osm": 8,
              "dziewiat": 9, "dziesiat": 10, "jedenast": 11, "dwunast": 12}


def _budziki():
    return Z.pamiec_get("budziki", []) or []


def _budzik_nastepny(b, po):
    """Najbliższy czas (timestamp) budzika ściśle po `po`; None = wyłączony albo jednorazowy, który już był."""
    if b.get("ts"):
        return b["ts"] if b["ts"] > po else None
    if not b.get("wl", True) or not b.get("dni"):
        return None
    d0 = Z.datetime.fromtimestamp(po, Z.TZ)
    for d in range(8):
        c = (d0 + Z.timedelta(days=d)).replace(hour=b["h"], minute=b["m"], second=0, microsecond=0)
        if c.weekday() in b["dni"] and c.timestamp() > po:
            return c.timestamp()
    return None


def _budzik_dni_opis(dni):
    dni = sorted(dni)
    return ("codziennie" if dni == list(range(7)) else "pn–pt" if dni == list(range(5)) else "weekend" if dni == [5, 6]
            else ", ".join(DNI_PN[d] for d in dni))


def _budzik_opis(b):
    return "jednorazowy" if b.get("ts") else _budzik_dni_opis(b["dni"])


def _dni_z(v):
    if isinstance(v, list):
        return sorted({int(d) for d in v if 0 <= int(d) <= 6})
    k = _bez_ogonkow(str(v or "")).strip().replace("–", "-")
    dni = {"": [], "jednorazowy": [], "jednorazowo": [], "raz": [], "codziennie": list(range(7)),
           "pn-pt": list(range(5)), "robocze": list(range(5)), "weekend": [5, 6]}.get(k)
    if dni is None:
        raise ValueError("dni: lista 0..6 (0 = poniedziałek) albo jednorazowy | pn-pt | weekend | codziennie")
    return dni


def budzik_dodaj(h, m, dni=None, ts=None, zrodlo=""):
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ValueError("godzina: 0:00..23:59")
    dni = _dni_z(dni or [])
    b = {"id": os.urandom(5).hex(), "h": h, "m": m}
    if dni:
        b.update(dni=dni, wl=True)
    else:
        if ts is None:
            n = _teraz_pl()
            c = n.replace(hour=h, minute=m, second=0, microsecond=0)
            ts = (c + Z.timedelta(days=1) if c <= n else c).timestamp()
        b["ts"] = ts
    with _budzik_lock:
        lista = _budziki()
        for x in lista:   # ten sam budzik drugi raz = bez duplikatu
            if (x.get("ts") and b.get("ts") and abs(x["ts"] - b["ts"]) < 60) or \
               (x.get("dni") and x["dni"] == b.get("dni") and (x["h"], x["m"]) == (h, m)):
                if x.get("dni"):
                    x["wl"] = True
                Z.pamiec_set("budziki", lista)
                return x
        lista.append(b)
        Z.pamiec_set("budziki", lista)
    print(f"budzik: dodany {h}:{m:02d} {_budzik_opis(b)} ({zrodlo})", flush=True)
    return b


def _godzina_z(t):
    """t bez ogonków: 'o 7', 'na 6:30', 'na 6 30', 'o siodmej trzydziesci' -> (h, m) albo None."""
    t = _cyfry(t)
    t = re.sub(r"\b(o|na)\s+(" + "|".join(GODZ_SLOWA) + r")\w*", lambda m: f"{m.group(1)} {GODZ_SLOWA[m.group(2)]}", t)
    m = (re.search(r"\b(?:o|na)\s+(?:godzin\w*\s+)?(\d{1,2})(?:[:.\s]+(\d{2}))?\b", t)
         or re.search(r"\b(\d{1,2})[:.](\d{2})\b", t))
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2) or 0)
    return (h, mi) if h <= 23 and mi <= 59 else None


def _budzik_glos(t):
    if m := re.search(r"\bza\s+", t):
        sek, _ = _trwanie(t[m.end():])
        if 60 <= sek <= 24 * 3600:
            c = Z.datetime.fromtimestamp(teraz() + sek, Z.TZ)
            b = budzik_dodaj(c.hour, c.minute, ts=c.timestamp(), zrodlo="głos")
            return {"odp": f"Dobrze, obudzę cię za {_czas_opis(sek)}, {_kiedy_opis(b['ts'])}."}
    g = _godzina_z(t)
    if not g:
        return {"odp": "Na którą nastawić budzik? Powiedz na przykład: obudź mnie o siódmej, albo nastaw budzik na 6:30."}
    b = budzik_dodaj(*g, zrodlo="głos")
    return {"odp": f"Dobrze, budzik {_kiedy_opis(b['ts'])}. To za {_czas_opis(max(60, round((b['ts'] - teraz()) / 60) * 60))}."}


def _budzik_najblizszy():
    t = teraz()
    return sorted(((n, b) for b in _budziki() if (n := _budzik_nastepny(b, t))), key=lambda x: x[0])


def _budziki_status():
    akt = _budzik_najblizszy()
    if not akt:
        return "Nie masz nastawionych budzików."
    out = [_kiedy_opis(n) + ("" if b.get("ts") else f", {_budzik_dni_opis(b['dni'])}") for n, b in akt[:4]]
    return ("Najbliższy budzik: " if len(akt) == 1 else "Budziki: ") + "; ".join(out) + "."


def _budzik_anuluj_glos():
    with _budzik_lock:
        lista = _budziki()
        jedn = sorted((b for b in lista if b.get("ts") and b["ts"] > teraz()), key=lambda b: b["ts"])
        if not jedn:
            return ("Nie ma jednorazowego budzika do anulowania. Stałe budziki wyłączysz w zakładce Dzień, przycisk Budziki."
                    if any(b.get("dni") for b in lista) else "Nie masz nastawionych budzików.")
        Z.pamiec_set("budziki", [b for b in lista if b["id"] != jedn[0]["id"]])
    return f"Anulowałem budzik {_kiedy_opis(jedn[0]['ts'])}."


def budzik_akcja(bid, akcja):
    with _budzik_lock:
        lista = _budziki()
        b = next((x for x in lista if x["id"] == bid), None)
        if b is None:
            raise ValueError("nie ma takiego budzika")
        if akcja == "usun":
            lista.remove(b)
        elif akcja in ("wl", "wyl") and b.get("dni"):
            b["wl"] = akcja == "wl"
        else:
            raise ValueError("akcja: wl | wyl (stały budzik) | usun")
        Z.pamiec_set("budziki", lista)
    opis = f"Budzik {b['h']}:{b['m']:02d}"
    return {"ok": True, "msg": f"{opis} usunięty" if akcja == "usun" else f"{opis} {'włączony' if b['wl'] else 'wyłączony'}"}


def budziki_lista():
    t = teraz()
    out = []
    for b in _budziki():
        n = _budzik_nastepny(b, t)
        out.append({**b, "wl": bool(b.get("wl", True)), "opis": _budzik_opis(b), "nastepny": n,
                    "nastepny_opis": _kiedy_opis(n) if n else None})
    out.sort(key=lambda x: (x["nastepny"] is None, x["nastepny"] or 0, x["h"], x["m"]))
    return {"budziki": out, "drzemka_min": BUDZIK_DRZEMKA_MIN, "max_min": BUDZIK_MAX_MIN, "now": t}


def _budzik_start(tekst):
    with _budzik_lock:
        BUDZIK.update(dzwoni=True, od=teraz(), swit_do=0.0, drzemka_do=0.0, tekst=tekst)
    print(f"budzik: DZWONI ({tekst})", flush=True)
    ustaw_ekran("on", 0)   # świeci do wyłączenia budzika; publikuje stan z budzikiem


def budzik_stop(drzemka=False, powod=""):
    """None = nie było czego wyłączać. Drzemka działa tylko, gdy dzwoni; „wyłącz” w czasie drzemki ją kasuje."""
    with _budzik_lock:
        dzwoni, drz = BUDZIK["dzwoni"], BUDZIK["drzemka_do"]
        if not dzwoni and not drz:
            return None
        if drzemka and dzwoni:
            BUDZIK.update(dzwoni=False, swit_do=0.0, drzemka_do=teraz() + BUDZIK_DRZEMKA_MIN * 60)
            msg = f"Drzemka, zadzwonię za {_czas_opis(BUDZIK_DRZEMKA_MIN * 60)}."
        elif drzemka:
            return f"Drzemka już trwa, zadzwonię {_kiedy_opis(drz)}."
        else:
            BUDZIK.update(dzwoni=False, swit_do=0.0, drzemka_do=0.0)
            msg = "Budzik wyłączony."
    print(f"budzik: {'drzemka' if drzemka else 'wyłączony'}{' — ' + powod if powod else ''}", flush=True)
    ustaw_ekran("auto")
    return msg


def _budzik_swit():
    with _budzik_lock:
        BUDZIK["swit_do"] = teraz() + BUDZIK_SWIT_S
    ustaw_ekran("on", 2)


def _budzik_krok(ostatnio, t):
    swit = odpal = None
    for b in _budziki():
        n = _budzik_nastepny(b, ostatnio)
        if n is not None and n <= t:
            odpal = b
        n = _budzik_nastepny(b, ostatnio + BUDZIK_SWIT_S)
        if n is not None and n - BUDZIK_SWIT_S <= t:
            swit = b
    with _budzik_lock:
        dzwoni, od, drz = BUDZIK["dzwoni"], BUDZIK["od"], BUDZIK["drzemka_do"]
    if drz:
        if ostatnio < drz - BUDZIK_SWIT_S <= t:
            swit = swit or {"drzemka": True}
        if ostatnio < drz <= t:
            odpal = odpal or {"drzemka": True}
    if dzwoni and t - od > BUDZIK_MAX_MIN * 60:
        budzik_stop(powod=f"nikt nie wyłączył przez {BUDZIK_MAX_MIN} min")
        dzwoni = False
    if swit and not dzwoni and not odpal:
        _budzik_swit()
    if odpal:
        if odpal.get("ts"):   # jednorazowy po zadzwonieniu znika z listy
            with _budzik_lock:
                Z.pamiec_set("budziki", [b for b in _budziki() if b["id"] != odpal["id"]])
        _budzik_start("Koniec drzemki" if odpal.get("drzemka") else f"Budzik {odpal['h']}:{odpal['m']:02d}")


def straznik_budzika():
    t = teraz()
    with _budzik_lock:   # jednorazowe przegapione (panel nie działał): spóźnione do 30 min dzwonią, starsze znikają
        lista = _budziki()
        stare = [b for b in lista if b.get("ts") and b["ts"] <= t]
        if stare:
            Z.pamiec_set("budziki", [b for b in lista if b not in stare])
    if any(t - b["ts"] < 1800 for b in stare):
        b = max(stare, key=lambda x: x["ts"])
        _budzik_start(f"Budzik {b['h']}:{b['m']:02d} (spóźniony — restart panelu)")
    ostatnio = t
    while True:
        time.sleep(1)
        try:
            t = teraz()
            _budzik_krok(ostatnio, t)
            ostatnio = t
        except Exception as e:  # noqa: BLE001  strażnik ma żyć dalej
            print(f"budzik: błąd {type(e).__name__}: {e}", flush=True)


# --------------------------------------------------------------------------- „Dobranoc”
# Plan na jutro + po odliczaniu: stanowisko off, oba komputery wyłączone, serwer wyłączony, panel wygaszony.
# Decyzje 2026-11-16: komputery WYŁĄCZANE (nie usypiane), bez sprawdzania, czy coś gra/pobiera; ochrona przed
# źle usłyszanym słowem = odliczanie (DOBRANOC_S po przeczytaniu odpowiedzi), „anuluj” albo dotknięcie przerywa.
DOBRANOC_S = 15
DOBRANOC_DO_H = int(E("DOBRANOC_DO_H", "6"))   # o tej godzinie rano blokada kamery zdejmuje się sama (decyzja 2026-11-16)
_dobranoc = {"id": None, "do": 0.0}
_dobranoc_lock = threading.Lock()


def _plan_na_jutro():
    n = _teraz_pl()
    dzien = 0 if n.hour < 5 else 1            # po północy „jutro” to już dziś
    slowo = "Dziś" if dzien == 0 else "Jutro"
    out = []
    try:
        if dzien == 1:
            out.append(_pogoda_zdanie(jutro=True))
        else:
            p = _pogoda_zdanie()   # „Teraz X, opis. Dziś od A do B…” -> tylko część „Dziś…”
            out.append("Dziś " + p.split(" Dziś ", 1)[1] if p and " Dziś " in p else p)
    except Exception as e:  # noqa: BLE001
        print(f"dobranoc: pogoda: {e}", flush=True)
    for fn, przedrostek in ((_brief_kalendarz, True), (_brief_przypomnienia, False)):
        try:
            z = fn(dzien)
            if z:
                out.append(f"{slowo} {z[0].lower()}{z[1:]}" if przedrostek else z)   # przypomnienia mają już „jutro o…”
        except Exception as e:  # noqa: BLE001
            print(f"dobranoc: {fn.__name__}: {e}", flush=True)
    akt = _budzik_najblizszy()
    if akt and akt[0][0] - teraz() < 86400:
        out.append(f"Budzik {_kiedy_opis(akt[0][0])}.")
    return " ".join(x for x in out if x)


def _dobranoc_wykonaj(ident):
    while True:
        time.sleep(0.5)
        with _dobranoc_lock:
            if _dobranoc["id"] != ident:
                print("dobranoc: anulowane", flush=True)
                return
            if teraz() >= _dobranoc["do"]:
                _dobranoc["id"] = None
                break
    wyniki = []
    # 1) kamera nie może zaraz włączyć monitora z powrotem (odchodzisz od biurka)
    n = _teraz_pl()
    rano = n.replace(hour=DOBRANOC_DO_H, minute=0, second=0, microsecond=0)
    if rano <= n:
        rano += Z.timedelta(days=1)
    Z.pamiec_set("obecnosc_pauza_do", rano.timestamp())
    # 2) stanowisko
    for g in STANOWISKO:
        try:
            wyniki.append(Z.gniazdo_ustaw(g, "off")["msg"])
        except Exception as e:  # noqa: BLE001
            wyniki.append(f"{g}: {e}")
    cache.drop("dash-gniazda")
    # 3) komputery — wyłączenie (agent: shutdown /s /t 5); wyłączony agent = komputer już śpi/jest wyłączony
    for pc in Z.lista_pc():
        try:
            Z.agent(pc, "/api/zasilanie/wylacz", method="POST", body={}, timeout=4)
            wyniki.append(f"{pc['nazwa']}: wyłączam")
        except Exception:  # noqa: BLE001
            wyniki.append(f"{pc['nazwa']}: nie odpowiada (pewnie już wyłączony)")
    cache.drop("pc", "dash-pcs")
    # 4) serwer
    try:
        if serwer_up():
            akcja_sleep()
            wyniki.append("serwer: wyłączam")
        else:
            wyniki.append("serwer: już śpi")
    except Exception as e:  # noqa: BLE001
        wyniki.append(f"serwer: {e}")
    # 5) panel
    ustaw_ekran("sleep")
    print(f"dobranoc: {'; '.join(wyniki)} | kamera bez automatu do {rano:%d.%m %H:%M}", flush=True)


def dobranoc_start():
    ident = os.urandom(6).hex()
    plan = _plan_na_jutro()
    koniec = "Wyłączam stanowisko, komputery i serwer za 15 sekund. Powiedz anuluj albo dotknij ekranu, żeby przerwać."
    odp = "Dobranoc. " + (plan + " " if plan else "") + koniec
    mow = _do_mowy(odp, BRIEF_ZNAKI)
    # odliczanie liczy się od końca czytania (~13 znaków/s), bo w trakcie mowy mikrofon nie słucha „anuluj”
    do = teraz() + DOBRANOC_S + len(mow) / 13
    with _dobranoc_lock:
        _dobranoc.update(id=ident, do=do)
    threading.Thread(target=_dobranoc_wykonaj, args=(ident,), daemon=True).start()
    print(f"dobranoc: start, wykonanie za {int(do - teraz())} s", flush=True)
    return {"odp": odp, "mow_limit": BRIEF_ZNAKI, "akcja": {"dobranoc": {"do_ms": int(do * 1000)}}}


def dobranoc_anuluj():
    with _dobranoc_lock:
        bylo = _dobranoc["id"] is not None
        _dobranoc.update(id=None, do=0.0)
    return bylo


def dobranoc_trwa():
    with _dobranoc_lock:
        return _dobranoc["id"] is not None


# --------------------------------------------------------------------------- historia CPU/GPU komputerów
# W tle co HIST_CO_S s: obciążenie i temperatury z agenta, ostatnie ~10 min (HIST_N próbek) na komputer —
# zakładka Komputer rysuje z tego wykresy. Wyłączony komputer: próba raz na minutę, stara historia znika.
HIST_CO_S = 5
HIST_N = 120
_hist = {}
_hist_lock = threading.Lock()


def probkowanie_pc():
    nastepna = {}
    while True:
        t0 = teraz()
        try:
            for pc in Z.lista_pc():
                if t0 < nastepna.get(pc["id"], 0):
                    continue
                try:
                    s = Z.agent(pc, "/api/stan", timeout=2)
                    cpu, gpu = (s or {}).get("cpu") or {}, (s or {}).get("gpu") or {}
                    with _hist_lock:
                        _hist.setdefault(pc["id"], collections.deque(maxlen=HIST_N)).append(
                            [int(t0), cpu.get("obciazenie"), gpu.get("obciazenie"), cpu.get("temp"), gpu.get("temp")])
                except Exception:  # noqa: BLE001  wyłączony / śpi
                    nastepna[pc["id"]] = t0 + 60
                    with _hist_lock:
                        _hist.pop(pc["id"], None)
        except Exception as e:  # noqa: BLE001
            print(f"historia pc: {e}", flush=True)
        time.sleep(max(1.0, HIST_CO_S - (teraz() - t0)))


def _procesy():
    """Widok „Procesy”: top CPU/RAM z agenta 1.1+ dla każdego komputera (starszy agent -> 404 -> komunikat)."""
    def jeden(pc):
        def f():
            return Z.agent(pc, "/api/procesy", timeout=2.5)
        return f
    wyniki = Z.rownolegle({pc["id"]: jeden(pc) for pc in Z.lista_pc()})
    out = []
    for pc in Z.lista_pc():
        w = wyniki.get(pc["id"]) or {}
        blad = w.get("error") or ""
        out.append({"id": pc["id"], "nazwa": pc["nazwa"], "online": bool(w.get("ok")), "procesy": w.get("data"),
                    "error": "agent bez obsługi procesów — zaktualizuj go do wersji 1.1" if "404" in blad else blad})
    return out


def _tab_pc():
    """Stan komputerów (cache 2 s) + historia [czas, cpu %, gpu %, cpu °C, gpu °C] do wykresów na zakładce Komputer."""
    w = cache.get("pc", 2, lambda: Z.pc_stan(("stan", "audio")))
    if not w.get("ok"):
        return w
    with _hist_lock:
        pcs = [{**p, "historia": list(_hist.get(p["id"], []))} for p in w["data"]]
    return {**w, "data": pcs}


# --------------------------------------------------------------------------- paczki do odbioru i nowe w Jellyfinie
# Paczki: mail-notifier zapisuje maile o paczkach (z kodem odbioru) w swoim stanie; tu chowamy te oznaczone
# „Odebrana” (pamiec paczki_odebrane). Nowe odcinki/filmy: gdy serwer działa, co 10 min historia importów
# Sonarra/Radarra -> pamiec nowe_media. Jedno i drugie ogłaszamy raz: w briefie albo przy siadaniu do biurka.
MEDIA_CO_S = 600


def _poczta():
    w = cache.get("poczta", 30, Z.poczta)
    if not w.get("ok") or not isinstance(w.get("data"), dict) or "paczki" not in w["data"]:
        return w
    odebrane = set(Z.pamiec_get("paczki_odebrane", []) or [])
    return {**w, "data": {**w["data"], "paczki": [p for p in w["data"]["paczki"] if p.get("id") not in odebrane]}}


def paczka_odebrana(pid):
    lista = [x for x in (Z.pamiec_get("paczki_odebrane", []) or []) if x != pid] + [pid]
    Z.pamiec_set("paczki_odebrane", lista[-60:])
    cache.drop("poczta")
    return {"ok": True, "msg": "Paczka odebrana — schowana z listy"}


def _paczki():
    w = _poczta()
    return ((w.get("data") or {}).get("paczki") or []) if w.get("ok") else []


def _paczka_opis(p):
    od = re.sub(r"\s*<[^>]*>", "", str(p.get("od") or "")).strip().strip('"') or "przesyłka"
    return f"{od}, kod {p['kod']}" if p.get("kod") else od


def _media_opis(m):
    if m.get("odc"):
        mm = re.match(r"S(\d+)E(\d+)", m["odc"])
        return f"{m['tytul']}, sezon {int(mm.group(1))}, odcinek {int(mm.group(2))}" if mm else f"{m['tytul']} {m['odc']}"
    return f"{m['tytul']}" + (f" ({m['rok']})" if m.get("rok") else "")


def zbieranie_mediow():
    while True:
        try:
            if serwer_up():
                pobrane = Z.media_pobrane()
                znane = Z.pamiec_get("nowe_media", None)
                if znane is None:   # pierwsze uruchomienie: cała dotychczasowa historia = już ogłoszona
                    Z.pamiec_set("nowe_media", [{**m, "ogloszone": True} for m in pobrane][:40])
                else:
                    ids = {m["id"] for m in znane}
                    nowe = [{**m, "ogloszone": False} for m in pobrane if m["id"] not in ids]
                    if nowe:
                        print(f"media: nowe {', '.join(_media_opis(m) for m in nowe)}", flush=True)
                        Z.pamiec_set("nowe_media", (nowe + znane)[:40])
        except Exception as e:  # noqa: BLE001
            print(f"media: {e}", flush=True)
        time.sleep(MEDIA_CO_S)


def _nowe_media(oznacz):
    """Odcinki/filmy jeszcze nieogłoszone; oznacz=True -> od teraz ogłoszone."""
    wszystkie = Z.pamiec_get("nowe_media", []) or []
    nowe = [m for m in wszystkie if not m.get("ogloszone")]
    if oznacz and nowe:
        Z.pamiec_set("nowe_media", [{**m, "ogloszone": True} for m in wszystkie])
    return nowe


def _nowe_paczki(oznacz):
    """Paczki (nieodebrane) jeszcze nieogłoszone; oznacz=True -> od teraz ogłoszone."""
    ogl = list(Z.pamiec_get("paczki_ogloszone", []) or [])
    nowe = [p for p in _paczki() if p.get("id") not in set(ogl)]
    if oznacz and nowe:
        Z.pamiec_set("paczki_ogloszone", (ogl + [p["id"] for p in nowe])[-60:])
    return nowe


def _brief_paczki():
    p = _paczki()
    _nowe_paczki(oznacz=True)   # brief mówi o wszystkich czekających — od teraz ogłoszone
    if not p:
        return None
    return ("Paczka do odbioru: " if len(p) == 1 else f"Paczki do odbioru ({len(p)}): ") + "; ".join(_paczka_opis(x) for x in p[:3]) + "."


def _brief_media():
    media = _nowe_media(oznacz=True)
    if not media:
        return None
    return "Nowe w Jellyfinie: " + "; ".join(_media_opis(m) for m in media[:4]) + (f" i jeszcze {len(media) - 4}" if len(media) > 4 else "") + "."


def nowosci_przy_siadaniu():
    """Komunikat przy powrocie do biurka (gdy dziś brief już był): tylko to, czego jeszcze nie ogłoszono."""
    media, paczki = _nowe_media(oznacz=True), _nowe_paczki(oznacz=True)
    czesci = []
    if media:
        czesci.append("Nowe w Jellyfinie: " + "; ".join(_media_opis(m) for m in media[:4]) + ".")
    if paczki:
        czesci.append(("Nowa paczka do odbioru: " if len(paczki) == 1 else "Nowe paczki do odbioru: ")
                      + "; ".join(_paczka_opis(p) for p in paczki[:3]) + ".")
    if not czesci:
        return None
    t = " ".join(czesci)
    print(f"nowości przy siadaniu: {t}", flush=True)
    return {"odp": t, "mow": _do_mowy(t, BRIEF_ZNAKI), "tytul": "Nowości"}


# --------------------------------------------------------------------------- sieć: alert o nowym nieznanym urządzeniu
# Co SIEC_CO_S lista z ZTE + skan ARP malinki -> pamiec "urzadzenia" {MAC: {nazwa, host, ip, pierwszy, ostatni, znane}}.
# Pierwsze uruchomienie: wszystko, co jest w sieci, = znane (decyzja 2026-11-20). Nowy MAC -> Discord + baner i komunikat
# głosowy na panelu. W ciche godziny (SIEC_CISZA_OD..SIEC_CISZA_DO) nic nie budzi: zbiorczo na Discordzie po
# SIEC_CISZA_DO i w briefie. Zatwierdzanie i nazwy: zakładka Sieć. Tylko alert, bez blokowania w routerze.
SIEC_CO_S = int(E("SIEC_CO_S", "300"))
SIEC_CISZA_OD, SIEC_CISZA_DO = int(E("SIEC_CISZA_OD", "23")), int(E("SIEC_CISZA_DO", "7"))
SIEC_ONLINE_S = 15 * 60   # widziane w ostatnich 3 skanach = „w sieci”
_siec_lock = threading.Lock()


def _siec_cisza():
    h = _teraz_pl().hour
    if SIEC_CISZA_OD > SIEC_CISZA_DO:
        return h >= SIEC_CISZA_OD or h < SIEC_CISZA_DO
    return SIEC_CISZA_OD <= h < SIEC_CISZA_DO


def _urz_nazwa(mac, u):
    return u.get("nazwa") or u.get("host") or ("prywatny MAC (telefon/laptop)" if Z.mac_prywatny(mac) else "bez nazwy")


def _siec_powiadom(nowe, rano=False):
    """nowe: [(MAC, wpis)]. rano=True: zbiorczo za noc, tylko Discord (resztę powie brief)."""
    jedno = len(nowe) == 1
    tytul = ("W nocy: n" if rano else "N") + ("owe nieznane urządzenie w sieci" if jedno else f"owe nieznane urządzenia w sieci ({len(nowe)})")
    linie = "\n".join(f"• **{_urz_nazwa(m, u)}** · {u.get('ip') or '?'} · `{m}` · od {time.strftime('%d.%m %H:%M', time.localtime(u['pierwszy']))}"
                      for m, u in nowe[:15])
    try:
        if not Z.discord_wyslij("🛜 " + tytul, linie + "\n\nZatwierdź albo nadaj nazwę na panelu: zakładka Sieć."):
            print("sieć: brak DISCORD_WEBHOOK w .env — bez Discorda", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"sieć: Discord: {e}", flush=True)
    if rano:
        return
    m, u = nowe[0]
    ustaw_alert(f"🛜 {tytul}: {_urz_nazwa(m, u)}, {u.get('ip') or m}" + ("" if jedno else f" i jeszcze {len(nowe) - 1}"), "warn", 10)
    if not _obecnosc_pauza():
        mow = "W sieci pojawiło się nowe, nieznane urządzenie." if jedno else f"W sieci pojawiły się nowe, nieznane urządzenia: {len(nowe)}."
        szyna.publikuj("przypomnienie", {"mow": mow + " Szczegóły w zakładce Sieć.", "tekst": tytul})


def _siec_krok():
    widziane, bledy = Z.urzadzenia_sieci()
    for b in bledy:
        print(f"sieć: {b}", flush=True)
    if not widziane:
        return
    t, cisza = teraz(), _siec_cisza()
    with _siec_lock:
        znane = Z.pamiec_get("urzadzenia", None)
        pierwszy_raz = znane is None
        znane = znane or {}
        if pierwszy_raz:   # komputery z WoL znamy z .env, nawet jeśli teraz są wyłączone
            for nazwa, mac in [("Serwer", SERVER_MAC)] + [(pc["nazwa"], pc["mac"]) for pc in Z.lista_pc()]:
                if Z.mac_norm(mac):
                    znane.setdefault(Z.mac_norm(mac), {"nazwa": nazwa, "pierwszy": t, "znane": True})
        nowe = []
        for mac, w in widziane.items():
            u = znane.get(mac)
            if u is None:
                u = znane[mac] = {"nazwa": None, "pierwszy": t, "znane": pierwszy_raz}
                if not pierwszy_raz:
                    nowe.append(mac)
            u.update(ip=w["ip"], host=w["host"] or u.get("host"), ostatni=t)
        Z.pamiec_set("urzadzenia", znane)
        noc = list(Z.pamiec_get("urzadzenia_noc", []) or [])
        if nowe and cisza:
            noc += [m for m in nowe if m not in noc]
            Z.pamiec_set("urzadzenia_noc", noc)
        rano = []
        if noc and not cisza:   # pierwszy skan po ciszy: zbiorczo to, czego w nocy nie zatwierdzono
            rano = [(m, dict(znane[m])) for m in noc if m in znane and not znane[m].get("znane")]
            Z.pamiec_set("urzadzenia_noc", [])
        nowe_wpisy = [(m, dict(znane[m])) for m in nowe]
    if pierwszy_raz:
        print(f"sieć: pierwsze uruchomienie — {len(widziane)} {_odmiana(len(widziane), 'urządzenie', 'urządzenia', 'urządzeń')} w sieci zapamiętane jako znane", flush=True)
    if nowe_wpisy:
        print("sieć: nowe " + ", ".join(f"{m} {u.get('ip')}" for m, u in nowe_wpisy) + (" (cisza — rano)" if cisza else ""), flush=True)
        if not cisza:
            _siec_powiadom(nowe_wpisy)
    if rano:
        _siec_powiadom(rano, rano=True)


def straznik_sieci():
    time.sleep(30)   # najpierw niech wstanie reszta panelu
    while True:
        try:
            _siec_krok()
        except Exception as e:  # noqa: BLE001
            print(f"sieć: {type(e).__name__}: {e}", flush=True)
        time.sleep(SIEC_CO_S)


def _urzadzenia_lista():
    t = teraz()
    out = [{"mac": m, "nazwa": u.get("nazwa"), "host": u.get("host"), "ip": u.get("ip"), "znane": bool(u.get("znane")),
            "prywatny": Z.mac_prywatny(m), "pierwszy": u.get("pierwszy"), "ostatni": u.get("ostatni"),
            "online": t - (u.get("ostatni") or 0) < SIEC_ONLINE_S}
           for m, u in (Z.pamiec_get("urzadzenia", {}) or {}).items()]

    def ip_klucz(ip):
        try:
            return tuple(int(x) for x in str(ip).split("."))
        except ValueError:
            return (999,)
    return sorted(out, key=lambda x: (x["znane"], not x["online"], ip_klucz(x["ip"])))


def siec_urzadzenie(mac, b):
    mac = Z.mac_norm(mac)
    if not mac:
        raise ValueError("zły adres MAC")
    with _siec_lock:
        znane = Z.pamiec_get("urzadzenia", {}) or {}
        u = znane.get(mac)
        if u is None:
            raise ValueError("nie ma takiego urządzenia")
        if "nazwa" in b:
            u["nazwa"] = " ".join(str(b.get("nazwa") or "").split())[:40] or None
            if u["nazwa"]:
                u["znane"] = True   # nadanie nazwy = zatwierdzenie
        if "znane" in b:
            u["znane"] = bool(b["znane"])
        Z.pamiec_set("urzadzenia", znane)
    return {"ok": True, "msg": f"{_urz_nazwa(mac, u)}: " + ("znane ✓" if u["znane"] else "do zatwierdzenia")}


def _brief_siec():
    n = [u for u in _urzadzenia_lista() if not u["znane"]]
    if not n:
        return None
    opis = "; ".join((u["nazwa"] or u["host"] or ("telefon lub laptop z prywatnym MAC" if u["prywatny"] else "bez nazwy"))
                     + (f", adres .{u['ip'].rsplit('.', 1)[-1]}" if u["ip"] else "") for u in n[:3])
    return (("Nieznane urządzenie w sieci: " if len(n) == 1 else f"Nieznane urządzenia w sieci ({len(n)}): ")
            + opis + (f" i jeszcze {len(n) - 3}" if len(n) > 3 else "") + ". Zatwierdź w zakładce Sieć.")


# --------------------------------------------------------------------------- Claude: limity planu
# Co CLAUDE_CO_S (nieoficjalne /api/oauth/usage, sesja malinki — zrodla.claude_limity) -> pamiec claude_limity
# + historia claude_hist (7 dni). Przekroczenie progu z CLAUDE_PROGI albo odnowienie limitu, który próg przekroczył:
# baner bez głosu + Discord (ping tylko przy progu; w ciche godziny sieci bez banera i bez pingu).
# Brief: zdanie, gdy tydzień >= CLAUDE_BRIEF_OD %. Głosem: „ile mam limitu w Claude”. Decyzje 2026-11-20.
CLAUDE_CO_S = int(E("CLAUDE_CO_S", "600"))
CLAUDE_PROGI = sorted({int(x) for x in E("CLAUDE_PROGI", "80,100").split(",") if x.strip().isdigit()}) or [80]
CLAUDE_BRIEF_OD = int(E("CLAUDE_BRIEF_OD", "50"))
CLAUDE_GLOS = r"\b(claud|cloud|klaud|klod|clod)"   # rozpoznawanie mowy Google słyszy „Claude” jako „cloud”
DNI_W = ["w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę", "w niedzielę"]
_cl = {"ost": 0.0}
_cl_lock = threading.Lock()


def _kiedy_tydz(ts):
    d = Z.datetime.fromtimestamp(ts, Z.TZ)
    return _kiedy_opis(ts) if (d.date() - _teraz_pl().date()).days <= 1 else f"{DNI_W[d.weekday()]} o {d.hour}:{d.minute:02d}"


def claude_pobierz(min_odstep=60):
    """Świeże limity, ale nie częściej niż co min_odstep s (endpoint szybko odpowiada 429)."""
    with _cl_lock:
        if teraz() - _cl["ost"] < min_odstep:
            return Z.pamiec_get("claude_limity")
        _cl["ost"] = teraz()
    try:
        d = Z.claude_limity()
    except Exception as e:  # noqa: BLE001
        if isinstance(e, urllib.error.HTTPError) and e.code == 429:
            with _cl_lock:
                _cl["ost"] = teraz() + 1800   # zbyt często — następna próba za ~40 min
        stare = Z.pamiec_get("claude_limity") or {}
        stare.update(blad=f"{type(e).__name__}: {e}"[:200], blad_ts=teraz())
        Z.pamiec_set("claude_limity", stare)
        print(f"claude: {stare['blad']}", flush=True)
        return stare
    if d.get("disabled"):
        return d
    proc = {x["kind"]: x["proc"] for x in d["limity"]}
    hist = [h for h in (Z.pamiec_get("claude_hist", []) or []) if h[0] > d["ts"] - 7 * 86400]
    hist.append([round(d["ts"]), proc.get("session"), proc.get("weekly_all")])
    Z.pamiec_set("claude_hist", hist[-1200:])
    Z.pamiec_set("claude_limity", d)
    try:
        _claude_alerty(d)
    except Exception as e:  # noqa: BLE001
        print(f"claude: alerty: {e}", flush=True)
    return d


def _claude_alerty(d):
    stan = Z.pamiec_get("claude_alerty", {}) or {}
    kom = []
    for x in d["limity"]:
        st = stan.get(x["kind"]) or {}
        if st.get("reset") and x.get("reset") and x["reset"] > st["reset"] + 60:   # nowe okno limitu
            if st.get("prog"):
                kom.append(("reset", f"{x['nazwa']}: limit się odnowił, teraz {x['proc']:.0f}%."))
            st = {}
        nowe = [pr for pr in CLAUDE_PROGI if x["proc"] >= pr > (st.get("prog") or 0)]
        if nowe:
            st["prog"] = max(nowe)
            kom.append(("prog", f"{x['nazwa']}: wykorzystane {x['proc']:.0f}%"
                        + (f", odnowi się {_kiedy_tydz(x['reset'])}" if x.get("reset") else "") + "."))
        st.update(reset=x.get("reset"), proc=x["proc"])
        stan[x["kind"]] = st
    Z.pamiec_set("claude_alerty", stan)
    if not kom:
        return
    print("claude: " + " ".join(t for _, t in kom), flush=True)
    prog, cisza = any(r == "prog" for r, _ in kom), _siec_cisza()
    try:
        Z.discord_wyslij("🤖 Limity Claude", "\n".join("• " + t for _, t in kom), kolor=0xD97757, ping=prog and not cisza)
    except Exception as e:  # noqa: BLE001
        print(f"claude: Discord: {e}", flush=True)
    if not cisza:
        ustaw_alert("🤖 " + " ".join(t for _, t in kom), "warn" if prog else "info", 10)


def straznik_claude():
    time.sleep(40)
    while True:
        try:
            claude_pobierz(min_odstep=CLAUDE_CO_S - 30)
        except Exception as e:  # noqa: BLE001
            print(f"claude: {type(e).__name__}: {e}", flush=True)
        time.sleep(60)


def tab_claude():
    d = Z.pamiec_get("claude_limity") or claude_pobierz() or {}
    return {"claude": d, "hist": Z.pamiec_get("claude_hist", []) or [], "progi": CLAUDE_PROGI, "co_s": CLAUDE_CO_S,
            "powiadomienia": Z.pamiec_get("claude_powiadomienia", []) or [], "now": teraz()}


# Powiadomienia aplikacji Claude („needs your input”) z centrum powiadomień Windows — agent 1.2 czyta je lokalnie,
# zero tokenów. Agent widzi tylko te, które jeszcze wiszą w Windows; historię (30) trzymamy tu, „aktywne” = wciąż
# wisi (nieodpowiedziane / niezamknięte). Tylko lista w zakładce Claude, bez banera i głosu (decyzja 2026-11-20).
CLAUDE_POW_CO_S = 15


def _claude_pow_krok():
    zebrane, pcs_ok = [], set()
    for pc in Z.lista_pc():
        try:
            lst = Z.agent(pc, "/api/claude/powiadomienia")
        except Exception:  # noqa: BLE001  offline albo agent starszy niż 1.2
            continue
        if not isinstance(lst, list):
            continue
        pcs_ok.add(pc["nazwa"])
        zebrane += [{"id": f"{pc['id']}:{x.get('id')}:{int(x.get('czas') or 0)}", "pc": pc["nazwa"], "czas": x.get("czas"),
                     "tytul": str(x.get("tytul") or "Claude")[:120], "tresc": str(x.get("tresc") or "")[:200]} for x in lst]
    if not pcs_ok:
        return
    po_id = {x["id"]: x for x in Z.pamiec_get("claude_powiadomienia", []) or []}
    teraz_ids = {x["id"] for x in zebrane}
    zmiana = False
    for x in zebrane:
        if x["id"] not in po_id:
            po_id[x["id"]] = {**x, "aktywne": True}
            zmiana = True
            print(f"claude: powiadomienie z {x['pc']}: {x['tytul']} — {x['tresc']}", flush=True)
    for k, x in po_id.items():
        if x["pc"] in pcs_ok and x.get("aktywne") != (k in teraz_ids):
            x["aktywne"] = k in teraz_ids
            zmiana = True
    if zmiana:
        Z.pamiec_set("claude_powiadomienia", sorted(po_id.values(), key=lambda x: x.get("czas") or 0, reverse=True)[:30])


def straznik_powiadomien_claude():
    time.sleep(25)
    while True:
        try:
            _claude_pow_krok()
        except Exception as e:  # noqa: BLE001
            print(f"claude: powiadomienia: {type(e).__name__}: {e}", flush=True)
        time.sleep(CLAUDE_POW_CO_S)


def _brief_claude():
    d = Z.pamiec_get("claude_limity") or {}
    w = next((x for x in d.get("limity") or [] if x["kind"] == "weekly_all"), None)
    if not w or w["proc"] < CLAUDE_BRIEF_OD or teraz() - (d.get("ts") or 0) > 6 * 3600:
        return None
    return (f"Claude: tygodniowy limit wykorzystany w {w['proc']:.0f}%"
            + (f", odnowi się {_kiedy_tydz(w['reset'])}" if w.get("reset") else "") + ".")


def _claude_glos():
    d = claude_pobierz(120) or {}
    if d.get("disabled"):
        return "Malinka nie jest zalogowana do Claude."
    if not d.get("limity"):
        return "Nie mam danych o limitach Claude" + (f": {d['blad']}" if d.get("blad") else ".")
    czesci = [f"{x['nazwa'].split(' (')[0].replace(' · ', ' ')} {x['proc']:.0f} procent"
              + (f", odnowi się {_kiedy_tydz(x['reset'])}" if x.get("reset") else "") for x in d["limity"]]
    return "Limity Claude: " + "; ".join(czesci) + "."


# --------------------------------------------------------------------------- Claude Code (hooki z laptopa)
# UserPromptSubmit = start pracy; Stop = koniec (powiadamiamy, gdy trwało >= CLAUDE_MIN_S — krótkie odpowiedzi
# pomijamy); Notification permission_prompt = czeka na zgodę. idle_prompt pomijamy (dubluje Stop po ~60 s).
CLAUDE_MIN_S = int(E("CLAUDE_MIN_S", "30"))
_claude = {}
_claude_lock = threading.Lock()


def _powiadom(tekst, ikona="🤖", minuty=10):
    """Baner na panelu (budzi ekran) + pik i czytanie na głos; po „Dobranoc” (pauza do rana) tylko baner."""
    ustaw_alert(f"{ikona} {tekst}", "info", minuty)
    if not _obecnosc_pauza():
        szyna.publikuj("przypomnienie", {"mow": tekst, "tekst": tekst})


def claude_zdarzenie(b):
    zd = str(b.get("zdarzenie") or "")
    sesja = str(b.get("sesja") or "")[:80]
    projekt = re.sub(r"[^\w .\-]", "", str(b.get("projekt") or ""))[:60] or "bez nazwy"
    t = teraz()
    with _claude_lock:
        for k in [k for k, v in _claude.items() if t - v > 86400]:
            del _claude[k]
        if zd == "UserPromptSubmit":
            _claude[sesja] = t
            return {"ok": True}
        start = _claude.pop(sesja, None) if zd == "Stop" else None
    if zd == "Stop":
        if start is None or t - start < CLAUDE_MIN_S:
            return {"ok": True, "pominiete": "krótka odpowiedź"}
        tekst = f"Claude skończył pracę w projekcie {projekt}. Trwało {_czas_opis(t - start if t - start < 60 else round((t - start) / 60) * 60)}."
    elif zd == "Notification" and b.get("typ") == "permission_prompt":
        tekst = f"Claude czeka na twoją zgodę w projekcie {projekt}."
    else:
        return {"ok": True, "pominiete": "inne zdarzenie"}
    print(f"claude: {tekst}", flush=True)
    _powiadom(tekst)
    return {"ok": True, "powiadomienie": tekst}


# --------------------------------------------------------------------------- akcje
def wol(mac_txt):
    mac = bytes.fromhex(re.sub(r"[^0-9a-fA-F]", "", mac_txt or ""))
    if len(mac) != 6:
        raise ValueError("MAC: zły format albo brak")
    pakiet = b"\xff" * 6 + mac * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for port in (9, 7):
            s.sendto(pakiet, (WOL_BROADCAST, port))


def akcja_wake():
    if not SERVER_MAC:
        raise ValueError("brak SERVER_MAC w .env")
    wol(SERVER_MAC)
    _budzenie["ts"] = teraz()
    cache.drop("serwer")
    return {"msg": "Wysłano WoL — serwer wstaje (zwykle 1–3 min)"}


def _ssh_serwer(polecenie):
    if not SERVER_IP:
        raise ValueError("brak SERVER_IP w .env")
    if not os.path.exists(SSH_KEY):
        raise ValueError(f"brak klucza SSH {SSH_KEY} (zamontuj klucz bota z ssh_keys/)")
    cmd = ["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
           "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
           f"{SSH_USER}@{SERVER_IP}", polecenie]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
    err = (r.stderr or "").strip()
    # przy poweroff/reboot serwer potrafi zerwać połączenie zanim ssh dostanie kod wyjścia (255)
    zerwane = r.returncode == 255 and re.search(r"closed by remote host|Connection reset|closed\.?$", err)
    if r.returncode != 0 and not zerwane:
        raise RuntimeError(err.splitlines()[-1] if err else f"ssh: kod {r.returncode}")
    cache.drop("serwer")


def akcja_sleep():
    _ssh_serwer("poweroff")
    return {"msg": "Serwer się wyłącza"}


def akcja_reboot():
    _ssh_serwer("reboot")
    return {"msg": "Serwer się restartuje"}


def akcja_sync():
    st, d = http_json(f"{TRENER_URL}/api/sync", method="POST", body={}, timeout=120)
    cache.drop("trening", "tab-trening")
    d = d or {}
    return {"msg": f"Treningi: nowe {d.get('nowe', 0)}, zaktualizowane {d.get('zaktualizowane', 0)}"
                   + (f", błędy {len(d.get('bledy') or [])}" if d.get("bledy") else "")}


AKCJE = {"wake": akcja_wake, "sleep": akcja_sleep, "reboot": akcja_reboot, "sync": akcja_sync}
POLECENIA_PC = re.compile(r"audio/(glosnosc|wycisz|wyjscie|aplikacja)|media/(toggle|nastepny|poprzedni)"
                          r"|zasilanie/(uspij|wylacz|restart|zablokuj)|discord/(mikrofon|sluchawki|rozlacz)|speedtest"
                          r"|procesy/zakoncz")


# --------------------------------------------------------------------------- asystent głosowy: POST /api/jarvis {"tekst"}
# Telefon („Hey Jarvis” + rozpoznawanie mowy Google) przysyła tekst polecenia. Znane komendy wykonujemy od razu,
# resztę pytamy AI w n8n na serwerze (gdy działa). Celowo BEZ usypiania/wyłączania czegokolwiek — źle usłyszane
# słowo nie może położyć serwera ani komputera.
N8N_CHAT = E("N8N_CHAT", "")   # domyślnie http://SERVER_IP:N8N_PORT/webhook/chat
ZAKLADKI_GLOS = [("przeglad", r"przeglad|glown|start"), ("dzien", r"dzien|kalendarz|plan|mail|faktur"),
                 ("pc", r"komputer|\bpc\b"), ("muzyka", r"muzyk|piosenk|utwor|discord"), ("claude", r"\bclaud|\bcloud|\bklaud|\bklod|limit"),
                 ("media", r"media|pobier|torrent|film|serial"), ("serwery", r"serwer|kontener|docker"),
                 ("siec", r"siec|internet|router|speedtest|lacz"), ("trening", r"trening|silowni|cwicz"),
                 ("swiatlo", r"swiatl|led")]


def _bez_ogonkow(s):
    """Małe litery bez polskich znaków, znak w znak (ta sama długość — indeksy pasują do oryginału)."""
    return "".join("l" if c == "ł" else unicodedata.normalize("NFD", c)[0] for c in s.lower())


def _stopnie(v, dopelniacz=False):
    """Odmiana: 'Teraz 2 stopnie' (mianownik), 'od 2 stopni do 1 stopnia' (dopelniacz po od/do)."""
    n = round(v)
    a = abs(n)
    if dopelniacz:
        return f"{'minus ' if n < 0 else ''}{a} {'stopnia' if a == 1 else 'stopni'}"
    slowo = "stopień" if a == 1 else "stopnie" if a % 10 in (2, 3, 4) and a % 100 not in (12, 13, 14) else "stopni"
    return f"{'minus ' if n < 0 else ''}{a} {slowo}"


def _pogoda_opis(kod):
    if kod is None:
        return ""
    for od, do, opis in ((0, 0, "bezchmurnie"), (1, 1, "przeważnie pogodnie"), (2, 2, "częściowe zachmurzenie"),
                         (3, 3, "pochmurno"), (45, 48, "mgła"), (51, 57, "mżawka"), (61, 67, "deszcz"),
                         (71, 77, "śnieg"), (80, 82, "przelotne opady"), (85, 86, "przelotny śnieg"), (95, 99, "burza")):
        if od <= kod <= do:
            return opis
    return ""


def _godzina():
    try:
        from zoneinfo import ZoneInfo
        import datetime
        return datetime.datetime.now(ZoneInfo("Europe/Warsaw")).strftime("%H:%M")
    except Exception:  # noqa: BLE001  brak tzdata w obrazie
        return time.strftime("%H:%M")


def _pc_glos():
    """Komputer do poleceń głosowych: ten, na którym coś gra; inaczej pierwszy włączony."""
    pcs = [p for p in Z.pc_stan(("media", "audio")) if p.get("online")]
    if not pcs:
        raise ValueError("żaden komputer nie jest włączony")
    gra = [p for p in pcs if (p.get("media") or {}).get("stan") == "gra"]
    return (gra or pcs)[0]


def _pc_cmd(pc, cmd, body=None):
    Z.agent(Z.pc_po_id(pc["id"]), f"/api/{cmd}", method="POST", body=body or {}, timeout=6)
    cache.drop("pc", "muzyka")


def _do_mowy(tekst, limit=500):
    """Odpowiedź do czytania na głos: bez znaczników markdown, najwyżej ~limit znaków (urwane na końcu zdania)."""
    t = re.sub(r"[*_`#>|]", "", tekst or "")
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"\bkod (\d{4,8})\b", lambda m: "kod " + " ".join(m.group(1)), t)   # kod odbioru cyfra po cyfrze
    if len(t) > limit:
        cut = max(t.rfind(". ", 0, limit), t.rfind("! ", 0, limit), t.rfind("? ", 0, limit))
        t = t[:cut + 1] if cut > 100 else t[:limit] + "…"
    return t


def _pogoda_zdanie(jutro=False):
    """„Teraz X stopni, opis. Dziś od A do B, szansa opadów N procent.” (albo jutro). None = brak prognozy."""
    p = cache.get("pogoda", 900, pogoda)
    if not p.get("ok"):
        return None
    w = p["data"]
    dni = w.get("days") or []
    if jutro and len(dni) > 1:
        d = dni[1]
        odp = f"Jutro od {_stopnie(d['min'], True)} do {_stopnie(d['max'], True)}, {_pogoda_opis(d['code'])}"
        return odp + (f", szansa opadów {d['pp']} procent." if d.get("pp") else ".")
    odp = f"Teraz {_stopnie(w['temp'])}, {_pogoda_opis(w['code'])}."
    if dni:
        d = dni[0]
        odp += f" Dziś od {_stopnie(d['min'], True)} do {_stopnie(d['max'], True)}"
        odp += f", szansa opadów {d['pp']} procent." if d.get("pp") else "."
    return odp


def jarvis(tekst):
    src = (tekst or "").strip().strip(" .!?")
    t = _bez_ogonkow(src)
    if not t:
        raise ValueError("puste polecenie")

    # dzwoniący budzik / drzemka: „drzemka”, „jeszcze chwilę” / „wyłącz”, „stop”, „wstaję”
    with _budzik_lock:
        dzwoni, drz = BUDZIK["dzwoni"], BUDZIK["drzemka_do"]
    if dzwoni and re.search(r"\bdrzemk|\bjeszcze (?:chwil|troche|\d+|pare|kilka)", t):
        return {"odp": budzik_stop(drzemka=True)}
    if (dzwoni and re.search(r"\b(wylacz|stop|dosc|zatrzymaj|wstaje|wstalem|juz nie spie|cisza|dobra|ok)\b", t)) or \
       (drz and re.search(r"\b(wylacz|anuluj|zatrzymaj)\w*\s+(?:ten\s+)?(?:budzik|drzemk)", t)):
        return {"odp": (budzik_stop() or "Budzik wyłączony.") + " Dzień dobry!"}

    # trwa odliczanie „Dobranoc”: każde „anuluj / stop / nie / przerwij” je przerywa
    if dobranoc_trwa() and re.search(r"\b(anuluj|przerwij|stop|nie|zatrzymaj|czekaj)", t):
        dobranoc_anuluj()
        return {"odp": "Anulowane. Nic nie wyłączam.", "akcja": {"dobranoc_anuluj": True}}
    if re.search(r"\bdobranoc\b|\bdobrej nocy\b|\bide spac\b|\bidziemy spac\b", t):
        return dobranoc_start()

    # budziki
    if re.search(r"\b(anuluj|usun|odwolaj|skasuj|wylacz)\w*\s+(?:jutrzejsz\w*\s+|ten\s+|moj\w*\s+)?budzik", t):
        return {"odp": _budzik_anuluj_glos()}
    if re.search(r"\b(jakie|lista|pokaz)\w*\s+(?:mam\s+)?budzik|\bna (?:ktora|ile) (?:mam |jest )?(?:nastawion\w* )?budzik", t):
        return {"odp": _budziki_status()}
    if re.search(r"\bobudz\w*|\b(ustaw|nastaw|wlacz|dodaj)\w*\s+(?:mi\s+)?budzik|^budzik\b", t):
        return _budzik_glos(t)

    # minutniki i przypomnienia — NAJPIERW, bo tekst przypomnienia może zawierać inne komendy („…wyłączyć stanowisko”)
    if re.search(r"\b(anuluj|usun|odwolaj|skasuj|wylacz|zatrzymaj)\w*\s+(?:wszystkie\s+|ten\s+|to\s+)?(minutnik|timer|przypomnien)", t):
        return {"odp": _przyp_anuluj(t)}
    if re.search(r"\b(jakie|lista|pokaz)\w*\s+(?:mam\s+)?(?:minutnik|przypomnien)|\bile (?:jeszcze )?zostalo", t):
        return {"odp": _przyp_status()}
    if m := re.search(r"\bprzypomnij\w*\s+(?:mi\s+)?", t):
        return _przypomnij(src, t, m.end())
    if re.search(r"\b(ustaw|nastaw|wlacz|odpal|daj|odlicz)\w*\s+(?:mi\s+)?(minutnik|timer)|^(minutnik|timer|odlicz)", t):
        return _minutnik(t)

    # limity Claude („ile mam limitu w Claude”, „limit Claude”)
    if re.search(CLAUDE_GLOS, t) and re.search(r"\blimit|\bzuzy|\bile\b|\bwykorzyst", t):
        return {"odp": _claude_glos()}

    # ekran i zakładki
    if re.search(r"\b(wygas|zgas)\w*\s+ekran|\bwylacz\w*\s+ekran", t):
        return {"odp": "Wygaszam ekran.", "akcja": {"ekran": "sleep"}}
    if m := re.search(r"\b(nastepn|poprzedn)\w*\s+zakladk", t):
        return {"odp": "Już.", "akcja": {"zakladka_krok": 1 if m.group(1) == "nastepn" else -1}}
    if m := re.search(r"\b(pokaz|otworz|przejdz do|wlacz zakladke|idz do)\s+(.+)", t):
        for zid, wzor in ZAKLADKI_GLOS:
            if re.search(wzor, m.group(2)):
                return {"odp": "Już pokazuję.", "akcja": {"zakladka": zid}}

    # stanowisko przy biurku (gniazda z STANOWISKO, dziś monitor): włącz / wyłącz na żądanie
    if m := re.search(r"\b(wlacz|uruchom|odpal|wylacz|zgas)\w*\s+(?:cale\s+|moje\s+)?stanowisk", t):
        akcja = "off" if m.group(1) in ("wylacz", "zgas") else "on"
        for g in STANOWISKO:
            Z.gniazdo_ustaw(g, akcja)
        cache.drop("dash-gniazda")
        if akcja == "on":
            Z.pamiec_set("obecnosc_pauza_do", 0)   # ręczne włączenie zdejmuje pauzę kamery po „Dobranoc”
        return {"odp": "Wyłączam stanowisko." if akcja == "off" else "Włączam stanowisko."}

    # serwer i komputery (tylko włączanie = WoL; „obudź” zostaje jako stara forma)
    if re.search(r"\b(wlacz|uruchom|odpal|obudz)\w*\s+(serwer|server)", t):
        akcja_wake()
        return {"odp": "Włączam serwer. Będzie gotowy za minutę, dwie."}
    if m := re.search(r"\b(wlacz|uruchom|odpal|obudz)\w*\s+(komp\w*|gaming|pc|laptop)", t):
        laptop = m.group(2).startswith("laptop")
        pc = Z.pc_po_id("laptop" if laptop else "gaming")
        kto = "laptop" if laptop else "komputer"
        try:
            Z.agent(pc, "/api/health", timeout=1.5)
            return {"odp": f"{kto.capitalize()} już działa."}
        except Exception:  # noqa: BLE001 - nie odpowiada = wyłączony, budzimy
            pass
        if not pc["mac"]:
            return {"odp": f"Nie mam adresu MAC dla {pc['nazwa']}, nie włączę go zdalnie."}
        wol(pc["mac"])
        return {"odp": f"Włączam {kto}. Za chwilę powinien wstać."}

    # lista zadań
    if m := re.search(r"\b(dodaj|zapisz|zanotuj)\s+(?:mi\s+)?(?:zadanie|do listy|na liste|do zrobienia|przypomnienie)?\s*:?\s*(.+)", t):
        tytul = src[m.start(2):m.end(2)].strip()
        tytul = tytul[:1].upper() + tytul[1:]
        http_json(f"{TODO_URL}/api/todos", method="POST", body={"title": tytul})
        cache.drop("todo")
        return {"odp": f"Dodałem do listy: {tytul}."}

    # brief dnia na żądanie (liczy się też jako dzisiejszy — automat przy siadaniu już go nie powtórzy)
    if re.search(r"\bdzien dobry\b|\bbrief\b|\bco (mam |jest )?(dzis|dzisiaj)\b|\bplan na (dzis|dzisiaj)\b|"
                 r"\bpodsumuj\w* dzien|\bpodsumowanie dnia", t):
        _brief_oznacz_dzis()
        return {"odp": brief_tekst(), "mow_limit": BRIEF_ZNAKI}

    # pogoda i godzina
    if re.search(r"pogod|temperatur|ile stopni|czy (bedzie )?pada", t):
        return {"odp": _pogoda_zdanie(jutro="jutro" in t) or "Nie mam teraz prognozy pogody."}
    if re.search(r"\b(ktora|jaka) (jest )?godzin", t):
        return {"odp": f"Jest {_godzina()}."}

    # muzyka i głośność na komputerze
    if re.search(r"\b(glosniej|ciszej|wycisz|glosnosc)", t):
        pc = _pc_glos()
        if "wycisz" in t:
            _pc_cmd(pc, "audio/wycisz")
            return {"odp": "Wyciszam."}
        teraz_v = (pc.get("audio") or {}).get("glosnosc") or 0
        if m := re.search(r"glosnosc\D*(\d{1,3})", t):
            v = int(m.group(1))
        else:
            v = teraz_v + (10 if "glosniej" in t else -10)
        v = max(0, min(100, v))
        _pc_cmd(pc, "audio/glosnosc", {"wartosc": v})
        return {"odp": f"Głośność {v} procent."}
    if re.search(r"\b(pauza|zatrzymaj|wstrzymaj|stop)\b|\b(wznow|graj|pusc)", t):
        _pc_cmd(_pc_glos(), "media/toggle")
        return {"odp": "Wznawiam." if re.search(r"\b(wznow|graj|pusc)", t) else "Pauza."}
    if re.search(r"\b(nastepn|przewin|dalej)", t):
        _pc_cmd(_pc_glos(), "media/nastepny")
        return {"odp": "Następny utwór."}
    if re.search(r"\bpoprzedni", t):
        _pc_cmd(_pc_glos(), "media/poprzedni")
        return {"odp": "Poprzedni utwór."}

    # reszta: AI w n8n na serwerze
    if not serwer_up():
        return {"odp": "Serwer śpi, więc nie zapytam AI. Powiedz: włącz serwer, i spróbuj za dwie minuty."}
    url = N8N_CHAT or f"http://{SERVER_IP}:{N8N_PORT}/webhook/chat"
    _, d = http_json(url, method="POST", body={"prompt": src}, timeout=90)
    return {"odp": (d or {}).get("reply") or "Nie dostałem odpowiedzi od AI.", "ai": True}


def jarvis_api(tekst):
    try:
        w = jarvis(tekst)
    except Exception as e:  # noqa: BLE001  odpowiedź ma być zawsze do przeczytania
        w = {"odp": f"Nie udało się: {e}", "blad": True}
    w["mow"] = _do_mowy(w["odp"], w.pop("mow_limit", 500))
    return w


# --------------------------------------------------------------------------- zakładki
def dash():
    with stan_lock:
        panel = dict(PANEL)
    return {
        "now": teraz(),
        "config": {"wake_min": wake_min(), "ui": WERSJA_UI},
        "pogoda": cache.get("pogoda", 900, pogoda),
        "kuma": cache.get("kuma", 30, kuma),
        "serwer": cache.get("serwer", 10, serwer),
        "malinka": cache.get("malinka", 30, malinka),
        "todo": cache.get("todo", 20, todo),
        "pcs": cache.get("dash-pcs", 15, Z.pc_online),
        "gniazda": cache.get("dash-gniazda", 5, Z.gniazda_stan),
        "panel": panel,
    }


def _z_pamieci(klucz, pobierz, co_ile=600):
    """Kalendarz/Paperless są na serwerze: odświeżamy, gdy działa; gdy śpi — ostatni zapisany stan."""
    zapis = Z.pamiec_get(klucz)
    if serwer_up() and (not zapis or teraz() - zapis.get("ts", 0) > co_ile):
        w = cache.get(f"dzien-{klucz}", 60, pobierz)
        if w.get("ok") and w["data"] is not None:
            return {**w, "data": {**w["data"], "aktualne": True}}
        if not zapis:
            return w
        return {"ok": True, "data": {**zapis, "aktualne": False}, "error": w.get("error")}
    if zapis is None:
        return {"ok": True, "data": None}
    return {"ok": True, "data": {**zapis, "aktualne": serwer_up()}}


def tab_dzien():
    return {"kalendarz": _z_pamieci("kalendarz", Z.kalendarz_pobierz),
            "paperless": _z_pamieci("paperless", Z.paperless_pobierz),
            "poczta": _poczta(),
            "todo": cache.get("todo", 20, todo), "serwer": cache.get("serwer", 10, serwer),
            "budzik": (lambda a: _kiedy_opis(a[0][0]) if a else None)(_budzik_najblizszy())}


def tab_media():
    s = cache.get("serwer", 10, serwer)
    if not serwer_up():
        return {"serwer": s, "media": None}
    return {"serwer": s, "media": cache.get("media", 8, Z.media)}


def tab_serwery():
    with stan_lock:
        panel = dict(PANEL)
    return {"serwer": cache.get("serwer", 10, serwer),
            "glances": cache.get("glances", 5, Z.glances) if serwer_up() else None,
            "malinka": cache.get("malinka-pelna", 10, malinka),
            "kuma": cache.get("kuma", 30, kuma), "panel": panel,
            "docker": cache.get("docker", 8, docker_wszystko)}


TABS = {
    "dzien": tab_dzien,
    "pc": lambda: {"pcs": _tab_pc()},
    "procesy": lambda: {"pcs": cache.get("procesy", 2, _procesy)},
    # Muzyka i Discord w jednej zakładce (2026-11-20), żeby zrobić miejsce na Claude
    "muzyka": lambda: {"pcs": cache.get("muzyka", 2, lambda: Z.pc_stan(("media", "audio"))),
                       "pcs_dc": cache.get("pc-discord", 3, Z.pc_discord), "discord": dict(Z.DISCORD)},
    "claude": tab_claude,
    "media": tab_media,
    "serwery": tab_serwery,
    "siec": lambda: {"zte": cache.get("zte", 15, Z.zte), "adguard": cache.get("adguard", 60, Z.adguard),
                     "speedtest": Z.pamiec_get("speedtest"), "urzadzenia": _urzadzenia_lista()},
    "trening": lambda: {"trening": cache.get("tab-trening", 60, Z.trening)},
    "swiatlo": lambda: {"wled": cache.get("wled", 3, Z.wled)},
    # widoki szczegółowe otwierane z Przeglądu i Serwerów (nie mają własnej ikony na pasku)
    "pogoda": lambda: {"pogoda": cache.get("pogoda-szczegoly", 900, pogoda_szczegoly)},
    "docker": lambda: {"docker": cache.get("docker", 8, docker_wszystko)},
    "budziki": budziki_lista,
}


# --------------------------------------------------------------------------- HTTP
TYPY = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json"}


class H(BaseHTTPRequestHandler):
    server_version = "jarvis-panel/2.0"

    def log_message(self, fmt, *args):  # ciszej w `docker logs` — tylko błędy
        if len(args) > 1 and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def odpowiedz(self, kod, obj=None, typ="application/json; charset=utf-8", body=None, cache_s=0):
        if body is None:
            body = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(kod)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"max-age={cache_s}" if cache_s else "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def blad(self, kod, msg):
        self.odpowiedz(kod, {"error": msg})

    def cialo(self):
        if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
            raise PermissionError("wymagany Content-Type: application/json")
        if PANEL_TOKEN and not hmac.compare_digest(self.headers.get("X-Panel-Token") or "", PANEL_TOKEN):
            raise LookupError("zły albo brak X-Panel-Token")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 65536:
            raise ValueError("za duże żądanie")
        d = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(d, dict):
            raise ValueError("oczekiwano obiektu JSON")
        return d

    def sciezka(self):
        return urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"

    def obsluz(self, fn):
        try:
            fn()
        except PermissionError as e:
            self.blad(415, str(e))
        except LookupError as e:
            self.blad(401, str(e))
        except (ValueError, json.JSONDecodeError) as e:
            self.blad(400, str(e))
        except urllib.error.HTTPError as e:
            try:
                tresc = json.loads(e.read() or b"{}").get("error")
            except Exception:  # noqa: BLE001
                tresc = None
            # 4xx z usług (np. puste zadanie, agent: zła akcja) oddajemy jak jest, reszta = 502
            self.blad(e.code if 400 <= e.code < 500 else 502, tresc or f"usługa odpowiedziała {e.code}")
        except (urllib.error.URLError, OSError, subprocess.TimeoutExpired) as e:
            self.blad(502, f"{type(e).__name__}: {e}")
        except RuntimeError as e:  # np. ssh do serwera się nie udał
            self.blad(502, str(e))
        except Exception as e:  # noqa: BLE001
            self.blad(500, f"{type(e).__name__}: {e}")

    # ---------- SSE ----------
    def _sse(self, typ, dane=None):
        self.wfile.write(f"event: {typ}\ndata: {json.dumps(dane, ensure_ascii=False)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _strumien(self):
        """Długo żyjące połączenie: telefon dostaje zmiany ekranu/alertów od razu, bez odpytywania co 3 s.
        'ping' co 15 s pozwala telefonowi wykryć martwe połączenie (Wi-Fi w uśpieniu) i połączyć się od nowa."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        q = szyna.dolacz()
        try:
            self._sse("ekran", stan_ekranu())  # od razu aktualny stan
            while True:
                try:
                    typ, dane = q.get(timeout=15)
                except queue.Empty:
                    typ, dane = "ping", int(teraz())
                self._sse(typ, dane)
        except OSError:  # telefon się rozłączył
            pass
        finally:
            szyna.odlacz(q)

    # ---------- GET ----------
    def do_GET(self):
        self.obsluz(self._get)

    do_HEAD = do_GET

    def _get(self):
        sc = self.sciezka()
        if sc == "/api/health":
            return self.odpowiedz(200, {"ok": True})
        if sc == "/api/dash":
            return self.odpowiedz(200, dash())
        if sc == "/api/siec/speedtest":   # tylko odczyt ostatniego wyniku; sam pomiar to POST
            w = Z.pamiec_get("speedtest") or {}
            return self.odpowiedz(200, {**w, "ts_ms": int(w["ts"] * 1000) if w.get("ts") else None})
        if m := re.fullmatch(r"/api/tab/(\w+)", sc):
            fn = TABS.get(m.group(1))
            if not fn:
                return self.blad(404, "nie ma takiej zakładki")
            return self.odpowiedz(200, {"now": teraz(), **fn()})
        if sc in ("/api/screen", "/api/state"):
            return self.odpowiedz(200, stan_ekranu())
        if sc == "/api/stream":
            return self._strumien()
        if m := re.fullmatch(r"/api/pc/([\w-]+)/okladka/([0-9A-Fa-f]{1,64})", sc):
            dane, typ = Z.agent(Z.pc_po_id(m.group(1)), f"/api/media/okladka/{m.group(2)}", surowe=True, timeout=4)
            return self.odpowiedz(200, typ=typ, body=dane, cache_s=3600)
        if sc == "/":
            sc = "/index.html"
        plik = os.path.normpath(os.path.join(STATIC, sc.lstrip("/")))
        if plik.startswith(STATIC + os.sep) and os.path.isfile(plik):
            with open(plik, "rb") as f:
                return self.odpowiedz(200, typ=TYPY.get(os.path.splitext(plik)[1], "application/octet-stream"),
                                      body=f.read())
        self.blad(404, "nie ma")

    # ---------- POST ----------
    def do_POST(self):
        self.obsluz(self._post)

    def _post(self):
        sc = self.sciezka()
        b = self.cialo()
        if sc == "/api/screen":
            return self.odpowiedz(200, ustaw_ekran(b.get("mode"), b.get("minutes")))
        if sc == "/api/alert":
            return self.odpowiedz(200, ustaw_alert(b.get("text"), b.get("level", "info"), b.get("minutes")))
        if sc == "/api/alert/clear":
            return self.odpowiedz(200, wyczysc_alert())
        if sc == "/api/heartbeat":
            heartbeat(b)
            return self.odpowiedz(204)
        if m := re.fullmatch(r"/api/(?:action|serwer)/(\w+)", sc):
            fn = AKCJE.get(m.group(1))
            if not fn:
                return self.blad(404, "nie ma takiej akcji")
            return self.odpowiedz(200, {"ok": True, **fn()})
        if m := re.fullmatch(r"/api/pc/([\w-]+)/(.+)", sc):
            pc = Z.pc_po_id(m.group(1))
            if m.group(2) == "wol":
                wol(pc["mac"])
                return self.odpowiedz(200, {"ok": True, "msg": f"Wysłano WoL do {pc['nazwa']}"})
            if not POLECENIA_PC.fullmatch(m.group(2)):
                return self.blad(404, "nie ma takiego polecenia")
            d = Z.agent(pc, f"/api/{m.group(2)}", method="POST", body=b, timeout=90 if m.group(2) == "speedtest" else 6)
            cache.drop("pc", "muzyka")
            return self.odpowiedz(200, d if isinstance(d, dict) else {"ok": True})
        if sc == "/api/discord":
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self.blad(403, "tylko bot na malince")
            Z.discord_zapisz(b)
            szyna.publikuj("discord")
            return self.odpowiedz(204)
        if m := re.fullmatch(r"/api/docker/([\w-]+)/([\w.-]+)/(logi|restart)", sc):
            return self.odpowiedz(200, docker_akcja(m.group(1), m.group(2), m.group(3), b))
        if m := re.fullmatch(r"/api/media/qbit/(\w+)/(start|stop)", sc):
            Z.qbit_akcja(m.group(1), m.group(2))
            cache.drop("media")
            return self.odpowiedz(200, {"ok": True})
        if sc == "/api/siec/speedtest":
            return self.odpowiedz(200, {"ok": True, **Z.speedtest()})
        if sc == "/api/claude-limity/odswiez":
            d = claude_pobierz(60) or {}
            if d.get("disabled"):
                return self.blad(409, "malinka nie jest zalogowana do Claude")
            swieze = teraz() - (d.get("ts") or 0) < 90
            return self.odpowiedz(200, {"ok": True, "msg": "Limity odświeżone" if swieze else
                                        (d.get("blad") or "Odświeżane najwyżej raz na minutę")})
        if sc == "/api/budzik":
            g = str(b.get("godzina") or "")
            m = re.fullmatch(r"\s*(\d{1,2})[:.](\d{2})\s*", g) or re.fullmatch(r"\s*(\d{1,2})()\s*", g)
            if not m:
                raise ValueError("godzina: np. 6:30")
            nb = budzik_dodaj(int(m.group(1)), int(m.group(2) or 0), b.get("dni"), zrodlo=b.get("zrodlo") or "API")
            kiedy = _kiedy_opis(nb["ts"]) if nb.get("ts") else f"{_budzik_dni_opis(nb['dni'])} o {nb['h']}:{nb['m']:02d}"
            return self.odpowiedz(200, {"ok": True, "msg": f"Budzik {kiedy}", "budzik": nb})
        if m := re.fullmatch(r"/api/budzik/(stop|drzemka)", sc):
            return self.odpowiedz(200, {"ok": True, "msg": budzik_stop(drzemka=m.group(1) == "drzemka") or "Budzik nie dzwoni."})
        if m := re.fullmatch(r"/api/budzik/(\w+)/(wl|wyl|usun)", sc):
            return self.odpowiedz(200, budzik_akcja(m.group(1), m.group(2)))
        if m := re.fullmatch(r"/api/siec/urzadzenie/([0-9A-Fa-f:%-]{12,40})", sc):
            return self.odpowiedz(200, siec_urzadzenie(urllib.parse.unquote(m.group(1)), b))
        if sc == "/api/swiatlo":
            Z.wled_ustaw(b)
            cache.drop("wled")
            return self.odpowiedz(200, {"ok": True})
        if sc == "/api/jarvis":
            return self.odpowiedz(200, jarvis_api(b.get("tekst")))
        if m := re.fullmatch(r"/api/paczka/([\w:.@+-]{1,200})/odebrana", sc):
            return self.odpowiedz(200, paczka_odebrana(m.group(1)))
        if sc == "/api/claude":
            return self.odpowiedz(200, claude_zdarzenie(b))
        if sc == "/api/dobranoc/anuluj":
            bylo = dobranoc_anuluj()
            return self.odpowiedz(200, {"ok": True, "msg": "Anulowane. Nic nie wyłączam." if bylo else "Nic nie trwało."})
        if sc == "/api/obecnosc":
            jest = b.get("twarz")
            obecnosc(jest)
            br = brief_auto() if jest is True else None
            if jest is True and not br and not _obecnosc_pauza():
                br = nowosci_przy_siadaniu()
            return self.odpowiedz(200, {"brief": br}) if br else self.odpowiedz(204)
        if m := re.fullmatch(r"/api/gniazdo/([\w-]+)/(on|off|toggle)", sc):
            w = Z.gniazdo_ustaw(m.group(1), m.group(2))
            cache.drop("dash-gniazda")
            return self.odpowiedz(200, w)
        if sc == "/api/todo":
            st, d = http_json(f"{TODO_URL}/api/todos", method="POST",
                              body={"title": b.get("title"), "due": b.get("due")})
            cache.drop("todo")
            return self.odpowiedz(st, d)
        self.blad(404, "nie ma")

    # ---------- PATCH ----------
    def do_PATCH(self):
        self.obsluz(self._patch)

    def _patch(self):
        m = re.fullmatch(r"/api/todo/(\d+)", self.sciezka())
        if not m:
            return self.blad(404, "nie ma")
        b = self.cialo()
        st, d = http_json(f"{TODO_URL}/api/todos/{m.group(1)}", method="PATCH",
                          body={k: v for k, v in b.items() if k in ("title", "due", "done")})
        cache.drop("todo")
        return self.odpowiedz(st, d)


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    print(f"jarvis-panel: port {PORT}, serwer {SERVER_IP or '(brak SERVER_IP)'}, "
          f"Kuma {'klucz' if KUMA_API_KEY else KUMA_STATUS_SLUG or 'nie'}, komputery {len(Z.lista_pc())}, "
          f"token {'tak' if PANEL_TOKEN else 'nie'}", flush=True)
    threading.Thread(target=straznik_obecnosci, daemon=True).start()
    threading.Thread(target=straznik_przypomnien, daemon=True).start()
    threading.Thread(target=probkowanie_pc, daemon=True).start()
    threading.Thread(target=zbieranie_mediow, daemon=True).start()
    threading.Thread(target=straznik_sieci, daemon=True).start()
    threading.Thread(target=straznik_budzika, daemon=True).start()
    threading.Thread(target=straznik_claude, daemon=True).start()
    threading.Thread(target=straznik_powiadomien_claude, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
