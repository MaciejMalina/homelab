using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace JarvisAgent;

/// <summary>
/// Discord przez lokalne RPC (named pipe discord-ipc-N): stan mute/deaf, aktualny kanal glosowy na DOWOLNYM
/// serwerze oraz przelaczanie mute/deaf bez skrotow klawiszowych. Wymaga aplikacji w Discord Developer Portal
/// (DiscordClientId + DiscordClientSecret w agent.json) i jednorazowej zgody w oknie Discorda.
/// Bez tych pol modul jest wylaczony, a /api/discord/* dziala jak dotad (skroty klawiszowe).
/// </summary>
public sealed class DiscordRpc
{
    public sealed record Uczestnik(string Id, string Nazwa, bool Mute, bool Deaf, string? Avatar, bool Bot);
    public sealed record Kanal(string Id, string Nazwa, string? SerwerId, List<Uczestnik> Uczestnicy);
    sealed record Zeton(string Access, string Refresh, DateTime Wygasa);

    static readonly HttpClient Http = CreateHttp();
    static readonly string PlikTokenu = Path.Combine(Konfiguracja.Katalog, "discord-token.json");

    static HttpClient CreateHttp()
    {
        var h = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        h.DefaultRequestHeaders.UserAgent.ParseAdd("JarvisAgent/1.0");
        return h;
    }

    readonly Konfiguracja cfg;
    readonly SemaphoreSlim zapis = new(1, 1);
    readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> oczekujace = new();
    readonly object bl = new();
    NamedPipeClientStream? rura;
    bool uwierzytelniony;
    string status = "wylaczony";
    bool? mute, deaf;
    Kanal? kanal;

    public DiscordRpc(Konfiguracja cfg) => this.cfg = cfg;

    public bool Wlaczony => !string.IsNullOrWhiteSpace(cfg.DiscordClientId) && !string.IsNullOrWhiteSpace(cfg.DiscordClientSecret);
    public bool Gotowy { get { lock (bl) return uwierzytelniony; } }
    public string Status { get { lock (bl) return status; } }

    public object Stan()
    {
        lock (bl)
            return new { wlaczony = Wlaczony, polaczony = uwierzytelniony, status, mute, deaf, kanal };
    }

    public void Start()
    {
        if (!Wlaczony)
        {
            Log.Zapisz("Discord RPC wylaczony (brak DiscordClientId/DiscordClientSecret w agent.json)");
            return;
        }
        _ = Task.Run(Petla);
    }

    void Ustaw(string s) { lock (bl) status = s; }

    async Task Petla()
    {
        string? ostatni = null;
        while (true)
        {
            try
            {
                await Sesja();
            }
            catch (Exception e)
            {
                var opis = $"{e.GetType().Name}: {e.Message}";
                Ustaw("rozlaczony: " + e.Message);
                if (opis != ostatni) Log.Zapisz("Discord RPC: " + opis);   // bez spamu przy wylaczonym Discordzie
                ostatni = opis;
            }
            await Task.Delay(TimeSpan.FromSeconds(10));
        }
    }

    async Task Sesja()
    {
        var r = await Otworz();
        using var cts = new CancellationTokenSource();
        var gotowe = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rura = r;
        var czytnik = Task.Run(() => Czytaj(r, gotowe, cts.Token));
        try
        {
            Ustaw("lacze z Discordem");
            await Wyslij(0, new JsonObject { ["v"] = 1, ["client_id"] = cfg.DiscordClientId });
            await Task.WhenAny(gotowe.Task, czytnik).WaitAsync(TimeSpan.FromSeconds(10));
            if (!gotowe.Task.IsCompleted) await czytnik;   // rzuci powodem zamkniecia
            await Uwierzytelnij();
            await Komenda("SUBSCRIBE", new JsonObject(), "VOICE_SETTINGS_UPDATE");
            await Komenda("SUBSCRIBE", new JsonObject(), "VOICE_CHANNEL_SELECT");
            await OdswiezUstawienia();
            await OdswiezKanal();
            lock (bl) { uwierzytelniony = true; status = "polaczony"; }
            Log.Zapisz("Discord RPC: polaczony");
            while (!czytnik.IsCompleted)
            {
                await Task.WhenAny(czytnik, Task.Delay(10_000));
                if (czytnik.IsCompleted) break;
                await OdswiezKanal();   // lista uczestnikow zmienia sie bez zdarzen, ktore subskrybujemy
            }
            await czytnik;
        }
        finally
        {
            cts.Cancel();
            lock (bl) { uwierzytelniony = false; mute = deaf = null; kanal = null; }
            rura = null;
            r.Dispose();
            foreach (var k in oczekujace.Keys)
                if (oczekujace.TryRemove(k, out var t)) t.TrySetException(new IOException("polaczenie z Discordem zamkniete"));
        }
    }

