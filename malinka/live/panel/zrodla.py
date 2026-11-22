"""JARVIS panel — źródła danych dla zakładek (sama biblioteka standardowa).

Wszystko, co stoi na serwerze (media, Glances, Paperless, kalendarz), pytamy po LAN-ie
(192.168.254.11): idle-shutdown.sh ignoruje połączenia z 192.168.254.10 (malinka), więc
panel nie trzyma serwera przy życiu. Po IP Tailscale pytać NIE wolno — to by go budziło na stałe.
"""
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import socket
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

E = os.environ.get
TZ = ZoneInfo("Europe/Warsaw")
DATA_DIR = E("DATA_DIR", "/data")
HTTP_TIMEOUT = 6
pula = ThreadPoolExecutor(max_workers=8)


# --------------------------------------------------------------------------- HTTP
def zadanie(url, method="GET", body=None, headers=None, timeout=HTTP_TIMEOUT, opener=None, form=False, surowe=False):
    """JSON (albo bajty przy surowe=True). body: dict -> JSON, albo form-urlencoded gdy form=True."""
    h = {"Accept": "application/json", **(headers or {})}
    data = None
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        elif isinstance(body, (bytes, str)):
            data = body.encode() if isinstance(body, str) else body
        else:
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with (opener.open(req, timeout=timeout) if opener else urllib.request.urlopen(req, timeout=timeout)) as r:
        raw = r.read()
        if surowe:
            return raw, r.headers.get("Content-Type", "application/octet-stream")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw.decode("utf-8", "replace")


def basic(user, haslo):
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{haslo}".encode()).decode()}


def rownolegle(zadania):
    """{klucz: funkcja} -> {klucz: {"ok", "data"|"error"}} — wszystko naraz, błąd jednego nie psuje reszty."""
    fut = {k: pula.submit(f) for k, f in zadania.items()}
    out = {}
    for k, f in fut.items():
        try:
            out[k] = {"ok": True, "data": f.result()}
        except Exception as e:  # noqa: BLE001
            out[k] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    return out


# --------------------------------------------------------------------------- pamięć na dysku
_pam_lock = threading.Lock()
_PAM = os.path.join(DATA_DIR, "pamiec.json")


def pamiec_get(klucz, domyslnie=None):
    with _pam_lock:
        try:
            with open(_PAM, encoding="utf-8") as f:
                return json.load(f).get(klucz, domyslnie)
        except (FileNotFoundError, json.JSONDecodeError):
            return domyslnie


def pamiec_set(klucz, wartosc):
    with _pam_lock:
        try:
            with open(_PAM, encoding="utf-8") as f:
                d = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            d = {}
        d[klucz] = wartosc
        os.makedirs(DATA_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=".pam-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        os.replace(tmp, _PAM)


# --------------------------------------------------------------------------- komputery z agentem (C#)
AGENT_TOKEN = E("AGENT_TOKEN", "")


def lista_pc():
    """PCS=gaming|http://192.168.254.73:8765|AA:BB:CC:DD:EE:FF;laptop|http://100.x.y.z:8765|"""
    out = []
    for wpis in (E("PCS", "") or "").split(";"):
        cz = [c.strip() for c in wpis.split("|")]
        if len(cz) >= 2 and cz[0] and cz[1]:
            pid = re.sub(r"[^a-z0-9]+", "-", cz[0].lower()).strip("-")
            out.append({"id": pid, "nazwa": cz[0], "url": cz[1].rstrip("/"), "mac": cz[2] if len(cz) > 2 else ""})
    return out


def pc_po_id(pid):
    for p in lista_pc():
        if p["id"] == pid:
            return p
    raise ValueError(f"nie ma komputera {pid}")


def agent(pc, sciezka, method="GET", body=None, timeout=2.5, surowe=False):
    return zadanie(pc["url"] + sciezka, method=method, body=body, timeout=timeout, surowe=surowe,
                   headers={"X-Agent-Token": AGENT_TOKEN})


def pc_stan(czesci=("stan", "audio")):
    """Dla każdego komputera: online + wybrane części (/api/stan, /api/audio, /api/media)."""
    pcs = lista_pc()

    def jeden(pc):
        wynik = {"id": pc["id"], "nazwa": pc["nazwa"], "wol": bool(pc["mac"])}
        try:
            for c in czesci:
                wynik[c] = agent(pc, f"/api/{c}")
            wynik["online"] = True
        except Exception as e:  # noqa: BLE001
            wynik["online"] = False
            wynik["error"] = f"{type(e).__name__}: {e}"[:200]
        return wynik

    return list(pula.map(jeden, pcs)) if pcs else []


def pc_online():
    """Przegląd: tylko czy agent odpowiada (lekki /api/health) + czy da się obudzić (MAC w PCS)."""
    def jeden(pc):
        wynik = {"id": pc["id"], "nazwa": pc["nazwa"], "wol": bool(pc["mac"])}
        try:
            agent(pc, "/api/health", timeout=1.5)
            wynik["online"] = True
        except Exception:  # noqa: BLE001
            wynik["online"] = False
        return wynik

    pcs = lista_pc()
    return list(pula.map(jeden, pcs)) if pcs else []


def pc_discord():
    """Dla każdego komputera: online (health) + stan Discord RPC z agenta (None, gdy RPC wyłączony lub agent starszy)."""
    def jeden(pc):
        wynik = {"id": pc["id"], "nazwa": pc["nazwa"], "wol": bool(pc["mac"])}
        try:
            wynik["health"] = agent(pc, "/api/health")
            wynik["online"] = True
        except Exception as e:  # noqa: BLE001
            wynik["online"] = False
            wynik["error"] = f"{type(e).__name__}: {e}"[:200]
            return wynik
        try:
            wynik["discord"] = agent(pc, "/api/discord/stan")
        except Exception:  # noqa: BLE001
            wynik["discord"] = None
        return wynik

    pcs = lista_pc()
    return list(pula.map(jeden, pcs)) if pcs else []


# --------------------------------------------------------------------------- Discord (stan wypychany przez bota)
DISCORD = {"ts": None, "kanaly": []}


def discord_zapisz(b):
    kanaly = b.get("kanaly")
    if not isinstance(kanaly, list):
        raise ValueError("kanaly: lista")
    DISCORD.update(ts=time.time(), kanaly=kanaly[:20])


# --------------------------------------------------------------------------- Docker (przez docker-socket-proxy)
# DOCKER_HOSTS="malinka|http://127.0.0.1:2375|rw;serwer|http://192.168.254.11:2375|ro"
#   nazwa|adres proxy|rw (wolno restartować) albo ro (tylko lista i logi; domyślnie ro)
# Nigdy nie montujemy gniazda Dockera do panelu — rozmawiamy tylko z proxy, które przepuszcza wąski zestaw wywołań.
DOCKER_NIE_RESTARTUJ = {x.strip() for x in E("DOCKER_NIE_RESTARTUJ", "jarvis_panel,jarvis_docker_proxy").split(",") if x.strip()}
DOCKER_IGNORUJ = {x.strip() for x in E("DOCKER_IGNORUJ", "").split(",") if x.strip()}  # np. kontener, o którym wiesz, że jest unhealthy
NAZWA_KONT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def docker_hosty():
    out = []
    for el in E("DOCKER_HOSTS", "").split(";"):
        c = [x.strip() for x in el.split("|")]
        if len(c) >= 2 and c[0] and c[1]:
            out.append({"id": re.sub(r"[^\w-]", "", c[0].lower()) or "host", "nazwa": c[0], "url": c[1].rstrip("/"),
                        "rw": len(c) > 2 and c[2].lower() == "rw"})
    return out


def docker_host(hid):
    for h in docker_hosty():
        if h["id"] == hid:
            return h
    raise ValueError("nie ma takiego hosta Dockera (DOCKER_HOSTS)")


def _nazwa_kontenera(nazwa):
    if not NAZWA_KONT_RE.fullmatch(nazwa or ""):
        raise ValueError("zła nazwa kontenera")
    return urllib.parse.quote(nazwa)


def docker_lista(h):
    lista = zadanie(f"{h['url']}/containers/json?all=1", timeout=3)
    out = []
    for c in lista or []:
        nazwa = ((c.get("Names") or ["?"])[0]).lstrip("/")
        status = c.get("Status") or ""
        zdr = ("unhealthy" if "unhealthy" in status else "healthy" if "healthy" in status
               else "starting" if "health: starting" in status else None)
        stan = c.get("State") or "?"
        ok = (stan == "running" and zdr != "unhealthy") or nazwa in DOCKER_IGNORUJ
        out.append({"nazwa": nazwa, "obraz": (c.get("Image") or "").split("@")[0][-48:], "stan": stan, "status": status,
                    "zdrowie": zdr, "ok": ok, "restart": h["rw"] and nazwa not in DOCKER_NIE_RESTARTUJ})
    out.sort(key=lambda x: (x["ok"], x["nazwa"].lower()))  # najpierw te, z którymi jest problem
    return out


def _rozpakuj_strumien(raw, tail):
    """Logi kontenera bez TTY przychodzą w ramkach [typ,0,0,0,rozmiar(4B BE)]+dane; z TTY — surowy tekst."""
    if len(raw) >= 8 and raw[0] in (0, 1, 2) and raw[1:4] == b"\0\0\0":
        kawalki, i = [], 0
        while i + 8 <= len(raw):
            dl = int.from_bytes(raw[i + 4:i + 8], "big")
            kawalki.append(raw[i + 8:i + 8 + dl])
            i += 8 + dl
        raw = b"".join(kawalki)
    tekst = ANSI_RE.sub("", raw.decode("utf-8", "replace"))
    linie = [l[:400] for l in tekst.splitlines()[-tail:]]
    return "\n".join(linie)[-20000:]


def docker_logi(h, nazwa, tail=80):
    n = _nazwa_kontenera(nazwa)
    tail = max(10, min(int(tail or 80), 300))
    raw, _ = zadanie(f"{h['url']}/containers/{n}/logs?stdout=1&stderr=1&tail={tail}", timeout=6, surowe=True)
    return _rozpakuj_strumien(raw, tail)


def docker_restart(h, nazwa):
    n = _nazwa_kontenera(nazwa)
    if not h["rw"]:
        raise ValueError(f"{h['nazwa']}: tylko podgląd — restart wyłączony (w DOCKER_HOSTS jest ro)")
    if nazwa in DOCKER_NIE_RESTARTUJ:
        raise ValueError(f"{nazwa}: tego kontenera panel nie restartuje (DOCKER_NIE_RESTARTUJ)")
    try:
        zadanie(f"{h['url']}/containers/{n}/restart?t=10", method="POST", timeout=40)
    except urllib.error.HTTPError as e:
        if e.code == 403:
            raise RuntimeError("proxy Dockera odmówiło restartu (włącz w nim ALLOW_RESTARTS=1)") from e
        raise


# --------------------------------------------------------------------------- serwer: Glances
GLANCES_URL = E("GLANCES_URL", "").rstrip("/")


def glances():
    if not GLANCES_URL:
        return {"disabled": True}
    g = lambda s: zadanie(f"{GLANCES_URL}/api/4/{s}", timeout=4)  # noqa: E731
    r = rownolegle({k: (lambda k=k: g(k)) for k in ("quicklook", "mem", "load", "sensors", "fs", "gpu", "containers", "uptime")})
    d = {k: (v["data"] if v["ok"] else None) for k, v in r.items()}
    ql, mem, load = d["quicklook"] or {}, d["mem"] or {}, d["load"] or {}
    temps = [s for s in (d["sensors"] or []) if isinstance(s, dict) and s.get("type") == "temperature_core"]
    cpu_temp = max((s.get("value") or 0 for s in temps), default=None) if temps else None
    dyski = [{"mnt": f.get("mnt_point"), "proc": f.get("percent"), "uzyte": f.get("used"), "razem": f.get("size")}
             for f in (d["fs"] or []) if isinstance(f, dict) and not str(f.get("mnt_point", "")).startswith(("/boot", "/snap"))]
    gpu = [{"nazwa": x.get("name"), "proc": x.get("proc"), "mem": x.get("mem"), "temp": x.get("temperature")}
           for x in (d["gpu"] or []) if isinstance(x, dict)]
    kont = []
    for c in d["containers"] or []:
        if not isinstance(c, dict):
            continue
        cpu = c.get("cpu_percent")
        if cpu is None and isinstance(c.get("cpu"), dict):
            cpu = c["cpu"].get("total")
        ram = c.get("memory_usage")
        if ram is None and isinstance(c.get("memory"), dict):
            ram = c["memory"].get("usage")
        kont.append({"nazwa": c.get("name"), "status": c.get("status"), "cpu": cpu, "ram": ram})
    kont.sort(key=lambda c: (str(c["status"]).lower() not in ("running", "healthy"), str(c["nazwa"])))
    return {"cpu": ql.get("cpu"), "cpu_nazwa": ql.get("cpu_name"), "ram": mem.get("percent"), "ram_razem": mem.get("total"),
            "load": load.get("min1"), "rdzenie": load.get("cpucore"), "cpu_temp": cpu_temp, "dyski": dyski, "gpu": gpu,
            "kontenery": kont, "uptime": d["uptime"] if isinstance(d["uptime"], str) else None}


# --------------------------------------------------------------------------- media: qBittorrent / Sonarr / Radarr / Jellyfin
QBIT_URL, QBIT_USER, QBIT_PASS = E("QBIT_URL", "").rstrip("/"), E("QBIT_USER", ""), E("QBIT_PASS", "")
SONARR_URL, SONARR_KEY = E("SONARR_URL", "").rstrip("/"), E("SONARR_KEY", "")
RADARR_URL, RADARR_KEY = E("RADARR_URL", "").rstrip("/"), E("RADARR_KEY", "")
JELLYFIN_URL, JELLYFIN_KEY = E("JELLYFIN_URL", "").rstrip("/"), E("JELLYFIN_KEY", "")

_qbit = {"jar": http.cookiejar.CookieJar()}
_qbit["op"] = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_qbit["jar"]))
_qbit_lock = threading.Lock()


