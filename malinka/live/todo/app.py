#!/usr/bin/env python3
"""JARVIS — szybka lista TO DO (malinka).

Bez zależności (sama biblioteka standardowa). Dane w DATA_DIR/todo.json.
API (JSON, tylko tailnet/LAN — bez logowania, jak Kuma/Trener):
  GET    /api/todos              -> {"tasks": [...]}      (?open=1 — tylko niezrobione, ?lista=zakupy — jedna lista)
  POST   /api/todos              {"title", "due"?, "lista"?, "kto"?}   -> zadanie
  PATCH  /api/todos/<id>         {"title"?, "due"?, "done"?, "lista"?}
  DELETE /api/todos/<id>
  POST   /api/todos/clear-done   {"lista"?} usuwa zrobione (z jednej listy albo ze wszystkich)
  GET    /api/listy              -> {"listy": [{"nazwa", "otwarte", "zrobione"}]}  ("" = lista główna „zadania”)
  POST   /api/listy/wyczysc      {"lista"} usuwa CAŁĄ listę (wszystkie pozycje, jak /todo_wyczysc w Yapass)
Listy (2026-11-20, jak w Yapass-discord-bot): "lista" = nazwa listy małymi literami (np. "zakupy"), "" = główna;
"kto" = skąd dodane (panel, głos, nick z Discorda). Stare zadania bez pola "lista" są na liście głównej.
  GET    /api/health
Termin ("due"): null, "RRRR-MM-DD" albo "RRRR-MM-DDTHH:MM" (czas lokalny, Europe/Warsaw).
Zapisy wymagają Content-Type: application/json — zwykła strona z internetu nie wyśle
takiego żądania bez preflightu CORS, a CORS nie jest włączony (ochrona przed CSRF).
"""
import json
import os
import re
import tempfile
import threading
from datetime import datetime
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("DATA_DIR", "/data")
PLIK = os.path.join(DATA_DIR, "todo.json")
PORT = int(os.environ.get("PORT", "8080"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "index.html")
MAX_TYTUL = 300
MAX_ZADAN = 1000
DUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")

lock = threading.Lock()


def wczytaj():
    try:
        with open(PLIK, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("tasks"), list):
            d.setdefault("next_id", max([t.get("id", 0) for t in d["tasks"]] + [0]) + 1)
            return d
    except FileNotFoundError:
        pass
    return {"next_id": 1, "tasks": []}


def zapisz(d):
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=".todo-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, PLIK)  # atomowo — przerwany zapis nie psuje listy


def teraz():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def sprawdz_due(v):
    if v in (None, ""):
        return None
    if not isinstance(v, str) or not DUE_RE.match(v):
        raise ValueError("due: oczekiwano RRRR-MM-DD albo RRRR-MM-DDTHH:MM")
    datetime.fromisoformat(v)  # odrzuca np. 2026-02-31
    return v


def sprawdz_tytul(v):
    if not isinstance(v, str) or not v.strip():
        raise ValueError("title: puste")
    return " ".join(v.split())[:MAX_TYTUL]


def sprawdz_liste(v):
    if v in (None, ""):
        return ""
    if not isinstance(v, str):
        raise ValueError("lista: oczekiwano tekstu")
    v = " ".join(re.sub(r"[^\w \-]", "", v.lower()).split())[:40]
    return "" if v in ("zadania", "glowna", "główna") else v


def z_lista(t):
    t.setdefault("lista", "")
    return t


def klucz_sort(t):
    # niezrobione najpierw; z terminem przed bez terminu; potem wg terminu i kolejności dodania
    return (t["done"], t["due"] is None, t["due"] or "", t["id"])


class H(BaseHTTPRequestHandler):
    server_version = "jarvis-todo/1.0"

    def log_message(self, fmt, *args):  # ciszej w `docker logs` — tylko błędy
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
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
        n = int(self.headers.get("Content-Length") or 0)
        if n > 16384:
            raise ValueError("za duże żądanie")
        d = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(d, dict):
            raise ValueError("oczekiwano obiektu JSON")
        return d

    def sciezka(self):
        p = self.path.split("?", 1)
        return p[0].rstrip("/") or "/", (p[1] if len(p) > 1 else "")

    def id_z(self, sc):
        m = re.fullmatch(r"/api/todos/(\d+)", sc)
        return int(m.group(1)) if m else None

    def obsluz(self, fn):
        try:
            fn()
        except PermissionError as e:
            self.blad(415, str(e))
        except (ValueError, json.JSONDecodeError) as e:
            self.blad(400, str(e))
        except Exception as e:  # noqa: BLE001
            self.blad(500, f"{type(e).__name__}: {e}")

    # ---------- GET ----------
    def do_GET(self):
        self.obsluz(self._get)

    do_HEAD = do_GET

    def _get(self):
        sc, q = self.sciezka()
        if sc in ("/", "/index.html"):
            with open(STATIC, "rb") as f:
                return self.odpowiedz(200, typ="text/html; charset=utf-8", body=f.read())
        if sc == "/api/health":
            return self.odpowiedz(200, {"ok": True})
        if sc == "/api/todos":
            with lock:
                tasks = [z_lista(t) for t in sorted(wczytaj()["tasks"], key=klucz_sort)]
            if re.search(r"(^|&)open=(1|true)", q):
                tasks = [t for t in tasks if not t["done"]]
            if "lista" in (p := parse_qs(q, keep_blank_values=True)) and p["lista"][0] != "*":
                lista = sprawdz_liste(p["lista"][0])
                tasks = [t for t in tasks if t["lista"] == lista]
            return self.odpowiedz(200, {"tasks": tasks})
        if sc == "/api/listy":
            with lock:
                tasks = [z_lista(t) for t in wczytaj()["tasks"]]
            listy = {"": {"nazwa": "", "otwarte": 0, "zrobione": 0}}
            for t in tasks:
                w = listy.setdefault(t["lista"], {"nazwa": t["lista"], "otwarte": 0, "zrobione": 0})
                w["zrobione" if t["done"] else "otwarte"] += 1
            return self.odpowiedz(200, {"listy": sorted(listy.values(), key=lambda x: (x["nazwa"] != "", x["nazwa"]))})
        self.blad(404, "nie ma")

    # ---------- POST ----------
    def do_POST(self):
        self.obsluz(self._post)

    def _post(self):
        sc, _ = self.sciezka()
        if sc == "/api/todos":
            b = self.cialo()
            t = {"id": 0, "title": sprawdz_tytul(b.get("title")), "due": sprawdz_due(b.get("due")),
                 "done": False, "created": teraz(), "done_at": None, "lista": sprawdz_liste(b.get("lista")),
                 "kto": " ".join(str(b.get("kto") or "").split())[:40] or None}
            with lock:
                d = wczytaj()
                if len(d["tasks"]) >= MAX_ZADAN:
                    raise ValueError("za dużo zadań — wyczyść zrobione")
                t["id"] = d["next_id"]
                d["next_id"] += 1
                d["tasks"].append(t)
                zapisz(d)
            return self.odpowiedz(201, t)
        if sc == "/api/todos/clear-done":
            b = self.cialo()
            jedna = "lista" in b
            lista = sprawdz_liste(b.get("lista"))
            with lock:
                d = wczytaj()
                przed = len(d["tasks"])
                d["tasks"] = [t for t in d["tasks"] if not (t["done"] and (not jedna or t.get("lista", "") == lista))]
                zapisz(d)
            return self.odpowiedz(200, {"removed": przed - len(d["tasks"])})
        if sc == "/api/listy/wyczysc":
            b = self.cialo()
            if "lista" not in b:
                raise ValueError("lista: wymagana (\"\" = lista główna)")
            lista = sprawdz_liste(b.get("lista"))
            with lock:
                d = wczytaj()
                przed = len(d["tasks"])
                d["tasks"] = [t for t in d["tasks"] if t.get("lista", "") != lista]
                zapisz(d)
            return self.odpowiedz(200, {"removed": przed - len(d["tasks"])})
        self.blad(404, "nie ma")

    # ---------- PATCH ----------
    def do_PATCH(self):
        self.obsluz(self._patch)

    def _patch(self):
        sc, _ = self.sciezka()
        tid = self.id_z(sc)
        if tid is None:
            return self.blad(404, "nie ma")
        b = self.cialo()
        with lock:
            d = wczytaj()
            t = next((x for x in d["tasks"] if x["id"] == tid), None)
            if not t:
                return self.blad(404, f"brak zadania {tid}")
            if "title" in b:
                t["title"] = sprawdz_tytul(b["title"])
            if "due" in b:
                t["due"] = sprawdz_due(b["due"])
            if "lista" in b:
                t["lista"] = sprawdz_liste(b["lista"])
            if "done" in b:
                nowe = bool(b["done"])
                if nowe != t["done"]:
                    t["done"], t["done_at"] = nowe, (teraz() if nowe else None)
            zapisz(d)
        return self.odpowiedz(200, z_lista(t))

    # ---------- DELETE ----------
    def do_DELETE(self):
        self.obsluz(self._delete)

    def _delete(self):
        sc, _ = self.sciezka()
        tid = self.id_z(sc)
        if tid is None:
            return self.blad(404, "nie ma")
        with lock:
            d = wczytaj()
            n = len(d["tasks"])
            d["tasks"] = [t for t in d["tasks"] if t["id"] != tid]
            if len(d["tasks"]) == n:
                return self.blad(404, f"brak zadania {tid}")
            zapisz(d)
        return self.odpowiedz(204)


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    print(f"jarvis-todo: port {PORT}, dane {PLIK}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
