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
  POST /api/pc/<id>/<polecenie>        przekazane do agenta C# (audio/…, media/…, zasilanie/…, discord/…, speedtest)
  GET  /api/pc/<id>/okladka/<oid>      okładka z agenta
  POST /api/discord                    {"kanaly": [...]}  <- cog panel.py w bocie (tylko z 127.0.0.1)
  POST /api/media/qbit/<hash>/<start|stop>
  GET  /api/siec/speedtest        ostatni wynik (ts, ts_ms, ping, dol, gora) - dla kafelka w Homepage
POST /api/siec/speedtest
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
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import zrodla as Z

E = os.environ.get
PORT = int(E("PORT", "8084"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
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
        "latitude": LAT, "longitude": LON, "timezone": "Europe/Warsaw", "forecast_days": 3,
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
                             "stan": KUMA_STAN.get(st, "pending")})
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


def stan_ekranu():
    with stan_lock:
        s = dict(EKRAN)
    return {**s, "now": teraz(), "wake_min": WAKE_MIN}


def ustaw_ekran(mode, minutes=None):
    if mode not in ("on", "sleep", "auto"):
        raise ValueError("mode: on | sleep | auto")
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
    if KUMA_PUSH_PANEL and teraz() - _ostatni_push["ts"] > 55:
        _ostatni_push["ts"] = teraz()

        def push():
            try:
                urllib.request.urlopen(KUMA_PUSH_PANEL, timeout=HTTP_TIMEOUT).read()
            except Exception:  # noqa: BLE001
                pass
        threading.Thread(target=push, daemon=True).start()


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
                          r"|zasilanie/(uspij|wylacz|restart|zablokuj)|discord/(mikrofon|sluchawki)|speedtest")


# --------------------------------------------------------------------------- zakładki
def dash():
    with stan_lock:
        panel = dict(PANEL)
    return {
        "now": teraz(),
        "config": {"wake_min": WAKE_MIN},
        "pogoda": cache.get("pogoda", 900, pogoda),
        "kuma": cache.get("kuma", 30, kuma),
        "serwer": cache.get("serwer", 10, serwer),
        "malinka": cache.get("malinka", 30, malinka),
        "todo": cache.get("todo", 20, todo),
        "trening": cache.get("trening", 300, trening_brief),
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
    "discord": lambda: {"discord": dict(Z.DISCORD), "pcs": cache.get("pc-online", 10, lambda: Z.pc_stan(("health",)))},
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
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