def qbit_req(sciezka, method="GET", body=None):
    def raz():
        return zadanie(QBIT_URL + sciezka, method=method, body=body, form=body is not None, opener=_qbit["op"],
                       headers={"Referer": QBIT_URL + "/"})
    with _qbit_lock:
        try:
            return raz()
        except urllib.error.HTTPError as e:
            if e.code not in (401, 403) or not QBIT_USER:
                raise
            odp = zadanie(QBIT_URL + "/api/v2/auth/login", method="POST", form=True, opener=_qbit["op"],
                          body={"username": QBIT_USER, "password": QBIT_PASS}, headers={"Referer": QBIT_URL + "/"})
            if str(odp).strip() == "Fails.":   # nowsze qBittorrenty odpowiadają 204 bez treści
                raise RuntimeError("qBittorrent: złe logowanie") from None
            return raz()


STANY_QBIT = {"downloading": "pobiera", "forcedDL": "pobiera", "metaDL": "metadane", "stalledDL": "czeka",
              "queuedDL": "w kolejce", "uploading": "wysyła", "forcedUP": "wysyła", "stalledUP": "gotowe",
              "pausedDL": "pauza", "pausedUP": "gotowe", "stoppedDL": "pauza", "stoppedUP": "gotowe",
              "checkingDL": "sprawdza", "checkingUP": "sprawdza", "error": "błąd", "missingFiles": "brak plików",
              "moving": "przenosi", "queuedUP": "gotowe", "checkingResumeData": "sprawdza"}


def qbit():
    if not QBIT_URL:
        return {"disabled": True}
    lista = qbit_req("/api/v2/torrents/info?sort=added_on&reverse=true&limit=15") or []
    tr = qbit_req("/api/v2/transfer/info") or {}
    return {"dl": tr.get("dl_info_speed"), "ul": tr.get("up_info_speed"),
            "torrenty": [{"hash": t.get("hash"), "nazwa": t.get("name"), "postep": t.get("progress"),
                          "dl": t.get("dlspeed"), "ul": t.get("upspeed"), "eta": t.get("eta"), "rozmiar": t.get("size"),
                          "stan": STANY_QBIT.get(t.get("state"), t.get("state")),
                          "pauza": str(t.get("state", "")).startswith(("paused", "stopped"))} for t in lista]}


def qbit_akcja(hsh, akcja):
    if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", hsh or ""):
        raise ValueError("zły hash")
    if akcja not in ("start", "stop"):
        raise ValueError("akcja: start | stop")
    try:  # qBittorrent 5.x
        qbit_req(f"/api/v2/torrents/{akcja}", method="POST", body={"hashes": hsh})
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        qbit_req(f"/api/v2/torrents/{'resume' if akcja == 'start' else 'pause'}", method="POST", body={"hashes": hsh})


def _arr(url, key, sciezka):
    return zadanie(f"{url}{sciezka}", headers={"X-Api-Key": key})


def sonarr():
    if not (SONARR_URL and SONARR_KEY):
        return {"disabled": True}
    dzis = date.today()
    q = _arr(SONARR_URL, SONARR_KEY, "/api/v3/queue?pageSize=20&includeSeries=true&includeEpisode=true") or {}
    kal = _arr(SONARR_URL, SONARR_KEY, f"/api/v3/calendar?start={dzis}&end={dzis + timedelta(days=7)}&includeSeries=true") or []
    kolejka = [{"tytul": ((r.get("series") or {}).get("title") or r.get("title")),
                "odc": _odc(r.get("episode") or {}), "postep": _postep(r), "eta": r.get("timeleft"), "stan": r.get("trackedDownloadState") or r.get("status")}
               for r in q.get("records", [])]
    nadch = [{"tytul": (e.get("series") or {}).get("title"), "odc": _odc(e), "kiedy": e.get("airDateUtc"), "jest": e.get("hasFile")}
             for e in kal]
    return {"kolejka": kolejka, "nadchodzace": nadch}


def media_pobrane():
    """Ostatnio pobrane (zaimportowane) odcinki z Sonarra i filmy z Radarra — do ogłaszania „nowe w Jellyfinie”."""
    out = []
    if SONARR_URL and SONARR_KEY:
        h = _arr(SONARR_URL, SONARR_KEY, "/api/v3/history?page=1&pageSize=30&sortKey=date&sortDirection=descending"
                                         "&includeSeries=true&includeEpisode=true") or {}
        for r in h.get("records", []):
            if r.get("eventType") == "downloadFolderImported":
                out.append({"id": f"s{r.get('id')}", "tytul": (r.get("series") or {}).get("title") or "?",
                            "odc": _odc(r.get("episode") or {}), "ts": r.get("date")})
    if RADARR_URL and RADARR_KEY:
        h = _arr(RADARR_URL, RADARR_KEY, "/api/v3/history?page=1&pageSize=30&sortKey=date&sortDirection=descending"
                                         "&includeMovie=true") or {}
        for r in h.get("records", []):
            if r.get("eventType") == "downloadFolderImported":
                m = r.get("movie") or {}
                out.append({"id": f"r{r.get('id')}", "tytul": m.get("title") or "?", "rok": m.get("year"), "ts": r.get("date")})
    return out


