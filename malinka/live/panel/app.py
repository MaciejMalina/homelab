#!/usr/bin/env python3
"""JARVIS — panel na starym telefonie (malinka).

Strona (static/index.html) + małe API, z którego ją zasilamy. Sama biblioteka
standardowa, jak jarvis_todo. Kontener chodzi w network_mode: host (WoL musi
wyjść broadcastem do LAN-u), więc todo/trener/Kuma są pod 127.0.0.1.

API (JSON):
  GET  /api/dash               wszystko do wyświetlenia (cache po stronie serwera)
  GET  /api/screen             stan ekranu: {ver, mode, until, alert, now} — telefon pyta co 3 s
  POST /api/screen             {"mode": "on"|"sleep"|"auto", "minutes"?: N}   <- JARVIS / bot / n8n
  POST /api/alert              {"text", "level"?: info|warn|crit, "minutes"?: N}  budzi ekran + baner
  POST /api/alert/clear
  POST /api/heartbeat          {"battery": {...}, "sleeping": bool}           <- telefon co 60 s
  POST /api/action/wake        WoL do serwera
  POST /api/action/sleep       poweroff przez jpower (forced command jarvis-power-agent.sh)
  POST /api/action/sync        synchronizacja treningów (trener /api/sync)
  POST /api/todo               {"title", "due"?}  -> jarvis_todo
  PATCH /api/todo/<id>         {"done"?, ...}     -> jarvis_todo
  GET  /api/health

Zapisy wymagają Content-Type: application/json (jak w jarvis_todo — ochrona przed
CSRF), a jeśli ustawisz PANEL_TOKEN, także nagłówka X-Panel-Token.
"""
import base64
import hmac
import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

