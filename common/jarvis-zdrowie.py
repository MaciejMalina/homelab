#!/usr/bin/env python3
"""JARVIS — cotygodniowe aktualizacje kontenerów + dane do raportu zdrowia (ten sam skrypt na malince i serwerze).

Cron (root, /etc/cron.d/jarvis-zdrowie — instaluje common/instaluj-zdrowie.sh):
  malinka: sobota 9:55 WoL serwera (panel), 10:00 ten skrypt;  serwer: sobota 10:05 ten skrypt.
Wynik idzie do panelu na malince (POST /api/zdrowie/raport); panel składa z obu maszyn jeden raport na Discordzie.

  jarvis-zdrowie.py             aktualizuje kontenery (poza WYJATKI), sprawdza zdrowie, wysyła wynik
  jarvis-zdrowie.py --sprawdz   NIC nie zmienia: tylko sprawdza nowe wersje (bez pobierania) + zdrowie, wysyła wynik

Zasady (decyzje 2026-11-20):
  - aktualizowane są kontenery z obrazów z rejestru; obrazy budowane lokalnie (build: / *:local) — pomijane
  - WYJATKI (Nextcloud + bazy, AdGuard + NPM, Vaultwarden, Paperless + paperless-gpt) — bez aktualizacji, w raporcie
    tylko „jest nowa wersja” (porównanie skrótu w rejestrze, bez pobierania)
  - przed aktualizacją stary obraz dostaje tag jarvis-rollback/<kontener>:prev; jeśli kontener w CZEKAJ_S nie jest
    zdrowy (healthy albo działa stabilnie STABILNY_S bez restartów) — wraca na stary obraz
  - kontenery w sieci innego (network_mode: container:, np. qbittorrent przez gluetun) są odtwarzane, gdy ich
    „gospodarz” dostał nowy kontener
  - na serwerze na czas pracy plik /run/jarvis-no-shutdown blokuje idle-shutdown
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

WYJATKI = {"nextcloud", "nextcloud_db", "nextcloud_redis", "backend_postgres", "backend_qdrant",
           "paperless", "paperless_db", "paperless_broker", "paperless_gpt",
           "adguardhome", "nginx_proxy_manager", "vaultwarden"}
PANEL = os.environ.get("JARVIS_PANEL", "http://192.168.254.10:8084")
CZEKAJ_S = 300
STABILNY_S = 60
LOCK = "/run/jarvis-no-shutdown"
LOG = "/var/log/jarvis-zdrowie.log"
BACKUP_LOGI = ["/var/log/jarvis-backup.log", "/home/macmal/backup.log"]
DYSKI = ["/", "/mnt/data"]
SPRAWDZ = "--sprawdz" in sys.argv


def log(m):
    linia = time.strftime("%Y-%m-%d %H:%M:%S ") + m
    print(linia, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(linia + "\n")
    except OSError:
        pass


def sh(*cmd, timeout=600, cwd=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout {timeout} s"


# ------------------------------------------------------------------ docker
def kontenery():
    _, ids, _ = sh("docker", "ps", "-aq", "--no-trunc")
    if not ids:
        return []
    _, out, _ = sh("docker", "inspect", *ids.split())
    return json.loads(out or "[]")


def nazwa(c):
    return c["Name"].lstrip("/")


def projekt(c):
    lab = c["Config"].get("Labels") or {}
    if not lab.get("com.docker.compose.project"):
        return None
    return {"nazwa": lab["com.docker.compose.project"], "katalog": lab.get("com.docker.compose.project.working_dir", ""),
            "pliki": [p for p in (lab.get("com.docker.compose.project.config_files") or "").split(",") if p],
            "usluga": lab.get("com.docker.compose.service", "")}


def compose(p, *args, timeout=900):
    cmd = ["docker", "compose", "-p", p["nazwa"], "--project-directory", p["katalog"]]
    for f in p["pliki"]:
        cmd += ["-f", f]
    return sh(*cmd, *args, timeout=timeout, cwd=p["katalog"] or None)


_konfig = {}


def uslugi(p):
    """services z `docker compose config` (żeby wiedzieć, co ma build: i jaki jest obraz)."""
    k = p["nazwa"]
    if k not in _konfig:
        rc, out, err = compose(p, "config", "--format", "json", timeout=60)
        _konfig[k] = (json.loads(out).get("services") or {}) if rc == 0 and out else None
        if rc != 0:
            log(f"{k}: compose config nie działa: {err[:200]}")
    return _konfig[k]


def wersja(obraz):
    rc, out, _ = sh("docker", "image", "inspect", "-f",
                    '{{index .Config.Labels "org.opencontainers.image.version"}}', obraz, timeout=30)
    return out if rc == 0 and out and out != "<no value>" else None


def limit_hub(err):
    return "429" in err or "toomanyrequests" in err.lower()


def zdalny_digest(ref):
    """(skrót w rejestrze albo None, błąd). Zapytanie HEAD — nie pobiera obrazu."""
    rc, out, err = sh("docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest.Digest}}", timeout=90)
    try:
        return (json.loads(out), "") if rc == 0 and out else (None, err or out)
    except json.JSONDecodeError:
        return None, out


def lokalne_digesty(obraz_id):
    rc, out, _ = sh("docker", "image", "inspect", "-f", "{{json .RepoDigests}}", obraz_id, timeout=30)
    try:
        return {d.split("@", 1)[1] for d in json.loads(out or "[]") if "@" in d} if rc == 0 else set()
    except json.JSONDecodeError:
        return set()


def zdrowy(n):
    """(True, opis) gdy kontener działa: healthy, albo bez healthchecka stabilnie STABILNY_S bez restartów."""
    start, rc0, od, ost = time.time(), None, None, "brak kontenera"
    while time.time() - start < CZEKAJ_S:
        rc, out, _ = sh("docker", "inspect", "-f", "{{json .State}}|{{.RestartCount}}", n, timeout=30)
        if rc == 0 and "|" in out:
            st_s, rcnt = out.rsplit("|", 1)
            st, rcnt = json.loads(st_s), int(rcnt)
            h = (st.get("Health") or {}).get("Status")
            ost = h or st.get("Status") or "?"
            if st.get("Running") and not st.get("Restarting"):
                if h == "healthy":
                    return True, "healthy"
                if h is None:
                    if rc0 is None or rcnt != rc0:
                        rc0, od = rcnt, time.time()
                    elif time.time() - od >= STABILNY_S:
                        return True, "działa"
            else:
                od = None
        time.sleep(5)
    return False, f"po {CZEKAJ_S // 60} min: {ost}"


def odtworz_zalezne():
    """Kontenery w sieci innego kontenera (network_mode: container:<id>), którego już nie ma -> odtwórz."""
    zywe = {c["Id"] for c in kontenery() if c["State"].get("Running")}
    for c in kontenery():
        nm = c["HostConfig"].get("NetworkMode") or ""
        if nm.startswith("container:") and nm.split(":", 1)[1] not in zywe and c["State"].get("Running") is not None:
            p = projekt(c)
            if p:
                rc, _, err = compose(p, "up", "-d", "--force-recreate", "--no-deps", p["usluga"])
                log(f"{nazwa(c)}: odtworzony (sieć gospodarza się zmieniła) rc={rc} {err[-200:] if rc else ''}")


# ------------------------------------------------------------------ aktualizacje
def aktualizacje():
    wynik = {"zaktualizowane": [], "wycofane": [], "nowe_wyjatki": [], "nowe": [], "lokalne": [], "bledy": [], "limit_hub": []}
    do_akt = {}   # projekt -> [(kontener, usluga, ref, stary_id)]
    projekty = {}
    for c in kontenery():
        n = nazwa(c)
        if not c["State"].get("Running"):
            continue
        p = projekt(c)
        cfg = uslugi(p) if p else None
        scfg = (cfg or {}).get(p["usluga"], {}) if p else {}
        if "build" in scfg or str(scfg.get("image") or c["Config"]["Image"]).endswith(":local"):
            wynik["lokalne"].append(n)
            continue
        ref = scfg.get("image") or c["Config"]["Image"]
        if ref.startswith("sha256:") or not p:
            wynik["bledy"].append(f"{n}: nie wiem, z jakiego obrazu ({ref[:20]}) albo poza compose — pomijam")
            continue
        # najpierw skrót z rejestru (HEAD): pobieramy tylko to, co się zmieniło — Docker Hub ma niski limit zapytań
        zd, err = zdalny_digest(ref)
        if zd is None:
            if limit_hub(err):
                wynik["limit_hub"].append(n)
            else:
                wynik["bledy"].append(f"{n}: nie udało się sprawdzić {ref} w rejestrze: {err[-120:]}")
            continue
        if zd in lokalne_digesty(c["Image"]):
            continue
        if SPRAWDZ or n in WYJATKI:
            (wynik["nowe_wyjatki"] if n in WYJATKI else wynik["nowe"]).append({"nazwa": n, "ref": ref})
            continue
        rc, _, err = sh("docker", "pull", "-q", ref, timeout=1800)
        if rc != 0:
            if limit_hub(err):
                wynik["limit_hub"].append(n)
            else:
                wynik["bledy"].append(f"{n}: docker pull {ref}: {err[-160:]}")
            continue
        rc, nowy, _ = sh("docker", "image", "inspect", "-f", "{{.Id}}", ref, timeout=30)
        if rc == 0 and nowy and nowy != c["Image"]:
            projekty[p["nazwa"]] = p
            do_akt.setdefault(p["nazwa"], []).append((n, p["usluga"], ref, c["Image"]))
    for pn, lista in do_akt.items():
        p = projekty[pn]
        for n, _, _, stary in lista:
            sh("docker", "tag", stary, f"jarvis-rollback/{n}:prev", timeout=30)
        rc, _, err = compose(p, "up", "-d", *[u for _, u, _, _ in lista])
        if rc != 0:
            wynik["bledy"].append(f"{pn}: compose up: {err[-200:]}")
        odtworz_zalezne()
        for n, u, ref, stary in lista:
            ok, opis = zdrowy(n)
            z, na = wersja(stary), wersja(ref)
            if ok:
                wynik["zaktualizowane"].append({"nazwa": n, "ref": ref, "z": z, "na": na})
                log(f"{n}: zaktualizowany {z or '?'} -> {na or '?'} ({opis})")
                continue
            log(f"{n}: po aktualizacji niezdrowy ({opis}) — wracam do poprzedniego obrazu")
            sh("docker", "tag", f"jarvis-rollback/{n}:prev", ref, timeout=30)
            rc2, _, err2 = compose(p, "up", "-d", u)
            odtworz_zalezne()
            ok2, opis2 = zdrowy(n)
            wynik["wycofane"].append({"nazwa": n, "ref": ref, "na": na, "powod": opis, "przywrocony": ok2,
                                      "stan": opis2 if ok2 else f"{opis2} {err2[-120:] if rc2 else ''}".strip()})
    if not SPRAWDZ:
        rc, out, _ = sh("docker", "image", "prune", "-f", timeout=600)
        wynik["odzyskane"] = next((l.split(":", 1)[1].strip() for l in out.splitlines() if "reclaimed" in l.lower()), None)
    return wynik


# ------------------------------------------------------------------ zdrowie
def zdrowie():
    z = {"dyski": [], "smart": [], "backup": [], "zatrzymane": [], "niezdrowe": []}
    for m in DYSKI:
        if os.path.ismount(m) or m == "/":
            u = shutil.disk_usage(m)
            z["dyski"].append({"punkt": m, "proc": round(100 * u.used / u.total), "wolne_gb": round(u.free / 1e9)})
    if shutil.which("smartctl"):
        rc, out, _ = sh("smartctl", "--scan", timeout=30)
        for linia in out.splitlines():
            dev = linia.split()[0] if linia.strip() else None
            if not dev:
                continue
            typ = linia.split("-d", 1)[1].split()[0] if " -d " in linia else "auto"
            rc, o, _ = sh("smartctl", "-H", "-d", typ, dev, timeout=60)
            stan = next((l.split(":", 1)[1].strip() for l in o.splitlines() if "overall-health" in l or "Health Status" in l), None)
            z["smart"].append({"dysk": dev, "stan": stan or "brak odczytu"})
    for plik in BACKUP_LOGI:
        if os.path.exists(plik):
            try:
                with open(plik, encoding="utf-8", errors="replace") as f:
                    ost = [l.strip() for l in f.readlines()[-400:] if l.strip()]
                z["backup"].append({"log": plik, "zmieniony": os.path.getmtime(plik), "ostatnia": ost[-1][:160] if ost else ""})
            except OSError as e:
                z["backup"].append({"log": plik, "blad": str(e)[:100]})
    for c in kontenery():
        st = c["State"]
        h = (st.get("Health") or {}).get("Status")
        if not st.get("Running"):
            z["zatrzymane"].append(f"{nazwa(c)} ({st.get('Status')}, kod {st.get('ExitCode')})")
        elif h == "unhealthy" or st.get("Restarting"):
            z["niezdrowe"].append(f"{nazwa(c)} ({h or 'restartuje'})")
    rc, out, _ = sh("apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade", timeout=180)
    inst = [l for l in out.splitlines() if l.startswith("Inst ")]
    z["apt"] = {"pakiety": len(inst), "bezpieczenstwo": sum("security" in l for l in inst)} if rc == 0 else None
    try:
        z["uptime_h"] = round(float(open("/proc/uptime").read().split()[0]) / 3600, 1)
        z["temp"] = round(int(open("/sys/class/thermal/thermal_zone0/temp").read()) / 1000)
    except (OSError, ValueError):
        pass
    z["load"] = [round(x, 2) for x in os.getloadavg()]
    return z


def main():
    t0 = time.time()
    blokada = os.path.isdir(os.path.dirname(LOCK)) and not os.path.exists(LOCK) and os.access(os.path.dirname(LOCK), os.W_OK)
    if blokada:
        open(LOCK, "w").write("jarvis-zdrowie\n")
    try:
        log(f"start ({'tylko sprawdzanie' if SPRAWDZ else 'aktualizacja'})")
        wynik = {"host": socket.gethostname(), "tryb": "sprawdz" if SPRAWDZ else "aktualizacja", "ts": time.time()}
        try:
            wynik.update(aktualizacje())
        except Exception as e:  # noqa: BLE001  raport ma pójść mimo błędu
            wynik["bledy"] = [f"aktualizacje: {type(e).__name__}: {e}"[:300]]
            log(wynik["bledy"][0])
        wynik.update(zdrowie())
        wynik["czas_s"] = round(time.time() - t0)
    finally:
        if blokada and os.path.exists(LOCK):
            os.remove(LOCK)
    try:
        req = urllib.request.Request(f"{PANEL}/api/zdrowie/raport", data=json.dumps(wynik).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=20).read()
        log(f"koniec, wynik w panelu ({wynik['czas_s']} s)")
    except Exception as e:  # noqa: BLE001
        log(f"koniec, panel nie odebrał wyniku: {e}")
        print(json.dumps(wynik, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
