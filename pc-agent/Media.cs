using Windows.Media.Control;

namespace JarvisAgent;

public sealed record StanMediow(string? Tytul, string? Wykonawca, string? Album, string? Aplikacja, string Stan,
    double? PozycjaS, double? DlugoscS, string? OkladkaId);

/// <summary>To, co Windows pokazuje w panelu multimediów (Spotify, przeglądarka, odtwarzacze) — przez GSMTC.</summary>
public static class Media
{
    static GlobalSystemMediaTransportControlsSessionManager? menedzer;
    static readonly SemaphoreSlim Blokada = new(1, 1);
    static (string Id, byte[] Dane, string Typ)? okladka;

    static async Task<GlobalSystemMediaTransportControlsSession?> Sesja()
    {
        menedzer ??= await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        return menedzer.GetCurrentSession();
    }

    public static async Task<StanMediow> Stan()
    {
        await Blokada.WaitAsync();
        try
        {
            var s = await Sesja();
            if (s == null) return new StanMediow(null, null, null, null, "brak", null, null, null);

            var w = await s.TryGetMediaPropertiesAsync();
            var odtw = s.GetPlaybackInfo();
            var czas = s.GetTimelineProperties();
            var stan = odtw.PlaybackStatus switch
            {
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => "gra",
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused => "pauza",
                _ => "stop",
            };

            double? dlugosc = czas.EndTime > TimeSpan.Zero ? (czas.EndTime - czas.StartTime).TotalSeconds : null;
            double? pozycja = dlugosc.HasValue ? czas.Position.TotalSeconds : null;
            // pozycja jest aktualizowana przez odtwarzacz co kilka sekund — dociągamy do "teraz"
            if (pozycja.HasValue && stan == "gra")
                pozycja = Math.Min(dlugosc!.Value, pozycja.Value + (DateTimeOffset.Now - czas.LastUpdatedTime).TotalSeconds);

            string? idOkladki = null;
            if (w?.Thumbnail != null)
            {
                idOkladki = Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(
                    System.Text.Encoding.UTF8.GetBytes($"{s.SourceAppUserModelId}|{w.Title}|{w.Artist}|{w.AlbumTitle}")))[..16];
                if (okladka?.Id != idOkladki)
                {
                    try
                    {
                        using var ras = await w.Thumbnail.OpenReadAsync();
                        using var st = ras.AsStreamForRead();
                        using var ms = new MemoryStream();
                        await st.CopyToAsync(ms);
                        okladka = ms.Length is > 0 and < 2_000_000
                            ? (idOkladki, ms.ToArray(), string.IsNullOrEmpty(ras.ContentType) ? "image/jpeg" : ras.ContentType)
                            : null;
                    }
                    catch
                    {
                        okladka = null;
                    }
                }
                if (okladka == null) idOkladki = null;
            }

            return new StanMediow(Pusty(w?.Title), Pusty(w?.Artist), Pusty(w?.AlbumTitle), NazwaAplikacji(s.SourceAppUserModelId),
                stan, pozycja, dlugosc, idOkladki);
        }
        finally
        {
            Blokada.Release();
        }
    }

    public static (byte[] Dane, string Typ)? Okladka(string id)
    {
        var o = okladka;
        return o.HasValue && o.Value.Id == id ? (o.Value.Dane, o.Value.Typ) : null;
    }

    public static async Task<bool> Akcja(string akcja)
    {
        var s = await Sesja() ?? throw new InvalidOperationException("nic nie gra");
        return akcja switch
        {
            "toggle" => await s.TryTogglePlayPauseAsync(),
            "nastepny" => await s.TrySkipNextAsync(),
            "poprzedni" => await s.TrySkipPreviousAsync(),
            _ => throw new ArgumentException("akcja: toggle | nastepny | poprzedni"),
        };
    }

    static string? Pusty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    static string? NazwaAplikacji(string? aumid)
    {
        if (string.IsNullOrEmpty(aumid)) return null;
        var n = aumid.Split('!')[0];
        if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n[..^4];
        if (n.Contains("Spotify", StringComparison.OrdinalIgnoreCase)) return "Spotify";
        if (n.Contains("chrome", StringComparison.OrdinalIgnoreCase)) return "Chrome";
        if (n.Contains("msedge", StringComparison.OrdinalIgnoreCase) || n.Contains("Edge", StringComparison.OrdinalIgnoreCase)) return "Edge";
        if (n.Contains("firefox", StringComparison.OrdinalIgnoreCase)) return "Firefox";
        if (n.Contains("opera", StringComparison.OrdinalIgnoreCase)) return "Opera";
        return n.Length > 30 ? n[..30] : n;
    }
}