E = os.environ.get
PORT = int(E("PORT", "8084"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
DATA_DIR = E("DATA_DIR", "/data")

TODO_URL = E("TODO_URL", "http://127.0.0.1:8083").rstrip("/")
TRENER_URL = E("TRENER_URL", "http://127.0.0.1:8082").rstrip("/")
KUMA_URL = E("KUMA_URL", "http://127.0.0.1:3001").rstrip("/")
KUMA_API_KEY = E("KUMA_API_KEY", "")
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

    def drop(self, key):
        with self.lock:
            self.d.pop(key, None)


cache = Cache()


# --------------------------------------------------------------------------- źródła danych
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


ETYKIETA_RE = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')
METRYKA_RE = re.compile(r"^monitor_status\{(.*)\}\s+(\S+)$")


def kuma():
    if not KUMA_API_KEY:
        return {"disabled": True}
    auth = base64.b64encode(f":{KUMA_API_KEY}".encode()).decode()
    req = urllib.request.Request(f"{KUMA_URL}/metrics", headers={"Authorization": f"Basic {auth}"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        tekst = r.read().decode("utf-8", "replace")
    up, down, pending, maint = [], [], [], []
    for linia in tekst.splitlines():
        m = METRYKA_RE.match(linia.strip())
        if not m:
            continue
        et = dict(ETYKIETA_RE.findall(m.group(1)))
        nazwa = et.get("monitor_name", "?").replace('\\"', '"')
        try:
            st = int(float(m.group(2)))
        except ValueError:
            continue
        # Uptime Kuma: 1 = UP, 0 = DOWN, 2 = PENDING, 3 = MAINTENANCE
        {1: up, 0: down, 2: pending, 3: maint}.get(st, pending).append(nazwa)
    return {"total": len(up) + len(down) + len(pending) + len(maint), "up": len(up),
            "down": sorted(down), "pending": sorted(pending), "maintenance": len(maint)}


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
    except (OSError, KeyError, ValueError, ZeroDivisionError):
        pass
    return out


def todo():
    _, d = http_json(f"{TODO_URL}/api/todos?open=1")
    return {"tasks": (d or {}).get("tasks", [])}


def trening():
    _, d = http_json(f"{TRENER_URL}/api/brief", timeout=10)
    return {"lines": (d or {}).get("lines", [])}


# --------------------------------------------------------------------------- ekran / alerty / telefon
stan_lock = threading.Lock()
EKRAN = {"ver": 1, "mode": "auto", "until": 0, "alert": None}
PANEL = {"ts": None, "battery": None, "sleeping": None}
_ostatni_push = {"ts": 0.0}


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
        return dict(EKRAN)


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
        return dict(EKRAN)


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
def akcja_wake():
    if not SERVER_MAC:
        raise ValueError("brak SERVER_MAC w .env")
    mac = bytes.fromhex(re.sub(r"[^0-9a-fA-F]", "", SERVER_MAC))
    if len(mac) != 6:
        raise ValueError("SERVER_MAC: zły format")
    pakiet = b"\xff" * 6 + mac * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for port in (9, 7):
            s.sendto(pakiet, (WOL_BROADCAST, port))
    _budzenie["ts"] = teraz()
    cache.drop("serwer")
    return {"msg": "Wysłano WoL — serwer wstaje (zwykle 1–3 min)"}


def akcja_sleep():
    if not SERVER_IP:
        raise ValueError("brak SERVER_IP w .env")
    if not os.path.exists(SSH_KEY):
        raise ValueError(f"brak klucza SSH {SSH_KEY} (zamontuj klucz bota z ssh_keys/)")
    cmd = ["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
           "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
           f"{SSH_USER}@{SERVER_IP}", "poweroff"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
    err = (r.stderr or "").strip()
    # przy poweroff serwer potrafi zerwać połączenie zanim ssh dostanie kod wyjścia (255)
    zerwane = r.returncode == 255 and re.search(r"closed by remote host|Connection reset|closed\.?$", err)
    if r.returncode != 0 and not zerwane:
        raise RuntimeError(err.splitlines()[-1] if err else f"ssh: kod {r.returncode}")
    cache.drop("serwer")
    return {"msg": "Serwer się wyłącza"}


def akcja_sync():
    st, d = http_json(f"{TRENER_URL}/api/sync", method="POST", body={}, timeout=120)
    cache.drop("trening")
    d = d or {}
    return {"msg": f"Treningi: nowe {d.get('nowe', 0)}, zaktualizowane {d.get('zaktualizowane', 0)}"
                   + (f", błędy {len(d.get('bledy') or [])}" if d.get("bledy") else "")}


AKCJE = {"wake": akcja_wake, "sleep": akcja_sleep, "sync": akcja_sync}


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
        "trening": cache.get("trening", 300, trening),
        "panel": panel,
    }


# --------------------------------------------------------------------------- HTTP
TYPY = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json"}


class H(BaseHTTPRequestHandler):
    server_version = "jarvis-panel/1.0"

    def log_message(self, fmt, *args):  # ciszej w `docker logs` — tylko błędy
        if len(args) > 1 and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def odpowiedz(self, kod, obj=None, typ="application/json; charset=utf-8", body=None):
        if body is None:
            body = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(kod)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
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
        if n > 16384:
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
            # 4xx z jarvis_todo/trenera (np. puste zadanie) oddajemy jak jest, reszta = 502
            self.blad(e.code if 400 <= e.code < 500 else 502, tresc or f"usługa odpowiedziała {e.code}")
        except (urllib.error.URLError, OSError, subprocess.TimeoutExpired) as e:
            self.blad(502, f"{type(e).__name__}: {e}")
        except RuntimeError as e:  # np. ssh do serwera się nie udał
            self.blad(502, str(e))
        except Exception as e:  # noqa: BLE001
            self.blad(500, f"{type(e).__name__}: {e}")

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
        if sc in ("/api/screen", "/api/state"):
            with stan_lock:
                s = dict(EKRAN)
            return self.odpowiedz(200, {**s, "now": teraz(), "wake_min": WAKE_MIN})
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
        if m := re.fullmatch(r"/api/action/(\w+)", sc):
            fn = AKCJE.get(m.group(1))
            if not fn:
                return self.blad(404, "nie ma takiej akcji")
            return self.odpowiedz(200, {"ok": True, **fn()})
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
          f"Kuma {'tak' if KUMA_API_KEY else 'nie'}, token {'tak' if PANEL_TOKEN else 'nie'}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
