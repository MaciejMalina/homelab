using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace JarvisAgent;

/// <summary>agent.json obok JarvisAgent.exe. Brak pliku = tworzymy z losowym tokenem.</summary>
public sealed class Konfiguracja
{
    public string Nazwa { get; set; } = Environment.MachineName;
    public int Port { get; set; } = 8765;
    public string Token { get; set; } = "";
    /// <summary>Kto może pytać agenta: malinka w LAN i w tailnecie + localhost do testów.</summary>
    public List<string> DozwoloneIp { get; set; } = new() { "192.168.254.10", "100.105.181.54", "127.0.0.1", "::1" };
    /// <summary>Skróty ustawione w Discordzie: Ustawienia → Skróty klawiszowe → Przełącz wyciszenie / Przełącz ogłuszenie.</summary>
    public string DiscordMikrofon { get; set; } = "Ctrl+Shift+Alt+F9";
    public string DiscordSluchawki { get; set; } = "Ctrl+Shift+Alt+F11";
    public string PingHost { get; set; } = "1.1.1.1";

    public static string Katalog => AppContext.BaseDirectory;
    static string Plik => Path.Combine(Katalog, "agent.json");

    static readonly JsonSerializerOptions Json = new() { WriteIndented = true, PropertyNameCaseInsensitive = true };

    public static Konfiguracja Wczytaj()
    {
        Konfiguracja k;
        if (File.Exists(Plik))
        {
            k = JsonSerializer.Deserialize<Konfiguracja>(File.ReadAllText(Plik), Json) ?? new Konfiguracja();
        }
        else
        {
            k = new Konfiguracja();
        }
        if (string.IsNullOrWhiteSpace(k.Token))
        {
            k.Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            File.WriteAllText(Plik, JsonSerializer.Serialize(k, Json));
            Log.Zapisz($"Utworzono {Plik} z nowym tokenem — wpisz go do AGENT_TOKEN w .env panelu");
        }
        return k;
    }

    public bool CzyDozwolone(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return true;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return DozwoloneIp.Any(x => IPAddress.TryParse(x, out var d) && d.Equals(ip));
    }

    public bool CzyDobryToken(string? podany)
    {
        if (string.IsNullOrEmpty(podany)) return false;
        var a = Encoding.UTF8.GetBytes(podany);
        var b = Encoding.UTF8.GetBytes(Token);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }
}

/// <summary>Prosty log do agent.log (exe chodzi bez konsoli).</summary>
public static class Log
{
    static readonly object Blokada = new();
    static string Plik => Path.Combine(Konfiguracja.Katalog, "agent.log");

    public static void Zapisz(string tekst)
    {
        try
        {
            lock (Blokada)
            {
                var f = new FileInfo(Plik);
                if (f.Exists && f.Length > 1_000_000) File.Move(Plik, Plik + ".1", overwrite: true);
                File.AppendAllText(Plik, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {tekst}{Environment.NewLine}");
            }
        }
        catch
        {
            // log nie może wywrócić agenta
        }
    }
}