def radarr():
    if not (RADARR_URL and RADARR_KEY):
        return {"disabled": True}
    dzis = date.today()
    q = _arr(RADARR_URL, RADARR_KEY, "/api/v3/queue?pageSize=20&includeMovie=true") or {}
    kal = _arr(RADARR_URL, RADARR_KEY, f"/api/v3/calendar?start={dzis}&end={dzis + timedelta(days=30)}") or []
    kolejka = [{"tytul": (r.get("movie") or {}).get("title") or r.get("title"), "postep": _postep(r), "eta": r.get("timeleft"),
                "stan": r.get("trackedDownloadState") or r.get("status")} for r in q.get("records", [])]
    nadch = [{"tytul": m.get("title"), "rok": m.get("year"), "kiedy": m.get("digitalRelease") or m.get("physicalRelease") or m.get("inCinemas"),
              "jest": m.get("hasFile")} for m in kal]
    return {"kolejka": kolejka, "nadchodzace": nadch}


def _odc(e):
    if e.get("seasonNumber") is None:
        return ""
    return f"S{int(e['seasonNumber']):02d}E{int(e.get('episodeNumber') or 0):02d}"


def _postep(r):
    size, left = r.get("size") or 0, r.get("sizeleft") or 0
    return round(1 - left / size, 3) if size else None


def jellyfin():
    if not (JELLYFIN_URL and JELLYFIN_KEY):
        return {"disabled": True}
    h = {"Authorization": f'MediaBrowser Token="{JELLYFIN_KEY}"'}
    sesje = zadanie(f"{JELLYFIN_URL}/Sessions?activeWithinSeconds=900", headers=h) or []
    teraz = []
    for s in sesje:
        it = s.get("NowPlayingItem")
        if not it:
            continue
        ps = s.get("PlayState") or {}
        rt = it.get("RunTimeTicks") or 0
        teraz.append({"kto": s.get("UserName"), "urzadzenie": s.get("DeviceName") or s.get("Client"),
                      "tytul": it.get("Name"), "serial": it.get("SeriesName"), "pauza": ps.get("IsPaused"),
                      "postep": round((ps.get("PositionTicks") or 0) / rt, 3) if rt else None})
    nowe = zadanie(f"{JELLYFIN_URL}/Items?SortBy=DateCreated&SortOrder=Descending&Recursive=true"
                   f"&IncludeItemTypes=Movie,Episode&Limit=8", headers=h) or {}
    ostatnie = [{"tytul": i.get("Name"), "serial": i.get("SeriesName"), "rok": i.get("ProductionYear"), "typ": i.get("Type")}
                for i in nowe.get("Items", [])]
    return {"teraz": teraz, "ostatnie": ostatnie}


def media():
    return rownolegle({"qbit": qbit, "sonarr": sonarr, "radarr": radarr, "jellyfin": jellyfin})


# --------------------------------------------------------------------------- sieć: ZTE MC889A Pro, AdGuard, speedtest
ZTE_URL, ZTE_PASS = E("ZTE_URL", "https://192.168.254.1").rstrip("/"), E("ZTE_PASS", "")
ZTE_POLA = ("network_type,network_provider,signalbar,wan_active_band,nr5g_action_band,wan_ipaddr,"
            "Z5g_rsrp,Z5g_rsrq,Z5g_SINR,nr5g_pci,lte_rsrp,lte_rsrq,lte_snr,lte_rssi,lte_ca_pcell_band,"
            "realtime_rx_thrpt,realtime_tx_thrpt,monthly_rx_bytes,monthly_tx_bytes,realtime_time,"
            "pm_sensor_mdm,pm_modem_5g,pm_sensor_ambient,loginfo")
_zte = {"jar": http.cookiejar.CookieJar(), "zalogowany": 0.0}
# router ZTE słucha tylko po HTTPS z certyfikatem samopodpisanym — weryfikację wyłączamy wyłącznie dla tego jednego połączenia w LAN-ie
_zte["op"] = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_zte["jar"]),
                                         urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
_zte_lock = threading.Lock()


def _zte_get(cmd, multi=True):
    q = urllib.parse.urlencode({"isTest": "false", "cmd": cmd, **({"multi_data": "1"} if multi else {}), "_": int(time.time() * 1000)})
    return zadanie(f"{ZTE_URL}/goform/goform_get_cmd_process?{q}", opener=_zte["op"],
                   headers={"Referer": f"{ZTE_URL}/index.html", "X-Requested-With": "XMLHttpRequest"}) or {}


def _zte_login():
    ld = str(_zte_get("LD", multi=False).get("LD", "")).upper()
    if not ld:
        raise RuntimeError("ZTE: brak LD")
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest().upper()  # noqa: E731
    odp = zadanie(f"{ZTE_URL}/goform/goform_set_cmd_process", method="POST", form=True, opener=_zte["op"],
                  body={"isTest": "false", "goformId": "LOGIN", "password": sha(sha(ZTE_PASS) + ld)},
                  headers={"Referer": f"{ZTE_URL}/index.html", "X-Requested-With": "XMLHttpRequest"}) or {}
    wynik = str(odp.get("result")) if isinstance(odp, dict) else str(odp)
    if wynik != "0":
        _zte["zalogowany"] = 0.0
        raise RuntimeError({"3": "ZTE: złe hasło", "1": "ZTE: za dużo prób, odczekaj"}.get(wynik, f"ZTE: logowanie {wynik}"))
    _zte["zalogowany"] = time.time()


def zte(surowe=False):
    if not ZTE_PASS:
        return {"disabled": True}
    with _zte_lock:
        d = _zte_get(ZTE_POLA)
        if d.get("loginfo") != "ok" and time.time() - _zte["zalogowany"] > 30:
            _zte_login()  # nie częściej niż co 30 s — router blokuje po kilku nieudanych próbach
            d = _zte_get(ZTE_POLA)
    if surowe:
        return d
    f = lambda k: _liczba(d.get(k))  # noqa: E731
    nr = d.get("network_type", "")
    return {"siec": nr, "operator": d.get("network_provider"), "kreski": f("signalbar"),
            "pasmo": d.get("nr5g_action_band") or d.get("wan_active_band") or d.get("lte_ca_pcell_band"),
            "pasmo_lte": d.get("wan_active_band") or d.get("lte_ca_pcell_band"),
            "nr": {"rsrp": f("Z5g_rsrp"), "rsrq": f("Z5g_rsrq"), "sinr": f("Z5g_SINR"), "pci": d.get("nr5g_pci")},
            "lte": {"rsrp": f("lte_rsrp"), "rsrq": f("lte_rsrq"), "sinr": f("lte_snr"), "rssi": f("lte_rssi")},
            "rx": f("realtime_rx_thrpt"), "tx": f("realtime_tx_thrpt"),
            "miesiac_rx": f("monthly_rx_bytes"), "miesiac_tx": f("monthly_tx_bytes"),
            "temp": {"modem": f("pm_sensor_mdm"), "5g": f("pm_modem_5g"), "otoczenie": f("pm_sensor_ambient")},
            "ip": d.get("wan_ipaddr"), "zalogowany": d.get("loginfo") == "ok"}


def _liczba(v):
    try:
        return float(str(v).split(",")[0]) if v not in (None, "") else None
    except ValueError:
        return None


ADGUARD_URL, ADGUARD_USER, ADGUARD_PASS = E("ADGUARD_URL", "http://127.0.0.1:3030").rstrip("/"), E("ADGUARD_USER", ""), E("ADGUARD_PASS", "")


def adguard():
    if not ADGUARD_USER:
        return {"disabled": True}
    h = basic(ADGUARD_USER, ADGUARD_PASS)
    s = zadanie(f"{ADGUARD_URL}/control/stats", headers=h) or {}
    zap, blok = s.get("num_dns_queries") or 0, s.get("num_blocked_filtering") or 0
    klienci = []
    for wpis in (s.get("top_clients") or [])[:8]:
        for ip, n in wpis.items():
            klienci.append({"ip": ip, "n": n})
    nazwy = {}
    try:  # nazwy klientów (ręczne + wykryte przez rDNS/ARP)
        c = zadanie(f"{ADGUARD_URL}/control/clients", headers=h) or {}
        for k in c.get("clients") or []:
            for i in k.get("ids") or []:
                nazwy[i] = k.get("name")
        for k in c.get("auto_clients") or []:
            if k.get("name"):
                nazwy.setdefault(k.get("ip"), k.get("name"))
    except Exception:  # noqa: BLE001
        pass
    for k in klienci:
        k["nazwa"] = nazwy.get(k["ip"])
    domeny = [{"domena": d, "n": n} for wpis in (s.get("top_blocked_domains") or [])[:5] for d, n in wpis.items()]
    return {"zapytania": zap, "zablokowane": blok, "proc": round(100 * blok / zap, 1) if zap else 0,
            "czas_ms": round((s.get("avg_processing_time") or 0) * 1000, 1), "klienci": klienci, "blokowane": domeny}



