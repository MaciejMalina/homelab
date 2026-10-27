"""JARVIS — sterowanie panelem na telefonie z Discorda: /ekran, /panel_alert.

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
from discord.ext import commands

PANEL_URL = os.getenv("PANEL_URL", "http://127.0.0.1:8084").rstrip("/")
PANEL_TOKEN = os.getenv("PANEL_TOKEN", "")
TIMEOUT = aiohttp.ClientTimeout(total=10)


class Panel(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def api(self, sciezka: str, body: dict):
        naglowki = {"X-Panel-Token": PANEL_TOKEN} if PANEL_TOKEN else {}
        async with aiohttp.ClientSession(timeout=TIMEOUT) as s:
            async with s.post(PANEL_URL + sciezka, json=body, headers=naglowki) as r:
                dane = await r.json(content_type=None)
                if r.status >= 400:
                    raise RuntimeError((dane or {}).get("error") or f"HTTP {r.status}")
                return dane

    @app_commands.command(name="ekran", description="Włącza albo wygasza ekran panelu (telefon)")
    @app_commands.describe(stan="włącz / wygaś / auto (dotyk budzi, potem gaśnie)",
                           minuty="Na ile minut włączyć (0 = do odwołania); tylko przy 'włącz'")
    @app_commands.choices(stan=[
        app_commands.Choice(name="włącz", value="on"),
        app_commands.Choice(name="wygaś", value="sleep"),
        app_commands.Choice(name="auto", value="auto"),
    ])
    @app_commands.default_permissions(administrator=True)
    async def ekran(self, interaction: discord.Interaction, stan: app_commands.Choice[str], minuty: int = 10):
        try:
            await self.api("/api/screen", {"mode": stan.value, "minutes": minuty if stan.value == "on" else None})
        except Exception as e:  # noqa: BLE001
            await interaction.response.send_message(f"❌ Panel nie odpowiada: {e}", ephemeral=True)
            return
        opis = {"on": f"włączony{f' na {minuty} min' if minuty else ' do odwołania'}",
                "sleep": "wygaszony", "auto": "w trybie auto"}[stan.value]
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


async def setup(bot):
    await bot.add_cog(Panel(bot))
