using System.Diagnostics;

namespace JarvisAgent;

/// <summary>Jedna pozycja listy: procesy o tej samej nazwie zgrupowane jak w Menedżerze zadań.</summary>
public sealed record GrupaProcesow(string Nazwa, int Liczba, double Cpu, double RamMb, int GlownyPid, bool Chroniony);

/// <summary>
/// Najcięższe procesy (CPU/RAM) i kończenie ich z panelu. CPU% liczone z przyrostu czasu procesora między
/// próbkami co 3 s (jak Menedżer zadań: 100% = wszystkie rdzenie). Kończyć wolno tylko procesy z sesji
/// zalogowanego użytkownika (żadnych usług z sesji 0) i spoza listy chronionych.
/// </summary>
public sealed class Procesy : IDisposable
{
    static readonly HashSet<string> Chronione = new(StringComparer.OrdinalIgnoreCase)
    {
        "System", "Idle", "Registry", "Memory Compression", "smss", "csrss", "wininit", "winlogon", "services",
        "lsass", "lsaiso", "svchost", "explorer", "dwm", "fontdrvhost", "sihost", "ctfmon", "conhost", "taskhostw",
        "StartMenuExperienceHost", "ShellExperienceHost", "SearchHost", "RuntimeBroker", "audiodg", "spoolsv",
        "MsMpEng", "NisSrv", "SecurityHealthService", "SecurityHealthSystray", "LogonUI", "userinit", "JarvisAgent",
    };

    readonly int mojaSesja = Process.GetCurrentProcess().SessionId;
    readonly Timer zegar;
    readonly object blokada = new();
    Dictionary<int, TimeSpan> poprzednie = new();
    DateTime poprzedniCzas = DateTime.UtcNow;
    List<GrupaProcesow> grupy = new();

    public Procesy()
    {
        zegar = new Timer(_ => Probka(), null, 0, 3000);
    }

    void Probka()
    {
        try
        {
            var teraz = DateTime.UtcNow;
            var okno = (teraz - poprzedniCzas).TotalMilliseconds * Environment.ProcessorCount;
            var nowe = new Dictionary<int, TimeSpan>();
            var zebrane = new Dictionary<string, (int n, double cpu, double ram, int pid, double pidRam, bool chron)>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in Process.GetProcesses())
            {
                using (p)
                {
                    try
                    {
                        double cpu = 0;
                        try
                        {
                            var czas = p.TotalProcessorTime;
                            nowe[p.Id] = czas;
                            if (okno > 0 && poprzednie.TryGetValue(p.Id, out var stary))
                                cpu = Math.Max(0, (czas - stary).TotalMilliseconds / okno * 100);
                        }
                        catch { /* brak dostępu (procesy systemowe) — bez CPU */ }
                        var ram = p.WorkingSet64 / 1048576.0;
                        var chron = p.SessionId != mojaSesja || Chronione.Contains(p.ProcessName);
                        zebrane.TryGetValue(p.ProcessName, out var g);
                        var najwiekszy = g.n == 0 || ram > g.pidRam;
                        zebrane[p.ProcessName] = (g.n + 1, g.cpu + cpu, g.ram + ram,
                            najwiekszy ? p.Id : g.pid, najwiekszy ? ram : g.pidRam, g.chron || chron);
                    }
                    catch { /* proces zdążył się zakończyć */ }
                }
            }
            lock (blokada)
            {
                poprzednie = nowe;
                poprzedniCzas = teraz;
                grupy = zebrane.Select(kv => new GrupaProcesow(kv.Key, kv.Value.n, Math.Round(kv.Value.cpu, 1),
                    Math.Round(kv.Value.ram), kv.Value.pid, kv.Value.chron)).ToList();
            }
        }
        catch (Exception e)
        {
            Log.Zapisz($"Procesy: {e.Message}");
        }
    }

    public object Lista(int ile = 8)
    {
        List<GrupaProcesow> g;
        lock (blokada) g = grupy;
        var bezIdle = g.Where(x => x.Nazwa is not ("Idle" or "System")).ToList();
        return new
        {
            cpu = bezIdle.OrderByDescending(x => x.Cpu).Take(ile),
            ram = bezIdle.OrderByDescending(x => x.RamMb).Take(ile),
            rdzenie = Environment.ProcessorCount,
        };
    }

    /// <summary>pid podany = tylko ta instancja (musi mieć tę nazwę); bez pid = wszystkie procesy o tej nazwie.</summary>
    public string Zakoncz(string nazwa, int? pid)
    {
        if (string.IsNullOrWhiteSpace(nazwa)) throw new ArgumentException("nazwa: pusta");
        if (Chronione.Contains(nazwa)) throw new InvalidOperationException($"{nazwa} jest chroniony — tego nie kończę");
        var cele = pid is int id
            ? new[] { Process.GetProcessById(id) }.Where(p => p.ProcessName.Equals(nazwa, StringComparison.OrdinalIgnoreCase)).ToArray()
            : Process.GetProcessesByName(nazwa);
        if (cele.Length == 0) throw new InvalidOperationException($"{nazwa}: nie znaleziono procesu");
        int zakonczone = 0, pominiete = 0;
        foreach (var p in cele)
        {
            using (p)
            {
                if (p.SessionId != mojaSesja) { pominiete++; continue; }
                try
                {
                    p.Kill();
                    zakonczone++;
                }
                catch (Exception e)
                {
                    pominiete++;
                    Log.Zapisz($"Zakończ {nazwa} ({p.Id}): {e.Message}");
                }
            }
        }
        Log.Zapisz($"Zakończ {nazwa}{(pid is null ? " (wszystkie)" : $" pid {pid}")}: {zakonczone} ok, {pominiete} pominięte");
        if (zakonczone == 0) throw new InvalidOperationException($"{nazwa}: nie udało się zakończyć (brak uprawnień albo proces systemowy)");
        return zakonczone == 1 ? $"Zakończono {nazwa}" : $"Zakończono {nazwa} ×{zakonczone}" + (pominiete > 0 ? $" ({pominiete} pominięte)" : "");
    }

    public void Dispose() => zegar.Dispose();
}