# --------------------------------------------------------------------------- urządzenia w sieci (alert o nowym)
# ZTE (lan_station_list) zna klientów DHCP z MAC-iem, ale nie widzi urządzeń z Wi-Fi za Archerem, więc malinka
# dodatkowo „puka” w całą podsieć (pakiet UDP wymusza zapytanie ARP) i czyta tablicę ARP jądra. Panel chodzi
# w network_mode: host, więc /proc/net/arp to tablica malinki. AdGuard nie pomoże: nie ma DHCP ani MAC-ów.
SIEC_PREFIKS = E("SIEC_PREFIKS", "192.168.254.")
_MAC_RE = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")


def mac_norm(m):
    m = str(m or "").strip().upper().replace("-", ":")
    return m if _MAC_RE.match(m) and m not in ("00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF") else None


def mac_prywatny(mac):
    """Bit „lokalnie administrowany”: losowy MAC, jaki dają telefony/laptopy z prywatnym adresem Wi-Fi."""
    return bool(int(mac[1], 16) & 2)


def zte_urzadzenia():
    if not ZTE_PASS:
        return []
    with _zte_lock:
        if _zte_get("loginfo").get("loginfo") != "ok" and time.time() - _zte["zalogowany"] > 30:
            _zte_login()
        d = _zte_get("lan_station_list", multi=False)
    out = []
    for x in d.get("lan_station_list") or []:
        mac = mac_norm(x.get("mac_addr"))
        if mac:
            host = str(x.get("hostname") or "").strip()
            out.append({"mac": mac, "ip": x.get("ip_addr"), "host": None if host in ("", "--") else host[:40]})
    return out


