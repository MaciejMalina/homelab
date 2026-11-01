#!/usr/bin/env python3
"""Spójna kopia bazy Vaultwardena (SQLite) przed dziennym backupem o 7:30.
Kopiowanie działającej bazy rsync-iem może dać uszkodzony plik — sqlite3.backup() robi spójny zrzut.
Cron macmal na malince:  20 7 * * * /usr/bin/python3 /home/macmal/vaultwarden/kopia-bazy.py"""
import os, sqlite3, sys
KAT = "/home/macmal/vaultwarden/data"
zrodlo, cel = os.path.join(KAT, "db.sqlite3"), os.path.join(KAT, "db-kopia.sqlite3")
if not os.path.exists(zrodlo):
    sys.exit(f"brak {zrodlo}")
tmp = cel + ".tmp"
s, d = sqlite3.connect(zrodlo), sqlite3.connect(tmp)
with d:
    s.backup(d)
d.close(); s.close()
os.replace(tmp, cel)
