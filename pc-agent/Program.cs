// JARVIS Agent — Windows (laptop i gaming PC). Panel na malince pyta go o czujniki, audio i multimedia
// oraz wysyła polecenia (uśpij/wyłącz, głośność, play/pauza, wycisz w Discordzie).
// Dostęp: tylko adresy z agent.json → DozwoloneIp + nagłówek X-Agent-Token. Do tego reguła zapory (install.ps1).
using System.Net;
using System.Text.Json;
using JarvisAgent;

var cfg = Konfiguracja.Wczytaj();
Log.Zapisz($"Start {cfg.Nazwa}, port {cfg.Port}");

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = Konfiguracja.Katalog,
});
builder.Logging.ClearProviders();
builder.WebHost.UseUrls($"http://0.0.0.0:{cfg.Port}");
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
builder.Services.AddSingleton(new Sprzet(cfg.PingHost));
builder.Services.AddSingleton(new DiscordRpc(cfg));

var app = builder.Build();
app.Services.GetRequiredService<DiscordRpc>().Start();

// ------------------------------------------------------------------ bramka: IP + token
app.Use(async (ctx, next) =>
{
    var ip = ctx.Connection.RemoteIpAddress ?? IPAddress.None;
    if (!cfg.CzyDozwolone(ip))
    {
        Log.Zapisz($"Odrzucono {ip} {ctx.Request.Path}");
        ctx.Response.StatusCode = 403;
        return;
    }
    if (!cfg.CzyDobryToken(ctx.Request.Headers["X-Agent-Token"]))
    {
        ctx.Response.StatusCode = 401;
        return;
    }
    try
    {
        await next();
    }
    catch (ArgumentException e)
    {
        ctx.Response.StatusCode = 400;
        await ctx.Response.WriteAsJsonAsync(new { error = e.Message });
    }
    catch (InvalidOperationException e)
    {
        ctx.Response.StatusCode = 409;
        await ctx.Response.WriteAsJsonAsync(new { error = e.Message });
    }
    catch (Exception e)
    {
        Log.Zapisz($"{ctx.Request.Method} {ctx.Request.Path}: {e}");
        ctx.Response.StatusCode = 500;
        await ctx.Response.WriteAsJsonAsync(new { error = $"{e.GetType().Name}: {e.Message}" });
    }
});

// ------------------------------------------------------------------ odczyt
app.MapGet("/api/health", () => Results.Json(new { ok = true, nazwa = cfg.Nazwa, wersja = "1.0" }));

app.MapGet("/api/stan", (Sprzet s) =>
{
    var st = s.Stan;
    var moc = (st.Cpu?.Moc ?? 0) + (st.Gpu?.Moc ?? 0);
    return Results.Json(new
    {
        nazwa = cfg.Nazwa,
        host = Environment.MachineName,
        uptimeS = Environment.TickCount64 / 1000,
        cpu = st.Cpu,
        gpu = st.Gpu,
        ramUzyteGb = st.RamUzyteGb,
        ramRazemGb = st.RamRazemGb,
        dyski = st.Dyski,
        pingMs = st.PingMs,
        mocW = moc > 0 ? (float?)moc : null,
        odczyt = st.Odczyt,
    });
});

app.MapGet("/api/audio", () => Results.Json(Dzwiek.Stan()));
app.MapGet("/api/media", async () => Results.Json(await Media.Stan()));
app.MapGet("/api/media/okladka/{id}", (string id) =>
{
    var o = Media.Okladka(id);
    return o.HasValue ? Results.Bytes(o.Value.Dane, o.Value.Typ) : Results.NotFound();
});

// ------------------------------------------------------------------ polecenia
app.MapPost("/api/audio/glosnosc", (ZadanieGlosnosci z) =>
{
    Dzwiek.UstawGlosnosc(z.Wartosc);
    return Results.Json(new { ok = true });
});
app.MapPost("/api/audio/wycisz", (ZadanieWyciszenia z) => Results.Json(new { ok = true, wyciszony = Dzwiek.PrzelaczWyciszenie(z.Wyciszony) }));
app.MapPost("/api/audio/wyjscie", (ZadanieWyjscia z) =>
{
    Dzwiek.UstawWyjscie(z.Id);
    return Results.Json(new { ok = true });
});
app.MapPost("/api/audio/aplikacja", (ZadanieAplikacji z) =>
{
    Dzwiek.UstawAplikacje(z.Pid, z.Glosnosc, z.Wyciszona);
    return Results.Json(new { ok = true });
});
app.MapPost("/api/media/{akcja}", async (string akcja) => Results.Json(new { ok = await Media.Akcja(akcja) }));
app.MapPost("/api/zasilanie/{akcja}", (string akcja) => Results.Json(new { ok = true, msg = Zasilanie.Wykonaj(akcja) }));
app.MapGet("/api/discord/stan", (DiscordRpc rpc) => Results.Json(rpc.Stan()));
app.MapPost("/api/discord/{akcja}", async (string akcja, DiscordRpc rpc) =>
{
    var co = akcja switch
    {
        "mikrofon" => "mute",
        "sluchawki" => "deaf",
        _ => throw new ArgumentException("akcja: mikrofon | sluchawki"),
    };
    if (rpc.Gotowy)
        return Results.Json(new { ok = true, via = "rpc", stan = await rpc.Przelacz(co) });
    Klawisze.Nacisnij(co == "mute" ? cfg.DiscordMikrofon : cfg.DiscordSluchawki);
    return Results.Json(new { ok = true, via = "skrot" });
});
app.MapPost("/api/speedtest", async () => Results.Json(await Speedtest.Uruchom()));

app.Run();

record ZadanieGlosnosci(int Wartosc);
record ZadanieWyciszenia(bool? Wyciszony);
record ZadanieWyjscia(string Id);
record ZadanieAplikacji(uint Pid, int? Glosnosc, bool? Wyciszona);