def arp_urzadzenia(czekaj=3.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setblocking(False)
        for i in range(1, 255):
            try:
                s.sendto(b"\0", (f"{SIEC_PREFIKS}{i}", 9))   # port discard — chodzi tylko o zapytanie ARP
            except OSError:
                pass
        time.sleep(czekaj)   # gniazdo otwarte do końca czekania, żeby jądro dokończyło zapytania
    finally:
        s.close()
    out = []
    with open("/proc/net/arp", encoding="ascii") as f:
        next(f, None)
        for w in f:
            c = w.split()
            if len(c) >= 4 and c[0].startswith(SIEC_PREFIKS) and int(c[2], 16) & 2:
                mac = mac_norm(c[3])
                if mac:
                    out.append({"mac": mac, "ip": c[0], "host": None})
    return out


def urzadzenia_sieci():
    """({MAC: {ip, host, zrodla}}, [błędy]) z ZTE i ARP; błąd jednego źródła nie blokuje drugiego."""
    wynik, bledy = {}, []
    for nazwa, fn in (("zte", zte_urzadzenia), ("arp", arp_urzadzenia)):
        try:
            for u in fn():
                w = wynik.setdefault(u["mac"], {"ip": u["ip"], "host": None, "zrodla": []})
                w["host"] = w["host"] or u["host"]
                w["zrodla"].append(nazwa)
        except Exception as e:  # noqa: BLE001
            bledy.append(f"{nazwa}: {type(e).__name__}: {e}"[:200])
    return wynik, bledy


DISCORD_WEBHOOK, DISCORD_USER_ID = E("DISCORD_WEBHOOK", "").strip(), E("DISCORD_USER_ID", "").strip()


def discord_wyslij(tytul, opis, kolor=0xF0A020, ping=True):
    """Embed przez webhook (ten sam co mail-notifier). False = brak DISCORD_WEBHOOK w .env."""
    if not DISCORD_WEBHOOK:
        return False
    body = {"embeds": [{"title": tytul[:250], "description": opis[:4000], "color": kolor}]}
    if ping and DISCORD_USER_ID:
        body["content"] = f"<@{DISCORD_USER_ID}>"
    # Discord (Cloudflare) odrzuca domyślny User-Agent Pythona (403) — przedstawiamy się jak bot
    zadanie(DISCORD_WEBHOOK, method="POST", body=body, timeout=10, headers={"User-Agent": "DiscordBot (jarvis-panel, 1.0)"})
    return True



# --------------------------------------------------------------------------- Claude: limity planu (nieoficjalne API)
# Poświadczenia z osobnego logowania Claude Code na malince (2026-11-20):
#   docker run -it --rm -v ~/panel/data/claude:/root/.claude node:22-slim \
#     sh -c 'npm i -g @anthropic-ai/claude-code && claude auth login --claudeai'
# Access token żyje ~8 h; odświeżamy go sami (refresh token ROTUJE — nowy trzeba od razu zapisać, a z tego pliku
# nie może korzystać nic innego). /api/oauth/usage to endpoint, z którego czyta Claude Code; ostro limituje (429),
# więc pytamy rzadko. Bierzemy tylko stabilną część odpowiedzi: limits[], five_hour/seven_day, seven_day_breakdown.
CLAUDE_CRED = os.path.join(DATA_DIR, "claude", ".credentials.json")
CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
_claude_lock = threading.Lock()


def _claude_cred():
    with open(CLAUDE_CRED, encoding="utf-8") as f:
        return json.load(f)


def _claude_odswiez(d):
    o = d["claudeAiOauth"]
    if not o.get("refreshToken"):
        raise RuntimeError("Claude: brak refresh tokena — zaloguj malinkę ponownie")
    r = zadanie(CLAUDE_TOKEN_URL, method="POST", timeout=15, headers={"User-Agent": "jarvis-panel"},
                body={"grant_type": "refresh_token", "refresh_token": o["refreshToken"], "client_id": CLAUDE_CLIENT_ID})
    if not isinstance(r, dict) or not r.get("access_token"):
        raise RuntimeError("Claude: odświeżenie tokena bez access_token")
    o["accessToken"] = r["access_token"]
    o["refreshToken"] = r.get("refresh_token") or o["refreshToken"]
    o["expiresAt"] = int((time.time() + float(r.get("expires_in") or 28800)) * 1000)
    if r.get("scope"):
        o["scopes"] = r["scope"].split()
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(CLAUDE_CRED), prefix=".cred-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(d, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CLAUDE_CRED)
    print("claude: token odświeżony", flush=True)


def _claude_token(wymus=False):
    with _claude_lock:   # jedno odświeżanie naraz — przy rotacji równoległe zepsułoby sesję
        d = _claude_cred()
        if wymus or d["claudeAiOauth"].get("expiresAt", 0) / 1000 - time.time() < 600:
            _claude_odswiez(d)
        return d["claudeAiOauth"]["accessToken"], d["claudeAiOauth"].get("subscriptionType")


def _iso_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() if s else None
    except ValueError:
        return None


CLAUDE_NAZWY = {"session": "Sesja (5 h)", "weekly_all": "Tydzień", "weekly_opus": "Tydzień · Opus",
                "weekly_sonnet": "Tydzień · Sonnet", "weekly_cowork": "Tydzień · Cowork"}


def claude_limity():
    if not os.path.exists(CLAUDE_CRED):
        return {"disabled": True}
    for proba in (0, 1):
        token, plan = _claude_token(wymus=bool(proba))
        try:
            d = zadanie(CLAUDE_USAGE_URL, timeout=10, headers={
                "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "jarvis-panel"})
            break
        except urllib.error.HTTPError as e:
            if e.code != 401 or proba:
                raise
    limity = []
    for x in d.get("limits") or []:
        if x.get("percent") is None:
            continue
        k = str(x.get("kind") or "")
        limity.append({"kind": k, "nazwa": CLAUDE_NAZWY.get(k) or k.replace("_", " ").capitalize(),
                       "grupa": x.get("group"), "proc": float(x["percent"]), "poziom": x.get("severity") or "normal",
                       "reset": _iso_ts(x.get("resets_at")), "aktywny": bool(x.get("is_active"))})
    if not limity:   # starszy kształt odpowiedzi
        for k, kind in (("five_hour", "session"), ("seven_day", "weekly_all")):
            v = d.get(k)
            if isinstance(v, dict) and v.get("utilization") is not None:
                limity.append({"kind": kind, "nazwa": CLAUDE_NAZWY[kind], "grupa": "session" if kind == "session" else "weekly",
                               "proc": float(v["utilization"]), "poziom": "normal", "reset": _iso_ts(v.get("resets_at")), "aktywny": False})
    b = d.get("seven_day_breakdown") or {}
    podzial = [{"nazwa": r.get("display_name") or r.get("key"), "udzial": r.get("percent"), "limitu": r.get("percent_of_limit")}
               for r in b.get("rows") or [] if r.get("percent")]
    ex = d.get("extra_usage") or {}
    return {"plan": plan, "limity": limity, "podzial": podzial, "tydzien_od": _iso_ts(b.get("window_started_at")),
            "dodatkowe": bool(ex.get("is_enabled")), "ts": time.time()}


_speed_lock = threading.Lock()
# Cloudflare odrzuca domyślny User-Agent Pythona (403), więc przedstawiamy się jak zwykła przeglądarka
_SPEED_UA = {"User-Agent": "Mozilla/5.0 (X11; Linux aarch64) jarvis-panel"}


def speedtest():
    if not _speed_lock.acquire(blocking=False):
        raise RuntimeError("test już trwa")
    try:
        t0 = time.time()
        zadanie("https://speed.cloudflare.com/__down?bytes=0", surowe=True, timeout=10, headers=_SPEED_UA)
        ping = (time.time() - t0) * 1000
        # kilka strumieni naraz: pojedynczy krotki strumien TCP zanizal wynik ~3-6x
        from concurrent.futures import ThreadPoolExecutor
        N = 4

        def _dol():
            dane, _ = zadanie("https://speed.cloudflare.com/__down?bytes=25000000", surowe=True,
                              timeout=90, headers=_SPEED_UA)
            return len(dane)

        def _gora():
            zadanie("https://speed.cloudflare.com/__up", method="POST", body=b"\0" * 10_000_000,
                    surowe=True, timeout=90,
                    headers={**_SPEED_UA, "Content-Type": "application/octet-stream"})
            return 10_000_000

        def _mierz(f):
            t0 = time.time()
            with ThreadPoolExecutor(N) as ex:
                bajty = sum(ex.map(lambda _: f(), range(N)))
            return bajty * 8 / (time.time() - t0) / 1e6

        dol = _mierz(_dol)
        gora = _mierz(_gora)
        wynik = {"ts": time.time(), "ping": round(ping), "dol": round(dol, 1), "gora": round(gora, 1)}
        pamiec_set("speedtest", wynik)
        return wynik
    finally:
        _speed_lock.release()


# --------------------------------------------------------------------------- trening / LED
TRENER_URL = E("TRENER_URL", "http://127.0.0.1:8082").rstrip("/")
WLED_URL = E("WLED_URL", "").rstrip("/")


def trening():
    return zadanie(f"{TRENER_URL}/api/panel", timeout=10)


# --------------------------------------------------------------------------- gniazda (przedłużacze ESPHome, REST web_server)
# GNIAZDA=monitor|Monitor|http://192.168.254.40|Monitor;drukarka|Drukarka|http://192.168.254.40|Drukarka
#   id | nazwa w panelu | adres przedłużacza | nazwa przełącznika w ESPHome.  GNIAZDA_HASLO = web_password (login admin)
GNIAZDA_HASLO = E("GNIAZDA_HASLO", "")


def lista_gniazd():
    out = []
    for wpis in (E("GNIAZDA", "") or "").split(";"):
        cz = [c.strip() for c in wpis.split("|")]
        if len(cz) >= 4 and all(cz[:4]):
            out.append({"id": cz[0], "nazwa": cz[1], "url": cz[2].rstrip("/"), "esp": cz[3]})
    return out


def _gniazdo_url(g, akcja=""):
    return f"{g['url']}/switch/{urllib.parse.quote(g['esp'])}" + (f"/{akcja}" if akcja else "")


def _gniazdo_wl(g, timeout):
    d = zadanie(_gniazdo_url(g), headers=basic("admin", GNIAZDA_HASLO), timeout=timeout)
    return isinstance(d, dict) and d.get("state") == "ON"


def gniazda_stan():
    """Przegląd: dla każdego gniazda z GNIAZDA - czy przedłużacz odpowiada i czy para ma prąd."""
    def jeden(g):
        w = {"id": g["id"], "nazwa": g["nazwa"]}
        try:
            w["on"] = _gniazdo_wl(g, 2)
            w["online"] = True
        except Exception as e:  # noqa: BLE001
            w["online"] = False
            w["error"] = f"{type(e).__name__}: {e}"[:160]
        return w

    gn = lista_gniazd()
    return list(pula.map(jeden, gn)) if gn else []


def gniazdo_ustaw(gid, akcja):
    """akcja: on | off | toggle -> stan po zmianie."""
    sciezka = {"on": "turn_on", "off": "turn_off", "toggle": "toggle"}.get(akcja)
    if not sciezka:
        raise ValueError("akcja: on | off | toggle")
    g = next((x for x in lista_gniazd() if x["id"] == gid), None)
    if not g:
        raise ValueError(f"nie ma gniazda {gid}")
    # body=b"" -> POST z Content-Length: 0 (ESPHome nie potrzebuje treści)
    zadanie(_gniazdo_url(g, sciezka), method="POST", body=b"", headers=basic("admin", GNIAZDA_HASLO), timeout=4)
    on = _gniazdo_wl(g, 3)
    return {"id": g["id"], "nazwa": g["nazwa"], "on": on,
            "msg": f"{g['nazwa']}: zasilanie {'włączone' if on else 'wyłączone'}"}


def wled():
    if not WLED_URL:
        return {"disabled": True}
    r = rownolegle({"state": lambda: zadanie(f"{WLED_URL}/json/state", timeout=3),
                    "info": lambda: zadanie(f"{WLED_URL}/json/info", timeout=3),
                    "presets": lambda: zadanie(f"{WLED_URL}/presets.json", timeout=3)})
    if not r["state"]["ok"]:
        raise RuntimeError(r["state"]["error"])
    st, info = r["state"]["data"] or {}, (r["info"]["data"] if r["info"]["ok"] else None) or {}
    pres = (r["presets"]["data"] if r["presets"]["ok"] else None) or {}
    seg = (st.get("seg") or [{}])[0]
    kol = (seg.get("col") or [[255, 255, 255]])[0]
    return {"on": st.get("on"), "bri": st.get("bri"), "ps": st.get("ps"), "kolor": kol[:3],
            "nazwa": info.get("name"), "wersja": info.get("ver"),
            "presety": [{"id": int(k), "nazwa": v.get("n") or f"Preset {k}"} for k, v in pres.items()
                        if k.isdigit() and int(k) > 0 and isinstance(v, dict)]}


def wled_ustaw(b):
    if not WLED_URL:
        raise ValueError("brak WLED_URL w .env")
    st = {}
    if "on" in b:
        st["on"] = bool(b["on"]) if b["on"] != "t" else "t"
    if "bri" in b:
        st["bri"] = max(1, min(255, int(b["bri"])))
    if "ps" in b:
        st["ps"] = int(b["ps"])
    if "kolor" in b:
        k = [max(0, min(255, int(x))) for x in b["kolor"][:3]]
        if len(k) != 3:
            raise ValueError("kolor: [r, g, b]")
        st["seg"] = [{"col": [k]}]
        st.setdefault("on", True)
    if not st:
        raise ValueError("nic do zmiany")
    return zadanie(f"{WLED_URL}/json/state", method="POST", body=st, timeout=3)


# --------------------------------------------------------------------------- dzień: kalendarz, Paperless, poczta
NC_CAL_URLS = [u.strip() for u in E("NEXTCLOUD_CAL_URLS", "").split(",") if u.strip()]
NC_USER, NC_PASS = E("NEXTCLOUD_USER", ""), E("NEXTCLOUD_PASS", "")
PAPERLESS_URL, PAPERLESS_TOKEN = E("PAPERLESS_URL", "").rstrip("/"), E("PAPERLESS_TOKEN", "")
MAIL_STAN = E("MAIL_STAN", "/mail/stan.json")
DNI_KAL = 7


def _ics_data(wartosc, params):
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?", wartosc)
    if not m:
        return None, False
    y, mo, d, h, mi, s, z = m.groups()
    if h is None or "VALUE=DATE" in params.upper() and "DATE-TIME" not in params.upper():
        return datetime(int(y), int(mo), int(d), tzinfo=TZ), True
    tzm = re.search(r"TZID=\"?([^;:\"]+)", params)
    try:
        strefa = timezone.utc if z else (ZoneInfo(tzm.group(1)) if tzm else TZ)
    except Exception:  # noqa: BLE001  nieznana strefa w ICS
        strefa = TZ
    return datetime(int(y), int(mo), int(d), int(h), int(mi), int(s or 0), tzinfo=strefa).astimezone(TZ), False


def _parsuj_ics(tekst):
    tekst = re.sub(r"\r?\n[ \t]", "", tekst)
    out = []
    for blok in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", tekst, flags=re.S):
        pola = {}
        for linia in blok.splitlines():
            m = re.match(r"^([A-Z-]+)((?:;[^:]*)?):(.*)$", linia)
            if m and m.group(1) not in pola:
                pola[m.group(1)] = (m.group(2), m.group(3))
        if "DTSTART" not in pola:
            continue
        start, cd = _ics_data(pola["DTSTART"][1], pola["DTSTART"][0])
        koniec = _ics_data(pola["DTEND"][1], pola["DTEND"][0])[0] if "DTEND" in pola else None
        if not start:
            continue
        tyt = re.sub(r"\\([,;\\])", r"\1", pola.get("SUMMARY", ("", "(bez tytułu)"))[1]).replace("\\n", " ")
        miejsce = re.sub(r"\\([,;\\])", r"\1", pola.get("LOCATION", ("", ""))[1]).replace("\\n", " ")
        out.append({"start": start.isoformat(), "koniec": koniec.isoformat() if koniec else None, "caly_dzien": cd,
                    "tytul": tyt.strip(), "miejsce": miejsce.strip() or None})
    return out


def kalendarz_pobierz():
    """Google Calendar (gdy jest klucz konta serwisowego), inaczej CalDAV REPORT z <expand> z Nextclouda."""
    if gcal_aktywny():
        od = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
        wynik = {"ts": time.time(), "wydarzenia": gcal_wydarzenia(od, od + timedelta(days=DNI_KAL))[:60], "zrodlo": "google"}
        pamiec_set("kalendarz", wynik)
        return wynik
    if not NC_CAL_URLS:
        return None
    od = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    do = od + timedelta(days=DNI_KAL)
    f = lambda t: t.strftime("%Y%m%dT%H%M%SZ")  # noqa: E731
    xml = (f'<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
           f'<d:prop><c:calendar-data><c:expand start="{f(od)}" end="{f(do)}"/></c:calendar-data></d:prop>'
           f'<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
           f'<c:time-range start="{f(od)}" end="{f(do)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')
    wydarzenia = []
    for url in NC_CAL_URLS:
        raw, _ = zadanie(url, method="REPORT", body=xml, surowe=True, timeout=10,
                         headers={**basic(NC_USER, NC_PASS), "Depth": "1", "Content-Type": "application/xml; charset=utf-8"})
        for el in ET.fromstring(raw).iter("{urn:ietf:params:xml:ns:caldav}calendar-data"):
            wydarzenia += _parsuj_ics(el.text or "")
    wydarzenia.sort(key=lambda w: w["start"])
    wynik = {"ts": time.time(), "wydarzenia": wydarzenia[:60]}
    pamiec_set("kalendarz", wynik)
    return wynik



# --------------------------------------------------------------------------- kalendarz: pogoda w miejscu i dodawanie
# Z Yapass-discord-bot (2026-11-20): pole „Miejsce” wydarzenia -> Nominatim (geokodowanie, wynik zapamiętany na stałe
# w pamiec "geo") -> prognoza godzinowa Open-Meteo (do 16 dni, pamięć 1 h na punkt). Polskie „w Krakowie” próbujemy
# też w mianowniku (Kraków). Nominatim: najwyżej 1 zapytanie na sekundę i własny User-Agent.
NOMINATIM = "https://nominatim.openstreetmap.org/search"
_UA_GEO = {"User-Agent": "jarvis-panel/1.0 (domowy panel JARVIS; github.com/MaciejMalina)"}
ONLINE_RE = re.compile(r"https?://|teams|zoom|meet\.|online|discord|telefon", re.I)
_geo_lock = threading.Lock()
_pog_cache = {}


def _formy_miejsca(m):
    """Najpierw mianownik zgadnięty z miejscownika („Krakowie” -> Kraków), na końcu tekst jak wpisany — inaczej
    Nominatim dopasowuje „w Krakowie” np. do „Muzeum Narodowe w Krakowie”."""
    m = re.sub(r"^(w|we|na)\s+", "", m.strip(), flags=re.I)
    formy = []
    for kon, zam in (("owie", "ów"), ("niu", "ń"), ("cach", "ce"), ("ach", "y"), ("ie", "a"), ("iu", ""), ("u", ""), ("em", "e")):
        if m.lower().endswith(kon) and len(m) > len(kon) + 2:
            formy.append(m[: -len(kon)] + zam)
    return list(dict.fromkeys(formy + [m]))


def geo_z_pamieci(miejsce):
    """(lat, lon, nazwa) | None (nie ma takiego miejsca) | False (jeszcze nie sprawdzane)."""
    if not miejsce or ONLINE_RE.search(miejsce):
        return None
    g = pamiec_get("geo", {}) or {}
    k = " ".join(miejsce.lower().split())[:120]
    return g[k] if k in g else False


def geokoduj(miejsce):
    if not miejsce or ONLINE_RE.search(miejsce):
        return None
    k = " ".join(miejsce.lower().split())[:120]
    with _geo_lock:
        g = pamiec_get("geo", {}) or {}
        if k in g:
            return g[k]
        wynik, blad = None, False
        for forma in _formy_miejsca(miejsce)[:4]:
            q = urllib.parse.urlencode({"q": forma, "format": "json", "limit": 1, "accept-language": "pl"})
            try:
                r = zadanie(f"{NOMINATIM}?{q}", headers=_UA_GEO, timeout=8) or []
            except Exception:  # noqa: BLE001
                r, blad = [], True
            time.sleep(1.1)
            if r:
                wynik = [float(r[0]["lat"]), float(r[0]["lon"]), str(r[0].get("display_name") or forma).split(",")[0].strip()]
                break
        if wynik or not blad:   # brak sieci nie zapisuje „nie ma takiego miejsca”
            g[k] = wynik
            pamiec_set("geo", g)
        return wynik


def pogoda_w(lat, lon, start, caly_dzien=False):
    """{temp, min, pp, code} w danym miejscu o godzinie startu (albo na cały dzień); None = poza prognozą."""
    k = (round(lat, 2), round(lon, 2))
    c = _pog_cache.get(k)
    if not c or time.time() - c[0] > 3600:
        q = urllib.parse.urlencode({"latitude": k[0], "longitude": k[1], "timezone": "Europe/Warsaw", "forecast_days": 16,
                                    "hourly": "temperature_2m,precipitation_probability,weather_code",
                                    "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code"})
        c = (time.time(), zadanie(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=10) or {})
        _pog_cache[k] = c
    d = c[1]
    if caly_dzien:
        dl = d.get("daily") or {}
        try:
            i = (dl.get("time") or []).index(start.strftime("%Y-%m-%d"))
        except ValueError:
            return None
        return {"temp": dl["temperature_2m_max"][i], "min": dl["temperature_2m_min"][i],
                "pp": dl["precipitation_probability_max"][i], "code": dl["weather_code"][i]}
    h = d.get("hourly") or {}
    try:
        i = (h.get("time") or []).index(start.strftime("%Y-%m-%dT%H:00"))
    except ValueError:
        return None
    return {"temp": h["temperature_2m"][i], "pp": h["precipitation_probability"][i], "code": h["weather_code"][i]}


def _ics_tekst(v):
    return str(v).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def kalendarz_dodaj(w):
    """Nowe wydarzenie: Google (GCAL_ZAPIS), a bez klucza — PUT do pierwszego kalendarza Nextclouda (serwer musi działać).
    w: {uid, tytul, start (ISO z czasem lokalnym albo RRRR-MM-DD), minuty, caly_dzien, miejsce}"""
    if gcal_aktywny():
        if w.get("caly_dzien"):
            d = date.fromisoformat(w["start"][:10])
            czas = {"start": {"date": d.isoformat()}, "end": {"date": (d + timedelta(days=1)).isoformat()}}
        else:
            st = datetime.fromisoformat(w["start"][:16])
            kon = st + timedelta(minutes=int(w.get("minuty") or 60))
            czas = {"start": {"dateTime": st.isoformat(timespec="seconds"), "timeZone": "Europe/Warsaw"},
                    "end": {"dateTime": kon.isoformat(timespec="seconds"), "timeZone": "Europe/Warsaw"}}
        e = _g(_g_kal(GCAL_ZAPIS) + "/events", method="POST",
               body={"summary": w["tytul"], **({"location": w["miejsce"]} if w.get("miejsce") else {}), **czas,
                     "description": "Dodane przez JARVIS-a"})
        w["id"] = (e or {}).get("id")
        return
    if not NC_CAL_URLS:
        raise RuntimeError("brak NEXTCLOUD_CAL_URLS w .env")
    utc = lambda dt: dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")  # noqa: E731
    if w.get("caly_dzien"):
        d = date.fromisoformat(w["start"][:10])
        czas = [f"DTSTART;VALUE=DATE:{d:%Y%m%d}", f"DTEND;VALUE=DATE:{d + timedelta(days=1):%Y%m%d}"]
    else:
        st = datetime.fromisoformat(w["start"]).replace(tzinfo=TZ) if "+" not in w["start"][10:] else datetime.fromisoformat(w["start"])
        czas = [f"DTSTART:{utc(st)}", f"DTEND:{utc(st + timedelta(minutes=int(w.get('minuty') or 60)))}"]
    linie = (["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JARVIS//panel//PL", "BEGIN:VEVENT", f"UID:{w['uid']}",
              f"DTSTAMP:{utc(datetime.now(TZ))}"] + czas + [f"SUMMARY:{_ics_tekst(w['tytul'])}"]
             + ([f"LOCATION:{_ics_tekst(w['miejsce'])}"] if w.get("miejsce") else []) + ["END:VEVENT", "END:VCALENDAR", ""])
    zadanie(NC_CAL_URLS[0].rstrip("/") + f"/{w['uid']}.ics", method="PUT", body="\r\n".join(linie), timeout=10,
            headers={**basic(NC_USER, NC_PASS), "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*"})


# --------------------------------------------------------------------------- Google Calendar (od 2026-11-22 zamiast Nextclouda)
# Konto serwisowe (klucz JSON w data/google-sa.json, poza gitem) z dostępem „wprowadzanie zmian” do kalendarza Macieja.
# Działa niezależnie od serwera (Nextcloud był na serwerze, który śpi). Bez pliku klucza zostaje stary Nextcloud.
GOOGLE_SA = E("GOOGLE_SA", os.path.join(DATA_DIR, "google-sa.json"))
GCAL_ZAPIS = E("GCAL_ZAPIS", "")   # adres kalendarza (zwykle Twój Gmail), udostępniony kontu serwisowemu z prawem zmian
GCAL_ODCZYT = [c for c in dict.fromkeys([GCAL_ZAPIS] + [x.strip() for x in E("GCAL_ODCZYT", "pl.polish#holiday@group.v.calendar.google.com")
                                                         .split(",")]) if c]
GCAL_API = "https://www.googleapis.com/calendar/v3"
_g_tok = {"t": None, "exp": 0}
_g_lock = threading.Lock()


def gcal_aktywny():
    return bool(GCAL_ZAPIS) and os.path.isfile(GOOGLE_SA)


def _g_token():
    """Token OAuth z konta serwisowego: JWT podpisany RS256 kluczem z pliku, wymieniany na access token (1 h)."""
    with _g_lock:
        if _g_tok["t"] and time.time() < _g_tok["exp"] - 120:
            return _g_tok["t"]
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        with open(GOOGLE_SA, encoding="utf-8") as f:
            sa = json.load(f)
        b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
        t = int(time.time())
        nagl = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
        tresc = b64(json.dumps({"iss": sa["client_email"], "scope": "https://www.googleapis.com/auth/calendar",
                                "aud": sa["token_uri"], "iat": t, "exp": t + 3600}).encode())
        klucz = serialization.load_pem_private_key(sa["private_key"].encode(), None)
        podpis = b64(klucz.sign(f"{nagl}.{tresc}".encode(), padding.PKCS1v15(), hashes.SHA256()))
        odp = zadanie(sa["token_uri"], method="POST", form=True, timeout=15,
                      body={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": f"{nagl}.{tresc}.{podpis}"})
        _g_tok.update(t=odp["access_token"], exp=t + int(odp.get("expires_in", 3600)))
        return _g_tok["t"]


def _g(sciezka, method="GET", body=None, params=None):
    url = GCAL_API + sciezka + ("?" + urllib.parse.urlencode(params) if params else "")
    return zadanie(url, method=method, body=body, timeout=15, headers={"Authorization": "Bearer " + _g_token()})


def _g_kal(cal):
    return "/calendars/" + urllib.parse.quote(cal, safe="")


def _g_wydarzenie(e, cal):
    s, k = e.get("start") or {}, e.get("end") or {}
    cd = "dateTime" not in s
    if cd:
        start = datetime.fromisoformat(s["date"]).replace(tzinfo=TZ)
        koniec = datetime.fromisoformat(k["date"]).replace(tzinfo=TZ) if k.get("date") else None
    else:
        start = datetime.fromisoformat(s["dateTime"]).astimezone(TZ)
        koniec = datetime.fromisoformat(k["dateTime"]).astimezone(TZ) if k.get("dateTime") else None
    return {"start": start.isoformat(), "koniec": koniec.isoformat() if koniec else None, "caly_dzien": cd,
            "tytul": (e.get("summary") or "(bez tytułu)").strip(), "miejsce": (e.get("location") or "").strip() or None,
            "id": e.get("id"), "swieto": cal != GCAL_ZAPIS}


def gcal_wydarzenia(od, do, limit=250, tylko_moje=False):
    """Wydarzenia ze wszystkich kalendarzy GCAL_ODCZYT (cykliczne rozwinięte przez Google), posortowane."""
    out = []
    for cal in ([GCAL_ZAPIS] if tylko_moje else GCAL_ODCZYT):
        d = _g(_g_kal(cal) + "/events", params={"timeMin": od.isoformat(), "timeMax": do.isoformat(), "singleEvents": "true",
                                                 "orderBy": "startTime", "maxResults": limit})
        out += [_g_wydarzenie(e, cal) for e in (d or {}).get("items", []) if e.get("status") != "cancelled"]
    out.sort(key=lambda w: w["start"])
    return out


def kalendarz_usun(eid):
    if not re.fullmatch(r"[\w-]{5,1024}", eid or ""):
        raise ValueError("złe id wydarzenia")
    _g(_g_kal(GCAL_ZAPIS) + "/events/" + eid, method="DELETE")


def _ics_utc(iso):
    return datetime.fromisoformat(iso).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def kalendarz_ics(dni_wstecz=1, dni_naprzod=31):
    """Eksport ICS (wydarzenia już rozwinięte) dla porannego raportu n8n — ten sam format, który parsował z Nextclouda."""
    od = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=dni_wstecz)
    linie = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JARVIS//panel-google//PL"]
    for w in gcal_wydarzenia(od, od + timedelta(days=dni_wstecz + dni_naprzod)):
        if w["caly_dzien"]:
            d = date.fromisoformat(w["start"][:10])
            k = date.fromisoformat(w["koniec"][:10]) if w["koniec"] else d + timedelta(days=1)
            czas = [f"DTSTART;VALUE=DATE:{d:%Y%m%d}", f"DTEND;VALUE=DATE:{k:%Y%m%d}"]
        else:
            czas = [f"DTSTART:{_ics_utc(w['start'])}"] + ([f"DTEND:{_ics_utc(w['koniec'])}"] if w["koniec"] else [])
        linie += (["BEGIN:VEVENT", f"UID:{w['id']}@google"] + czas + [f"SUMMARY:{_ics_tekst(w['tytul'])}"]
                  + ([f"LOCATION:{_ics_tekst(w['miejsce'])}"] if w["miejsce"] else []) + ["END:VEVENT"])
    return "\r\n".join(linie + ["END:VCALENDAR", ""])


def paperless_pobierz():
    if not (PAPERLESS_URL and PAPERLESS_TOKEN):
        return None
    h = {"Authorization": f"Token {PAPERLESS_TOKEN}"}
    pola = {str(p.get("name", "")).lower(): p.get("id")
            for p in (zadanie(f"{PAPERLESS_URL}/api/custom_fields/?page_size=100", headers=h) or {}).get("results", [])}
    termin, zapl, kwota = pola.get("termin płatności"), pola.get("zapłacone"), pola.get("kwota")
    faktury = []
    if termin:
        docs = zadanie(f"{PAPERLESS_URL}/api/documents/?custom_fields__id__in={termin}&page_size=300", headers=h, timeout=15) or {}
        dzis = date.today()
        for d in docs.get("results", []):
            w = {cf.get("field"): cf.get("value") for cf in d.get("custom_fields") or []}
            if not w.get(termin) or w.get(zapl) is True:
                continue
            try:
                t = date.fromisoformat(str(w[termin])[:10])
            except ValueError:
                continue
            if t > dzis + timedelta(days=30):
                continue
            kw = w.get(kwota)
            faktury.append({"id": d.get("id"), "tytul": d.get("title"), "termin": t.isoformat(), "dni": (t - dzis).days,
                            "kwota": re.sub(r"^([A-Z]{3})(.+)$", r"\2 \1", str(kw)) if kw else None})
    faktury.sort(key=lambda f: f["termin"])
    wynik = {"ts": time.time(), "faktury": faktury, "url": PAPERLESS_URL}
    pamiec_set("paperless", wynik)
    return wynik


# --------------------------------------------------------------------------- Paperless: porządki (2026-11-22)
# 1) Raz w tygodniu (gdy serwer działa): zapłacone faktury starsze niż 2 lata -> kosz Paperlessa (30 dni na odzyskanie),
#    z pominięciem tych, których „Gwarancja do” jeszcze nie minęła. Raport na Discordzie.
# 2) Import PDF-ów z Nextclouda (foldery NC_PAPERLESS_FOLDERY, nazwa folderu = tag). Jedno zapytanie WebDAV SEARCH
#    zamiast chodzenia po folderach; po PAPERLESS_PACZKA plików na raz; plik jest „zrobiony” dopiero, gdy zadanie
#    Paperlessa skończy się sukcesem albo odrzuceniem duplikatu — jeśli serwer zaśnie w trakcie, wraca do kolejki.
NC_PAPERLESS_FOLDERY = [f.strip() for f in E("NC_PAPERLESS_FOLDERY", "Dokumenty,Studia").split(",") if f.strip()]
PAPERLESS_PACZKA = int(E("PAPERLESS_PACZKA", "10"))
FAKTURY_LAT = int(E("FAKTURY_LAT", "2"))
NC_PL_STAN = os.path.join(DATA_DIR, "nc_paperless.json")
_pl_lock = threading.Lock()


def _pl(sciezka, method="GET", body=None, timeout=30):
    return zadanie(PAPERLESS_URL + sciezka, method=method, body=body, timeout=timeout,
                   headers={"Authorization": f"Token {PAPERLESS_TOKEN}"})


def _pl_wszystkie(sciezka):
    out, url = [], sciezka
    while url:
        r = _pl(url) or {}
        out += r.get("results", [])
        nast = r.get("next")
        url = ("/" + nast.split("/", 3)[3]) if nast else None
    return out


def faktury_do_usuniecia():
    """Zapłacone faktury starsze niż FAKTURY_LAT lat, bez ważnej gwarancji: [{id, tytul, data}]."""
    pola = {str(p.get("name", "")).lower(): p.get("id") for p in _pl_wszystkie("/api/custom_fields/?page_size=100")}
    typy = {str(t.get("name", "")).lower(): t.get("id") for t in _pl_wszystkie("/api/document_types/?page_size=100")}
    zapl, gw, faktura = pola.get("zapłacone"), pola.get("gwarancja do"), typy.get("faktura")
    if not (zapl and faktura):
        return []
    dzis = date.today()
    granica = dzis.replace(year=dzis.year - FAKTURY_LAT)
    out = []
    for d in _pl_wszystkie(f"/api/documents/?page_size=100&document_type__id={faktura}&created__date__lt={granica.isoformat()}"
                           "&fields=id,title,created,custom_fields"):
        w = {cf.get("field"): cf.get("value") for cf in d.get("custom_fields") or []}
        if w.get(zapl) is not True:
            continue
        try:
            if gw and w.get(gw) and date.fromisoformat(str(w[gw])[:10]) >= dzis:
                continue   # gwarancja jeszcze trwa — faktura to dowód
        except ValueError:
            continue       # nieczytelna data gwarancji — na wszelki wypadek nie ruszamy
        out.append({"id": d["id"], "tytul": d.get("title") or f"#{d['id']}", "data": str(d.get("created"))[:10]})
    return out


def faktury_sprzatnij():
    lista = faktury_do_usuniecia()
    usuniete = []
    for f in lista:
        try:
            _pl(f"/api/documents/{f['id']}/", method="DELETE")
            usuniete.append(f)
        except Exception as e:  # noqa: BLE001
            print(f"paperless: usuwanie #{f['id']}: {e}", flush=True)
    if usuniete:
        discord_wyslij(f"🗑️ Paperless: {len(usuniete)} starych faktur do kosza",
                       "\n".join(f"• {f['data']} — {f['tytul'][:90]}" for f in usuniete[:20])
                       + f"\n\nZapłacone, starsze niż {FAKTURY_LAT} lata, bez trwającej gwarancji. Kosz Paperlessa trzyma je 30 dni.",
                       ping=False)
    return usuniete


def _nc_baza():
    """(host, ścieżka DAV użytkownika) z adresu kalendarza Nextclouda: http://host:8081, /remote.php/dav/files/admin/"""
    m = re.match(r"(https?://[^/]+)(/remote\.php/dav)/calendars/([^/]+)/", NC_CAL_URLS[0] if NC_CAL_URLS else "")
    if not m:
        raise RuntimeError("brak NEXTCLOUD_CAL_URLS — nie znam adresu Nextclouda")
    return m.group(1), m.group(2), m.group(3)


def nc_pdfy(folder, strona=20000):
    """Wszystkie PDF-y w folderze Nextclouda (z podfolderami): {href: {etag, rozmiar}} — WebDAV SEARCH, stronami
    (Nextcloud bez limitu oddaje tylko 100 wyników, a firstresult ignoruje — więc jedno duże zapytanie)."""
    host, dav, user = _nc_baza()
    out, od = {}, 0
    while True:
        xml = ('<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:basicsearch>'
               '<d:select><d:prop><d:getetag/><d:getcontentlength/></d:prop></d:select><d:from><d:scope>'
               f'<d:href>/files/{user}/{urllib.parse.quote(folder)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>'
               '<d:where><d:eq><d:prop><d:getcontenttype/></d:prop><d:literal>application/pdf</d:literal></d:eq></d:where>'
               '<d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:ascending/></d:order></d:orderby>'
               f'<d:limit><d:nresults>{strona}</d:nresults><oc:firstresult>{od}</oc:firstresult></d:limit>'
               '</d:basicsearch></d:searchrequest>')
        raw, _ = zadanie(host + dav + "/", method="SEARCH", body=xml, surowe=True, timeout=120,
                         headers={**basic(NC_USER, NC_PASS), "Content-Type": "text/xml; charset=utf-8"})
        ile, przed = 0, len(out)
        for r in ET.fromstring(raw).findall("{DAV:}response"):
            ile += 1
            href = r.findtext("{DAV:}href") or ""
            etag = r.findtext(".//{DAV:}getetag") or ""
            dl = r.findtext(".//{DAV:}getcontentlength") or "0"
            if href.lower().endswith(".pdf"):
                out[href] = {"etag": etag.strip('"'), "rozmiar": int(dl or 0)}
        if ile < strona or len(out) == przed or od > 50_000:   # koniec albo serwer zignorował firstresult
            return out
        od += strona


def _multipart(pola, plik_nazwa, plik_dane):
    granica = "jarvis" + os.urandom(12).hex()
    czesci = []
    for k, v in pola:
        czesci.append(f'--{granica}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    czesci.append(f'--{granica}\r\nContent-Disposition: form-data; name="document"; filename="{plik_nazwa}"\r\n'
                  f'Content-Type: application/pdf\r\n\r\n'.encode() + plik_dane + b"\r\n")
    czesci.append(f"--{granica}--\r\n".encode())
    return b"".join(czesci), f"multipart/form-data; boundary={granica}"


def _pl_tag(nazwa, cache_tagow):
    if nazwa not in cache_tagow:
        t = next((x for x in _pl_wszystkie("/api/tags/?page_size=100&name__iexact=" + urllib.parse.quote(nazwa))), None)
        cache_tagow[nazwa] = t["id"] if t else _pl("/api/tags/", method="POST", body={"name": nazwa})["id"]
    return cache_tagow[nazwa]


def _nc_stan():
    try:
        with open(NC_PL_STAN, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _nc_stan_zapisz(s):
    tmp = NC_PL_STAN + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False)
    os.replace(tmp, NC_PL_STAN)


def nc_do_paperless(limit=None):
    """Jeden przebieg: sprawdza wysłane wcześniej zadania, wysyła kolejne pliki. Zwraca {dodane, duplikaty, bledy, czeka}."""
    limit = limit or PAPERLESS_PACZKA
    host, _, _ = _nc_baza()
    with _pl_lock:
        stan = _nc_stan()
        wynik = {"dodane": [], "duplikaty": 0, "bledy": [], "czeka": 0}
        tagi_dup = {}
        # 1) zadania wysłane wcześniej: SUCCESS / duplikat = zrobione; FAILURE inne = błąd (spróbuje przy zmianie pliku)
        for href, s in stan.items():
            if s.get("stan") != "wyslane":
                continue
            try:
                t = (_pl(f"/api/tasks/?task_id={s['task']}") or [None])
                t = t[0] if isinstance(t, list) and t else None
            except Exception:  # noqa: BLE001
                continue
            if not t:   # serwer zasnął i zadanie przepadło — wróci do kolejki
                if time.time() - s.get("ts", 0) > 3600:
                    s["stan"] = "nowe"
                continue
            if t.get("status") in ("PENDING", "STARTED") and time.time() - s.get("ts", 0) > 6 * 3600:
                s["stan"] = "nowe"   # serwer wyłączył się w trakcie OCR — wyślemy jeszcze raz (duplikat Paperless odrzuci)
            elif t.get("status") == "SUCCESS":
                s["stan"] = "ok"
                wynik["dodane"].append(s.get("folder", "?"))
            elif t.get("status") == "FAILURE":
                tekst = str(t.get("result") or "")
                s["stan"] = "ok" if "duplicate" in tekst.lower() or "duplikat" in tekst.lower() else "blad"
                if s["stan"] == "ok":
                    wynik["duplikaty"] += 1
                    m = re.search(r"\(#(\d+)\)", tekst)   # już był w Paperlessie — dopisz mu tag folderu
                    if m:
                        try:
                            _pl("/api/documents/bulk_edit/", method="POST", body={
                                "documents": [int(m.group(1))], "method": "add_tag",
                                "parameters": {"tag": _pl_tag(s.get("folder", "Nextcloud"), tagi_dup)}})
                        except Exception as e:  # noqa: BLE001
                            print(f"paperless: tag dla #{m.group(1)}: {e}", flush=True)
                else:
                    s["blad"] = tekst[:200]
                    wynik["bledy"].append(urllib.parse.unquote(href.rsplit("/", 1)[-1]))
        # 2) co jest w Nextcloudzie (nowe albo zmienione = inny etag)
        do_wyslania = []
        for folder in NC_PAPERLESS_FOLDERY:
            for href, p in nc_pdfy(folder).items():
                s = stan.get(href)
                if p["rozmiar"] > 80_000_000:
                    continue
                if not s or (s.get("etag") != p["etag"] and s.get("stan") != "wyslane") or s.get("stan") == "nowe":
                    do_wyslania.append((href, folder, p["etag"]))
        wynik["czeka"] = max(0, len(do_wyslania) - limit)
        tagi = {}
        for href, folder, etag in do_wyslania[:limit]:
            nazwa = urllib.parse.unquote(href.rsplit("/", 1)[-1])
            try:
                dane, _ = zadanie(host + href, headers=basic(NC_USER, NC_PASS), surowe=True, timeout=120)
                body, ct = _multipart([("title", nazwa[:-4][:120]), ("tags", _pl_tag(folder, tagi))], nazwa, dane)
                task = zadanie(PAPERLESS_URL + "/api/documents/post_document/", method="POST", body=body, timeout=120,
                               headers={"Authorization": f"Token {PAPERLESS_TOKEN}", "Content-Type": ct})
                stan[href] = {"etag": etag, "folder": folder, "stan": "wyslane", "task": str(task).strip('"'), "ts": time.time()}
            except Exception as e:  # noqa: BLE001
                wynik["bledy"].append(f"{nazwa}: {e}"[:150])
        _nc_stan_zapisz(stan)
    return wynik


def poczta():
    try:
        with open(MAIL_STAN, encoding="utf-8") as f:
            s = json.load(f)
    except FileNotFoundError:
        return {"disabled": True}
    przyp = sorted(s.get("przypomnienia") or [], key=lambda m: -(m.get("ts") or 0))
    return {"wazne": [{"od": m.get("od"), "temat": m.get("temat"), "konto": str(m.get("konto", "")).split("@")[0], "ts": m.get("ts")}
                      for m in przyp[:12]],
            "zalegle": [{"od": m.get("od"), "temat": m.get("temat")} for m in (s.get("zalegle") or [])[:8]],
            "paczki": [p for p in (s.get("paczki") or []) if time.time() - (p.get("ts") or 0) < 7 * 86400],
            "pominiete": len(s.get("pominiete") or [])}
