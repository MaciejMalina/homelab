using System.Net.NetworkInformation;
using LibreHardwareMonitor.Hardware;

namespace JarvisAgent;

public sealed record CzujnikiCpu(string Nazwa, float? Temp, float? Obciazenie, float? Moc);
public sealed record CzujnikiGpu(string Nazwa, float? Temp, float? Obciazenie, float? Moc, float? VramUzyteMb, float? VramRazemMb);
public sealed record Dysk(string Nazwa, float? Temp);
public sealed record StanSprzetu(CzujnikiCpu? Cpu, CzujnikiGpu? Gpu, float? RamUzyteGb, float? RamRazemGb, List<Dysk> Dyski, double? PingMs, DateTime Odczyt);

/// <summary>Odczyt czujników w tle co 2 s (LibreHardwareMonitor jest wolny — nie robimy go w żądaniu HTTP).</summary>
public sealed class Sprzet : IDisposable
{
    readonly Computer komputer = new()
    {
        IsCpuEnabled = true,
        IsGpuEnabled = true,
        IsMemoryEnabled = true,
        IsStorageEnabled = true,
    };
    readonly Timer timer;
    readonly Timer timerPing;
    readonly string pingHost;
    readonly object blokada = new();
    StanSprzetu stan = new(null, null, null, null, new(), null, DateTime.MinValue);
    double? ping;
    bool otwarty;

    public Sprzet(string pingHost)
    {
        this.pingHost = pingHost;
        timer = new Timer(_ => Odczytaj(), null, 0, 2000);
        timerPing = new Timer(_ => _ = Pinguj(), null, 0, 10_000);
    }

    public StanSprzetu Stan
    {
        get { lock (blokada) return stan with { PingMs = ping }; }
    }

    void Odczytaj()
    {
        if (!Monitor.TryEnter(komputer)) return; // poprzedni odczyt jeszcze trwa
        try
        {
            if (!otwarty)
            {
                komputer.Open();
                otwarty = true;
            }
            CzujnikiCpu? cpu = null;
            CzujnikiGpu? gpu = null;
            float? ramUzyte = null, ramWolne = null;
            var dyski = new List<Dysk>();

            foreach (var hw in komputer.Hardware)
            {
                hw.Update();
                foreach (var sub in hw.SubHardware) sub.Update();
                var czujniki = hw.Sensors.Concat(hw.SubHardware.SelectMany(s => s.Sensors)).ToList();

                switch (hw.HardwareType)
                {
                    case HardwareType.Cpu when cpu == null:
                        cpu = new CzujnikiCpu(hw.Name,
                            Wartosc(czujniki, SensorType.Temperature, "CPU Package", "Core (Tctl/Tdie)", "Core (Tctl)", "Core Max", "Core Average"),
                            Wartosc(czujniki, SensorType.Load, "CPU Total"),
                            Wartosc(czujniki, SensorType.Power, "CPU Package", "Package"));
                        break;

                    case HardwareType.GpuNvidia or HardwareType.GpuAmd or HardwareType.GpuIntel:
                        var nowa = new CzujnikiGpu(hw.Name,
                            Wartosc(czujniki, SensorType.Temperature, "GPU Core", "GPU Hot Spot"),
                            Wartosc(czujniki, SensorType.Load, "GPU Core", "D3D 3D"),
                            Wartosc(czujniki, SensorType.Power, "GPU Package", "GPU Power", "GPU Core"),
                            Wartosc(czujniki, SensorType.SmallData, "GPU Memory Used", "D3D Dedicated Memory Used"),
                            Wartosc(czujniki, SensorType.SmallData, "GPU Memory Total", "D3D Dedicated Memory Total"));
                        // karta dedykowana ma pierwszeństwo przed zintegrowaną
                        if (gpu == null || hw.HardwareType != HardwareType.GpuIntel) gpu = nowa;
                        break;

                    case HardwareType.Memory:
                        ramUzyte ??= Wartosc(czujniki, SensorType.Data, "Memory Used");
                        ramWolne ??= Wartosc(czujniki, SensorType.Data, "Memory Available");
                        break;

                    case HardwareType.Storage:
                        dyski.Add(new Dysk(hw.Name, Wartosc(czujniki, SensorType.Temperature, "Temperature", "Composite Temperature")));
                        break;
                }
            }

            var razem = ramUzyte.HasValue && ramWolne.HasValue ? ramUzyte + ramWolne : null;
            lock (blokada) stan = new StanSprzetu(cpu, gpu, ramUzyte, razem, dyski, null, DateTime.Now);
        }
        catch (Exception e)
        {
            Log.Zapisz($"Czujniki: {e.GetType().Name}: {e.Message}");
        }
        finally
        {
            Monitor.Exit(komputer);
        }
    }

    /// <summary>Temperatura i moc rowne 0 to brak odczytu (np. AMD bez sterownika PawnIO), a nie prawdziwa wartosc.</summary>
    static bool Ok(ISensor c, SensorType typ) =>
        c.Value.HasValue && (typ is not (SensorType.Temperature or SensorType.Power) || c.Value > 0);

    /// <summary>Pierwszy czujnik danego typu o jednej z nazw (w kolejności), a jak żadnego — pierwszy danego typu.</summary>
    static float? Wartosc(List<ISensor> czujniki, SensorType typ, params string[] nazwy)
    {
        foreach (var n in nazwy)
        {
            var s = czujniki.FirstOrDefault(c => c.SensorType == typ && c.Name.Equals(n, StringComparison.OrdinalIgnoreCase) && Ok(c, typ));
            if (s != null) return s.Value;
        }
        return typ is SensorType.Temperature or SensorType.Power
            ? czujniki.FirstOrDefault(c => c.SensorType == typ && Ok(c, typ))?.Value
            : null;
    }

    async Task Pinguj()
    {
        double? wynik = null;
        try
        {
            using var p = new Ping();
            var r = await p.SendPingAsync(pingHost, 1500);
            if (r.Status == IPStatus.Success) wynik = r.RoundtripTime;
        }
        catch
        {
            // ICMP bywa blokowany po drodze (u nas do 1.1.1.1 z Windowsa nie przechodzi) - nizej zapasowy pomiar
        }
        wynik ??= await PingTcp();
        lock (blokada) ping = wynik;
    }

    /// <summary>Czas nawiazania polaczenia TCP z portem 443 - dobre przyblizenie opoznienia, gdy ICMP nie dziala.</summary>
    async Task<double?> PingTcp()
    {
        try
        {
            using var tcp = new System.Net.Sockets.TcpClient();
            using var cts = new CancellationTokenSource(1500);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            await tcp.ConnectAsync(pingHost, 443, cts.Token);
            return Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        }
        catch
        {
            return null;
        }
    }

    public void Dispose()
    {
        timer.Dispose();
        timerPing.Dispose();
        lock (komputer)
        {
            if (otwarty) komputer.Close();
        }
    }
}