    static async Task<NamedPipeClientStream> Otworz()
    {
        for (var i = 0; i < 10; i++)
        {
            var r = new NamedPipeClientStream(".", $"discord-ipc-{i}", PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                await r.ConnectAsync(500);
                return r;
            }
            catch (Exception e) when (e is TimeoutException or IOException)
            {
                r.Dispose();
            }
        }
        throw new IOException("Discord nie dziala (brak discord-ipc)");
    }

    async Task Czytaj(NamedPipeClientStream r, TaskCompletionSource gotowe, CancellationToken ct)
    {
        var naglowek = new byte[8];
        while (true)
        {
            await r.ReadExactlyAsync(naglowek, ct);
            var op = BitConverter.ToInt32(naglowek, 0);
            var dl = BitConverter.ToInt32(naglowek, 4);
            if (dl < 0 || dl > 1_000_000) throw new IOException("zla dlugosc ramki RPC");
            var dane = new byte[dl];
            await r.ReadExactlyAsync(dane, ct);
            if (op == 2) throw new IOException("Discord zamknal polaczenie: " + Encoding.UTF8.GetString(dane));
            if (op == 3) { await Wyslij(4, JsonNode.Parse(dane)); continue; }
            if (op != 1) continue;

            var msg = JsonNode.Parse(dane);
            var nonce = S(msg, "nonce");
            var evt = S(msg, "evt");
            if (nonce != null && oczekujace.TryRemove(nonce, out var tcs))
            {
                if (evt == "ERROR") tcs.TrySetException(new InvalidOperationException(S(msg?["data"], "message") ?? "blad Discorda"));
                else tcs.TrySetResult(msg?["data"]);
            }
            else if (evt == "READY") gotowe.TrySetResult();
            else if (evt == "VOICE_SETTINGS_UPDATE") UstawUstawienia(msg?["data"]);
            else if (evt == "VOICE_CHANNEL_SELECT") _ = Task.Run(async () => { try { await OdswiezKanal(); } catch { } });
        }
    }

    async Task Wyslij(int op, JsonNode? tresc)
    {
        var r = rura ?? throw new InvalidOperationException("brak polaczenia z Discordem");
        var dane = Encoding.UTF8.GetBytes(tresc?.ToJsonString() ?? "{}");
        var ramka = new byte[8 + dane.Length];
        BitConverter.GetBytes(op).CopyTo(ramka, 0);
        BitConverter.GetBytes(dane.Length).CopyTo(ramka, 4);
        dane.CopyTo(ramka, 8);
        await zapis.WaitAsync();
        try
        {
            await r.WriteAsync(ramka);
            await r.FlushAsync();
        }
        finally
        {
            zapis.Release();
        }
    }

    async Task<JsonNode?> Komenda(string cmd, JsonNode? args, string? evt = null, int timeoutSek = 10)
    {
        var nonce = Guid.NewGuid().ToString();
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        oczekujace[nonce] = tcs;
        var msg = new JsonObject { ["cmd"] = cmd, ["nonce"] = nonce };
        if (args != null) msg["args"] = args;
        if (evt != null) msg["evt"] = evt;
        try
        {
            await Wyslij(1, msg);
            return await tcs.Task.WaitAsync(TimeSpan.FromSeconds(timeoutSek));
        }
        finally
        {
            oczekujace.TryRemove(nonce, out _);
        }
    }

    // ------------------------------------------------------------------ autoryzacja (jednorazowa zgoda w Discordzie)
    async Task Uwierzytelnij()
    {
        Zeton? z = null;
        try { if (File.Exists(PlikTokenu)) z = JsonSerializer.Deserialize<Zeton>(File.ReadAllText(PlikTokenu)); } catch { }
        if (z != null && z.Wygasa < DateTime.UtcNow.AddMinutes(5))
        {
            try { z = string.IsNullOrEmpty(z.Refresh) ? null : await Wymien("refresh_token", z.Refresh); }
            catch (Exception e) { Log.Zapisz("Discord RPC: odswiezenie tokenu nie wyszlo: " + e.Message); z = null; }
        }
        if (z == null)
        {
            Ustaw("czeka na zgode w oknie Discorda");
            Log.Zapisz("Discord RPC: czekam na zgode w oknie Discorda (Authorize)");
            var d = await Komenda("AUTHORIZE", new JsonObject
            {
                ["client_id"] = cfg.DiscordClientId,
                ["scopes"] = new JsonArray("rpc", "rpc.voice.read", "rpc.voice.write"),
            }, timeoutSek: 300);
            var kod = S(d, "code") ?? throw new InvalidOperationException("Discord nie zwrocil kodu");
            z = await Wymien("authorization_code", kod);
        }
        try
        {
            await Komenda("AUTHENTICATE", new JsonObject { ["access_token"] = z.Access });
        }
        catch (InvalidOperationException)
        {
            try { File.Delete(PlikTokenu); } catch { }   // token uniewazniony -> nastepna proba zapyta o zgode od nowa
            throw;
        }
    }

