"""JARVIS — lista TO DO z Discorda: /zadanie, /zadania, /zrobione.

Rozmawia z kontenerem jarvis_todo na malince (bot chodzi w network_mode: host,
więc domyślnie http://127.0.0.1:8083). Inny adres: TODO_URL w .env bota.
"""
import os
import re
from datetime import date, datetime, timedelta

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands

TODO_URL = os.getenv("TODO_URL", "http://127.0.0.1:8083").rstrip("/")
TIMEOUT = aiohttp.ClientTimeout(total=10)

DNI = {"pn": 0, "pon": 0, "poniedziałek": 0, "poniedzialek": 0,
       "wt": 1, "wto": 1, "wtorek": 1,
       "śr": 2, "sr": 2, "śro": 2, "sro": 2, "środa": 2, "sroda": 2, "środę": 2, "srode": 2,
       "cz": 3, "czw": 3, "czwartek": 3,
       "pt": 4, "pią": 4, "pia": 4, "piątek": 4, "piatek": 4,
       "sb": 5, "sob": 5, "sobota": 5, "sobotę": 5, "sobote": 5,
       "nd": 6, "ndz": 6, "niedziela": 6, "niedzielę": 6, "niedziele": 6}
SKROT_DNIA = ["pn", "wt", "śr", "cz", "pt", "sb", "nd"]


def _data(r: int, m: int, d: int) -> date:
    try:
        return date(r, m, d)
    except ValueError:
        raise ValueError(f"nie ma takiej daty: {d:02d}.{m:02d}.{r}") from None


def parsuj_termin(tekst: str, dzis: date | None = None) -> str | None:
    """'jutro 18:00', 'pt', 'w piątek 9', '30.10', '30.10.2026 7:30', '2026-10-30' -> 'RRRR-MM-DD[THH:MM]'.
    Pusty tekst -> None. Nierozpoznany -> ValueError."""
    t = " ".join((tekst or "").lower().split())
    if not t:
        return None
    dzis = dzis or date.today()
    godz = None
    m = re.search(r"(?:^|\s)(?:o\s+|godz\.?\s*)?(\d{1,2})(?::(\d{2}))?$", t)
    # sama liczba na końcu to godzina tylko wtedy, gdy przed nią jest coś (np. "jutro 18"), albo ma minuty
    if m and (m.group(2) or t[:m.start()].strip()):
        h, mi = int(m.group(1)), int(m.group(2) or 0)
        if h > 23 or mi > 59:
            raise ValueError("zła godzina")
        godz = f"{h:02d}:{mi:02d}"
        t = t[:m.start()].strip()
    t = re.sub(r"^(w|we|na)\s+", "", t)
    if t in ("", "dziś", "dzis", "dzisiaj"):
        d = dzis
    elif t == "jutro":
        d = dzis + timedelta(days=1)
    elif t == "pojutrze":
        d = dzis + timedelta(days=2)
    elif t in DNI:
        d = dzis + timedelta(days=(DNI[t] - dzis.weekday()) % 7)
    elif m2 := re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", t):
        d = _data(int(m2.group(1)), int(m2.group(2)), int(m2.group(3)))
    elif m2 := re.fullmatch(r"(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?", t):
        dd, mm = int(m2.group(1)), int(m2.group(2))
        if m2.group(3):
            rr = int(m2.group(3))
            d = _data(rr + 2000 if rr < 100 else rr, mm, dd)
        else:
            d = _data(dzis.year, mm, dd)
            if d < dzis - timedelta(days=60):   # "5.01" w grudniu = przyszły rok
                d = _data(dzis.year + 1, mm, dd)
    else:
        raise ValueError(f"nie rozumiem terminu „{tekst}”")
    return d.isoformat() + (f"T{godz}" if godz else "")


def opis_terminu(due: str | None) -> str:
    if not due:
        return ""
    d = date.fromisoformat(due[:10])
    dzis = date.today()
    txt = "dziś" if d == dzis else "jutro" if d == dzis + timedelta(days=1) else f"{SKROT_DNIA[d.weekday()]} {d:%d.%m}"
    if "T" in due:
        txt += " " + due[11:16]
    koniec = datetime.fromisoformat(due) if "T" in due else datetime.combine(d, datetime.max.time())
    return f" — ⚠️ {txt}" if koniec < datetime.now() else f" — {txt}"


class Todo(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def api(self, metoda: str, sciezka: str, json=None):
        async with aiohttp.ClientSession(timeout=TIMEOUT) as s:
            async with s.request(metoda, TODO_URL + sciezka, json=json) as r:
                dane = await r.json(content_type=None) if r.status != 204 else None
                if r.status >= 400:
                    raise RuntimeError((dane or {}).get("error") or f"HTTP {r.status}")
                return dane

    @app_commands.command(name="zadanie", description="Dodaje zadanie do listy TO DO")
    @app_commands.describe(tresc="Co trzeba zrobić",
                           termin="Opcjonalnie: dziś / jutro / pt / 30.10 / jutro 18:00")
    @app_commands.default_permissions(administrator=True)
    async def zadanie(self, interaction: discord.Interaction, tresc: str, termin: str | None = None):
        try:
            due = parsuj_termin(termin) if termin else None
        except ValueError as e:
            await interaction.response.send_message(f"❌ {e}. Przykłady: `jutro`, `pt 9:00`, `30.10`, `2026-11-05 18:00`.", ephemeral=True)
            return
        try:
            t = await self.api("POST", "/api/todos", {"title": tresc, "due": due})
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ Lista TO DO nie odpowiada: {e}", ephemeral=True)
            return
        await interaction.response.send_message(f"📝 Dodane **#{t['id']}** {t['title']}{opis_terminu(t['due'])}")

    @app_commands.command(name="zadania", description="Pokazuje listę TO DO (niezrobione)")
    @app_commands.default_permissions(administrator=True)
    async def zadania(self, interaction: discord.Interaction):
        try:
            tasks = (await self.api("GET", "/api/todos?open=1"))["tasks"]
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ Lista TO DO nie odpowiada: {e}", ephemeral=True)
            return
        if not tasks:
            await interaction.response.send_message("Nic do zrobienia 🎉", ephemeral=True)
            return
        linie, dl = [], 0
        for t in tasks:
            l = f"`#{t['id']}` {t['title']}{opis_terminu(t['due'])}"
            if dl + len(l) > 1850:
                linie.append(f"…i {len(tasks) - len(linie)} więcej")
                break
            linie.append(l)
            dl += len(l) + 1
        await interaction.response.send_message(
            f"**Do zrobienia ({len(tasks)}):**\n" + "\n".join(linie) + "\n\nOdhacz: `/zrobione numer:`", ephemeral=True)

    @app_commands.command(name="zrobione", description="Oznacza zadanie z listy TO DO jako zrobione")
    @app_commands.describe(numer="Numer zadania (#) z /zadania")
    @app_commands.default_permissions(administrator=True)
    async def zrobione(self, interaction: discord.Interaction, numer: int):
        try:
            t = await self.api("PATCH", f"/api/todos/{numer}", {"done": True})
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ {e}", ephemeral=True)
            return
        await interaction.response.send_message(f"✅ Zrobione: ~~{t['title']}~~")


async def setup(bot):
    await bot.add_cog(Todo(bot))
