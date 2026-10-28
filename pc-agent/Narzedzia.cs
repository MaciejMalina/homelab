using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;

namespace JarvisAgent;

/// <summary>Uśpij / wyłącz / restart / zablokuj. Wykonujemy z opóźnieniem, żeby zdążyć odpowiedzieć panelowi.</summary>
public static class Zasilanie
{
    [DllImport("powrprof.dll", SetLastError = true)]
    static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool LockWorkStation();

    public static string Wykonaj(string akcja)
    {
        Action dzialanie = akcja switch
        {
            "uspij" => () => SetSuspendState(false, false, false),
            "wylacz" => () => Process.Start(new ProcessStartInfo("shutdown", "/s /t 5 /c \"JARVIS: wyłączanie z panelu\"") { CreateNoWindow = true, UseShellExecute = false }),
            "restart" => () => Process.Start(new ProcessStartInfo("shutdown", "/r /t 5 /c \"JARVIS: restart z panelu\"") { CreateNoWindow = true, UseShellExecute = false }),
            "zablokuj" => () => LockWorkStation(),
            _ => throw new ArgumentException("akcja: uspij | wylacz | restart | zablokuj"),
        };
        Log.Zapisz($"Zasilanie: {akcja}");
        _ = Task.Run(async () =>
        {
            await Task.Delay(800);
            try { dzialanie(); }
            catch (Exception e) { Log.Zapisz($"Zasilanie {akcja}: {e.Message}"); }
        });
        return akcja switch
        {
            "uspij" => "Usypiam komputer",
            "wylacz" => "Wyłączam komputer (5 s)",
            "restart" => "Restart komputera (5 s)",
            _ => "Zablokowano",
        };
    }
}

/// <summary>Naciśnięcie skrótu klawiszowego (np. Ctrl+Shift+Alt+F9) przez SendInput — tak sterujemy Discordem.</summary>
public static class Klawisze
{
    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static void Nacisnij(string skrot)
    {
        var klawisze = skrot.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(Kod).ToList();
        var wejscia = new List<INPUT>();
        foreach (var k in klawisze) wejscia.Add(Klawisz(k, false));
        for (var i = klawisze.Count - 1; i >= 0; i--) wejscia.Add(Klawisz(klawisze[i], true));
        var arr = wejscia.ToArray();
        var wyslane = SendInput((uint)arr.Length, arr, Marshal.SizeOf<INPUT>());
        if (wyslane != arr.Length) throw new InvalidOperationException($"SendInput: wysłano {wyslane}/{arr.Length} (błąd {Marshal.GetLastWin32Error()})");
    }

    static INPUT Klawisz(ushort vk, bool puszczony) => new()
    {
        type = INPUT_KEYBOARD,
        U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = puszczony ? KEYEVENTF_KEYUP : 0 } },
    };

    static ushort Kod(string nazwa)
    {
        var n = nazwa.ToUpperInvariant();
        switch (n)
        {
            case "CTRL" or "CONTROL": return 0x11;
            case "SHIFT": return 0x10;
            case "ALT": return 0x12;
            case "WIN": return 0x5B;
        }
        if (n.Length >= 2 && n[0] == 'F' && int.TryParse(n[1..], out var f) && f is >= 1 and <= 24) return (ushort)(0x70 + f - 1);
        if (n.Length == 1 && char.IsAsciiLetterOrDigit(n[0])) return n[0];
        throw new ArgumentException($"nieznany klawisz „{nazwa}” (dozwolone: Ctrl, Shift, Alt, Win, F1–F24, litery, cyfry)");
    }
}

public sealed record WynikSpeedtestu(double? PingMs, double PobieranieMbps, double WysylanieMbps);

/// <summary>Szybki test łącza przez speed.cloudflare.com (25 MB w dół, 10 MB w górę).</summary>
public static class Speedtest
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    static readonly SemaphoreSlim Jeden = new(1, 1);

    public static async Task<WynikSpeedtestu> Uruchom()
    {
        if (!await Jeden.WaitAsync(0)) throw new InvalidOperationException("test już trwa");
        try
        {
            var pingi = new List<long>();
            using (var p = new Ping())
            {
                for (var i = 0; i < 3; i++)
                {
                    var r = await p.SendPingAsync("1.1.1.1", 1500);
                    if (r.Status == IPStatus.Success) pingi.Add(r.RoundtripTime);
                }
            }

            const int wDol = 25_000_000, wGore = 10_000_000;
            var sw = Stopwatch.StartNew();
            var dane = await Http.GetByteArrayAsync($"https://speed.cloudflare.com/__down?bytes={wDol}");
            var dol = dane.Length * 8 / sw.Elapsed.TotalSeconds / 1_000_000;

            sw.Restart();
            using (var tresc = new ByteArrayContent(new byte[wGore]))
            {
                using var odp = await Http.PostAsync("https://speed.cloudflare.com/__up", tresc);
                odp.EnsureSuccessStatusCode();
            }
            var gora = wGore * 8 / sw.Elapsed.TotalSeconds / 1_000_000;

            return new WynikSpeedtestu(pingi.Count > 0 ? pingi.Average() : null, Math.Round(dol, 1), Math.Round(gora, 1));
        }
        finally
        {
            Jeden.Release();
        }
    }
}
