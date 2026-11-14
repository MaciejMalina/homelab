#!/usr/bin/env python3
"""JARVIS — panel na starym telefonie (malinka).

Strona (static/) + API, z którego ją zasilamy. Sama biblioteka standardowa, jak jarvis_todo.
Kontener chodzi w network_mode: host (WoL musi wyjść broadcastem do LAN-u), więc
todo/trener/Kuma/AdGuard są pod 127.0.0.1. Źródła danych zakładek: zrodla.py.

API (JSON):
  GET  /api/dash                       zakładka Przegląd
  GET  /api/tab/<nazwa>                dzien | pc | muzyka | discord | media | serwery | siec | trening | swiatlo
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
  SSE "przypomnienie" {"mow", "tekst"}    minutnik / przypomnienie głosowe (do tego alert budzi ekran)
  POST /api/swiatlo                    {"on"?, "bri"?, "kolor"?: [r,g,b], "ps"?}  -> WLED
  POST /api/todo, PATCH /api/todo/<id> -> jarvis_todo
  GET  /api/health

Zapisy wymagają Content-Type: application/json (ochrona przed CSRF), a jeśli ustawisz
PANEL_TOKEN, także nagłówka X-Panel-Token.
"""
import base64
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
    return {**s, "now": teraz(), "wake_min": wake_min()}


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
        if jest and OBECNOSC_GNIAZDO:
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


def _brief_kalendarz():
    k = _z_pamieci("kalendarz", Z.kalendarz_pobierz)
    d = (k.get("data") or {}) if k.get("ok") else {}
    n = _teraz_pl()
    godz, cale = [], []
    for w in d.get("wydarzenia") or []:
        start = Z.datetime.fromisoformat(w["start"]).astimezone(Z.TZ)
        if start.date() != n.date():
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
    p = cache.get("poczta", 30, Z.poczta)
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
    for fn in (_pogoda_zdanie, _brief_kalendarz, _brief_przypomnienia, _brief_poczta, _brief_trening, _brief_uslugi):
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
    if not BRIEF_AUTO or not BRIEF_OD <= _teraz_pl().hour < BRIEF_DO or not _brief_oznacz_dzis():
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


def _brief_przypomnienia():
    dzis = _teraz_pl().date()
    lista = [p for p in _przyp_lista() if p["typ"] == "przypomnienie"
             and Z.datetime.fromtimestamp(p["ts"], Z.TZ).date() == dzis]
    if not lista:
        return None
    return "Przypomnienia: " + ", ".join(f"{_kiedy_opis(p['ts'])} {p['tekst']}" for p in lista[:3]) + "."


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
                          r"|zasilanie/(uspij|wylacz|restart|zablokuj)|discord/(mikrofon|sluchawki|rozlacz)|speedtest")


# --------------------------------------------------------------------------- asystent głosowy: POST /api/jarvis {"tekst"}
# Telefon („Hey Jarvis” + rozpoznawanie mowy Google) przysyła tekst polecenia. Znane komendy wykonujemy od razu,
# resztę pytamy AI w n8n na serwerze (gdy działa). Celowo BEZ usypiania/wyłączania czegokolwiek — źle usłyszane
# słowo nie może położyć serwera ani komputera.
N8N_CHAT = E("N8N_CHAT", "")   # domyślnie http://SERVER_IP:N8N_PORT/webhook/chat
ZAKLADKI_GLOS = [("przeglad", r"przeglad|glown|start"), ("dzien", r"dzien|kalendarz|plan|mail|faktur"),
                 ("pc", r"komputer|\bpc\b"), ("muzyka", r"muzyk|piosenk|utwor"), ("discord", r"discord"),
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

    # minutniki i przypomnienia — NAJPIERW, bo tekst przypomnienia może zawierać inne komendy („…wyłączyć stanowisko”)
    if re.search(r"\b(anuluj|usun|odwolaj|skasuj|wylacz|zatrzymaj)\w*\s+(?:wszystkie\s+|ten\s+|to\s+)?(minutnik|timer|przypomnien)", t):
        return {"odp": _przyp_anuluj(t)}
    if re.search(r"\b(jakie|lista|pokaz)\w*\s+(?:mam\s+)?(?:minutnik|przypomnien)|\bile (?:jeszcze )?zostalo", t):
        return {"odp": _przyp_status()}
    if m := re.search(r"\bprzypomnij\w*\s+(?:mi\s+)?", t):
        return _przypomnij(src, t, m.end())
    if re.search(r"\b(ustaw|nastaw|wlacz|odpal|daj|odlicz)\w*\s+(?:mi\s+)?(minutnik|timer)|^(minutnik|timer|odlicz)", t):
        return _minutnik(t)

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
            "poczta": cache.get("poczta", 30, Z.poczta),
            "todo": cache.get("todo", 20, todo), "serwer": cache.get("serwer", 10, serwer)}


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
    "pc": lambda: {"pcs": cache.get("pc", 2, lambda: Z.pc_stan(("stan", "audio")))},
    "muzyka": lambda: {"pcs": cache.get("muzyka", 2, lambda: Z.pc_stan(("media", "audio")))},
    "discord": lambda: {"discord": dict(Z.DISCORD), "pcs": cache.get("pc-discord", 3, Z.pc_discord)},
    "media": tab_media,
    "serwery": tab_serwery,
    "siec": lambda: {"zte": cache.get("zte", 15, Z.zte), "adguard": cache.get("adguard", 60, Z.adguard),
                     "speedtest": Z.pamiec_get("speedtest")},
    "trening": lambda: {"trening": cache.get("tab-trening", 60, Z.trening)},
    "swiatlo": lambda: {"wled": cache.get("wled", 3, Z.wled)},
    # widoki szczegółowe otwierane z Przeglądu i Serwerów (nie mają własnej ikony na pasku)
    "pogoda": lambda: {"pogoda": cache.get("pogoda-szczegoly", 900, pogoda_szczegoly)},
    "docker": lambda: {"docker": cache.get("docker", 8, docker_wszystko)},
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
        if sc == "/api/swiatlo":
            Z.wled_ustaw(b)
            cache.drop("wled")
            return self.odpowiedz(200, {"ok": True})
        if sc == "/api/jarvis":
            return self.odpowiedz(200, jarvis_api(b.get("tekst")))
        if sc == "/api/obecnosc":
            jest = b.get("twarz")
            obecnosc(jest)
            br = brief_auto() if jest is True else None
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
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
