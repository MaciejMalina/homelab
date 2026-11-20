"""JARVIS — panel na telefonie: /ekran, /panel_alert, /budzik, /budziki, /budzik_usun + wysyłanie stanu kanałów głosowych
(kto siedzi, wyciszenia) do zakładki "Discord" na panelu.

Rozmawia z kontenerem jarvis_panel na malince (bot i panel chodzą w network_mode: host,
więc domyślnie http://127.0.0.1:8084). W .env bota opcjonalnie:
  PANEL_URL=http://127.0.0.1:8084
  PANEL_TOKEN=...   (ten sam co w .env panelu, jeśli go ustawiłeś)
Włączenie: w main.py dopisz  await self.load_extension("cogs.panel")
"""
import os

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands, tasks

PANEL_URL = os.getenv("PANEL_URL", "http://127.0.0.1:8084").rstrip("/")
PANEL_TOKEN = os.getenv("PANEL_TOKEN", "")
TIMEOUT = aiohttp.ClientTimeout(total=10)


class Panel(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def cog_load(self):
        self.odswiez_glos.start()

    async def cog_unload(self):
        self.odswiez_glos.cancel()

    # ------------------------------------------------------------ kanały głosowe -> panel
    def kanaly_glosowe(self):
        kanaly = []
        for g in self.bot.guilds:
            for ch in list(g.voice_channels) + list(g.stage_channels):
                osoby = []
                for m in ch.members:
                    vs = m.voice
                    if not vs:
                        continue
                    osoby.append({"nazwa": m.display_name, "avatar": str(m.display_avatar.replace(size=64).url),
                                  "mute": bool(vs.self_mute or vs.mute), "deaf": bool(vs.self_deaf or vs.deaf),
                                  "stream": bool(vs.self_stream), "kamera": bool(vs.self_video), "bot": m.bot})
                if osoby:
                    kanaly.append({"serwer": g.name, "kanal": ch.name, "osoby": osoby})
        return kanaly

    async def wyslij_glos(self):
        try:
            await self.api("/api/discord", {"kanaly": self.kanaly_glosowe()})
        except Exception:  # noqa: BLE001  panel wyłączony — spróbujemy przy następnej zmianie
            pass

    @tasks.loop(seconds=60)
    async def odswiez_glos(self):
        await self.wyslij_glos()

    @odswiez_glos.before_loop
    async def przed_petla(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    async def on_voice_state_update(self, member, before, after):
        await self.wyslij_glos()

    async def api(self, sciezka: str, body: dict):
        naglowki = {"X-Panel-Token": PANEL_TOKEN} if PANEL_TOKEN else {}
        async with aiohttp.ClientSession(timeout=TIMEOUT) as s:
            async with s.post(PANEL_URL + sciezka, json=body, headers=naglowki) as r:
                dane = await r.json(content_type=None) if r.status != 204 else None
                if r.status >= 400:
                    raise RuntimeError((dane or {}).get("error") or f"HTTP {r.status}")
                return dane

    async def api_get(self, sciezka: str):
        async with aiohttp.ClientSession(timeout=TIMEOUT) as s:
            async with s.get(PANEL_URL + sciezka) as r:
                dane = await r.json(content_type=None)
                if r.status >= 400:
                    raise RuntimeError((dane or {}).get("error") or f"HTTP {r.status}")
                return dane

    async def lista_budzikow(self):
        return (await self.api_get("/api/tab/budziki")).get("budziki") or []

    @app_commands.command(name="ekran", description="Włącza albo wygasza ekran panelu (telefon)")
    @app_commands.describe(stan="włącz / wygaś / auto (dotyk budzi, potem gaśnie)",
                           minuty="włącz: na ile minut (domyślnie 10, 0 = do odwołania); "
                                  "auto: po ilu minutach bez dotyku gaśnie (zapamiętane)")
    @app_commands.choices(stan=[
        app_commands.Choice(name="włącz", value="on"),
        app_commands.Choice(name="wygaś", value="sleep"),
        app_commands.Choice(name="auto", value="auto"),
    ])
    @app_commands.default_permissions(administrator=True)
    async def ekran(self, interaction: discord.Interaction, stan: app_commands.Choice[str],
                    minuty: app_commands.Range[int, 0, 1440] | None = None):
        if stan.value == "on":
            minuty = 10 if minuty is None else minuty
        elif stan.value == "auto" and minuty == 0:
            await interaction.response.send_message("❌ Przy 'auto' minuty muszą być ≥ 1 (po tylu minutach bez dotyku ekran gaśnie)",
                                                    ephemeral=True)
            return
        try:
            await self.api("/api/screen", {"mode": stan.value, "minutes": minuty if stan.value in ("on", "auto") else None})
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ Panel nie odpowiada: {e}", ephemeral=True)
            return
        opis = {"on": f"włączony{f' na {minuty} min' if minuty else ' do odwołania'}",
                "sleep": "wygaszony",
                "auto": f"w trybie auto — gaśnie po {minuty} min bez dotyku" if minuty else "w trybie auto"}[stan.value]
        await interaction.response.send_message(f"📱 Ekran panelu {opis}", ephemeral=True)

    @app_commands.command(name="panel_alert", description="Wyświetla komunikat na panelu i zapala ekran")
    @app_commands.describe(tekst="Treść komunikatu", poziom="info / uwaga / krytyczny",
                           minuty="Ile minut ekran ma świecić (domyślnie 30)")
    @app_commands.choices(poziom=[
        app_commands.Choice(name="info", value="info"),
        app_commands.Choice(name="uwaga", value="warn"),
        app_commands.Choice(name="krytyczny", value="crit"),
    ])
    @app_commands.default_permissions(administrator=True)
    async def panel_alert(self, interaction: discord.Interaction, tekst: str,
                          poziom: app_commands.Choice[str] | None = None, minuty: int = 30):
        try:
            await self.api("/api/alert", {"text": tekst, "level": poziom.value if poziom else "info", "minutes": minuty})
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ Panel nie odpowiada: {e}", ephemeral=True)
            return
        await interaction.response.send_message(f"📱 Na panelu: {tekst}", ephemeral=True)


    # ------------------------------------------------------------------ budzik na panelu (decyzja 2026-11-20)
    @app_commands.command(name="budzik", description="Nastawia budzik na panelu (telefon przy biurku)")
    @app_commands.describe(godzina="np. 6:30 albo 7", dni="jednorazowy (domyślnie) albo stały na dni tygodnia")
    @app_commands.choices(dni=[
        app_commands.Choice(name="jednorazowy", value="jednorazowy"),
        app_commands.Choice(name="pn–pt", value="pn-pt"),
        app_commands.Choice(name="weekend", value="weekend"),
        app_commands.Choice(name="codziennie", value="codziennie"),
    ])
    @app_commands.default_permissions(administrator=True)
    async def budzik(self, interaction: discord.Interaction, godzina: str, dni: app_commands.Choice[str] | None = None):
        try:
            r = await self.api("/api/budzik", {"godzina": godzina, "dni": dni.value if dni else "jednorazowy", "zrodlo": "Discord"})
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ {e}", ephemeral=True)
            return
        await interaction.response.send_message(f"⏰ {r.get('msg', 'Budzik nastawiony')}", ephemeral=True)

    @app_commands.command(name="budziki", description="Lista budzików na panelu")
    @app_commands.default_permissions(administrator=True)
    async def budziki(self, interaction: discord.Interaction):
        try:
            lista = await self.lista_budzikow()
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ Panel nie odpowiada: {e}", ephemeral=True)
            return
        if not lista:
            await interaction.response.send_message("⏰ Brak budzików. Dodaj: `/budzik godzina:6:30`", ephemeral=True)
            return
        wiersze = [f"**{i}.** {b['h']}:{b['m']:02d} — {b['opis']}"
                   + (f" · dzwoni {b['nastepny_opis']}" if b.get("nastepny") else " · wyłączony")
                   for i, b in enumerate(lista, 1)]
        await interaction.response.send_message("⏰ Budziki:\n" + "\n".join(wiersze) + "\n\nUsuń: `/budzik_usun numer:N`",
                                                ephemeral=True)

    @app_commands.command(name="budzik_usun", description="Usuwa budzik z panelu (numer z /budziki)")
    @app_commands.describe(numer="numer z listy /budziki")
    @app_commands.default_permissions(administrator=True)
    async def budzik_usun(self, interaction: discord.Interaction, numer: app_commands.Range[int, 1, 50]):
        try:
            lista = await self.lista_budzikow()
            if numer > len(lista):
                await interaction.response.send_message(f"❌ Nie ma budzika nr {numer} (jest {len(lista)})", ephemeral=True)
                return
            r = await self.api(f"/api/budzik/{lista[numer - 1]['id']}/usun", {})
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ {e}", ephemeral=True)
            return
        await interaction.response.send_message(f"🗑️ {r.get('msg', 'Usunięty')}", ephemeral=True)


async def setup(bot):
    await bot.add_cog(Panel(bot))
