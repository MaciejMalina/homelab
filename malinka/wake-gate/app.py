#!/usr/bin/env python3
"""
MALINKA — wake-gate dla Jellyfina na serwerze.

Serwer spi (idle-shutdown) i budzi sie przez WoL - ten mini-serwis stoi na
malince (zawsze wlaczona), sluchamy na porcie z konfiguracji, i:
  - jesli serwer juz odpowiada na porcie Jellyfina -> 302 na TARGET_URL,
  - jesli nie -> wysylamy magic packet (WoL, z cooldownem zeby nie zalewac
    sieci) i pokazujemy strone z auto-odswiezaniem co 5s.

Ten sam SERVER_IP/SERVER_MAC co malinka/nightly-backup.sh (192.168.254.11,
4c:cc:6a:4a:33:6d) - jesli te wartosci sie kiedys zmienia, zaktualizuj w OBU
miejscach (nie ma wspolnego pliku configu, to swiadomy uproszczony wybor).
"""
import os
import socket
import time
from flask import Flask, redirect, Response

app = Flask(__name__)

SERVER_IP = os.environ.get("SERVER_IP", "192.168.254.11")
SERVER_MAC = os.environ.get("SERVER_MAC", "4c:cc:6a:4a:33:6d")
CHECK_PORT = int(os.environ.get("CHECK_PORT", "8096"))
TARGET_URL = os.environ.get("TARGET_URL", "https://serwer.CHANGE-ME.ts.net:8096")
WOL_COOLDOWN_SECONDS = int(os.environ.get("WOL_COOLDOWN_SECONDS", "30"))
CONNECT_TIMEOUT = 2.0

_last_wol_ts = 0.0


def is_server_up() -> bool:
    try:
        with socket.create_connection((SERVER_IP, CHECK_PORT), timeout=CONNECT_TIMEOUT):
            return True
    except OSError:
        return False


def send_wol(mac: str) -> None:
    mac_bytes = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    packet = b"\xff" * 6 + mac_bytes * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.sendto(packet, ("255.255.255.255", 9))


WAITING_PAGE = """<!doctype html>
<html lang="pl"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>Budze serwer...</title>
<style>
body{{font-family:sans-serif;background:#111;color:#eee;display:flex;
     align-items:center;justify-content:center;height:100vh;margin:0}}
div{{text-align:center}}
</style></head>
<body><div>
<h1>Budze serwer...</h1>
<p>Jellyfin startuje na serwerze fizycznym, ktory byl usypiany.
To zwykle 2-5 minut. Strona odswieza sie sama co 5 sekund.</p>
<p><small>WoL wyslany do {mac}</small></p>
</div></body></html>"""


@app.route("/")
def index():
    global _last_wol_ts
    if is_server_up():
        return redirect(TARGET_URL, code=302)

    now = time.time()
    if now - _last_wol_ts > WOL_COOLDOWN_SECONDS:
        send_wol(SERVER_MAC)
        _last_wol_ts = now

    return Response(WAITING_PAGE.format(mac=SERVER_MAC), mimetype="text/html")


@app.route("/health")
def health():
    return "ok"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8098")))