    async Task<Zeton> Wymien(string typ, string wartosc)
    {
        var pola = new Dictionary<string, string>
        {
            ["client_id"] = cfg.DiscordClientId,
            ["client_secret"] = cfg.DiscordClientSecret,
            ["grant_type"] = typ,
            ["redirect_uri"] = cfg.DiscordRedirect,
            [typ == "refresh_token" ? "refresh_token" : "code"] = wartosc,
        };
        using var odp = await Http.PostAsync("https://discord.com/api/oauth2/token", new FormUrlEncodedContent(pola));
        var tekst = await odp.Content.ReadAsStringAsync();
        if (!odp.IsSuccessStatusCode) throw new InvalidOperationException($"wymiana tokenu: HTTP {(int)odp.StatusCode} {tekst}");
        var j = JsonNode.Parse(tekst)!;
        var expires = j["expires_in"] is JsonValue ev && ev.TryGetValue<int>(out var sek) ? sek : 3600;
        var z = new Zeton(S(j, "access_token") ?? "", S(j, "refresh_token") ?? "", DateTime.UtcNow.AddSeconds(expires));
        File.WriteAllText(PlikTokenu, JsonSerializer.Serialize(z));
        return z;
    }

    // ------------------------------------------------------------------ stan
    async Task OdswiezUstawienia() => UstawUstawienia(await Komenda("GET_VOICE_SETTINGS", null));

    void UstawUstawienia(JsonNode? d)
    {
        lock (bl) { mute = B(d, "mute"); deaf = B(d, "deaf"); }
    }

    async Task OdswiezKanal()
    {
        var d = await Komenda("GET_SELECTED_VOICE_CHANNEL", null);
        Kanal? k = null;
        if (d is JsonObject o)
        {
            var lista = new List<Uczestnik>();
            if (o["voice_states"] is JsonArray vs)
            {
                foreach (var s in vs)
                {
                    var u = s?["user"];
                    var st = s?["voice_state"];
                    var nazwa = S(s, "nick") ?? S(u, "global_name") ?? S(u, "username") ?? "?";
                    var m = B(st, "self_mute") == true || B(st, "mute") == true || B(s, "mute") == true;
                    var g = B(st, "self_deaf") == true || B(st, "deaf") == true || B(s, "deaf") == true;
                    var uid = S(u, "id");
                    var hash = S(u, "avatar");
                    var avatar = uid != null && hash != null ? $"https://cdn.discordapp.com/avatars/{uid}/{hash}.png?size=64" : null;
                    lista.Add(new Uczestnik(uid ?? "", nazwa, m, g, avatar, B(u, "bot") == true));
                }
            }
            k = new Kanal(S(o, "id") ?? "", S(o, "name") ?? "", S(o, "guild_id"), lista);
        }
        lock (bl) kanal = k;
    }

    /// <summary>co = "mute" | "deaf"; wartosc null = przelacz.</summary>
    public async Task<object> Przelacz(string co, bool? wartosc = null)
    {
        if (!Gotowy) throw new InvalidOperationException("Discord RPC niepolaczony: " + Status);
        bool? biezace;
        lock (bl) biezace = co == "mute" ? mute : deaf;
        var cel = wartosc ?? !(biezace ?? false);
        await Komenda("SET_VOICE_SETTINGS", new JsonObject { [co] = cel });
        await OdswiezUstawienia();
        return Stan();
    }

    /// <summary>Rozlacza z kanalu glosowego (SELECT_VOICE_CHANNEL z channel_id = null).</summary>
    public async Task<object> Rozlacz()
    {
        if (!Gotowy) throw new InvalidOperationException("Discord RPC niepolaczony: " + Status);
        await Komenda("SELECT_VOICE_CHANNEL", new JsonObject { ["channel_id"] = null, ["force"] = true });
        await OdswiezKanal();
        return Stan();
    }

    static string? S(JsonNode? n, string k) => n?[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    static bool? B(JsonNode? n, string k) => n?[k] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : (bool?)null;
}