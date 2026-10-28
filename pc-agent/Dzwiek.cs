using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;

namespace JarvisAgent;

public sealed record UrzadzenieAudio(string Id, string Nazwa, bool Domyslne);
public sealed record AplikacjaAudio(uint Pid, string Nazwa, int Glosnosc, bool Wyciszona, bool Aktywna);
public sealed record StanAudio(List<UrzadzenieAudio> Urzadzenia, string? Wyjscie, int Glosnosc, bool Wyciszony, List<AplikacjaAudio> Aplikacje);

/// <summary>Core Audio przez NAudio: domyślne wyjście, głośność główna i mikser aplikacji.</summary>
public static class Dzwiek
{
    static readonly object Blokada = new();

    public static StanAudio Stan()
    {
        lock (Blokada)
        {
            using var en = new MMDeviceEnumerator();
            using var dom = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var urz = new List<UrzadzenieAudio>();
            foreach (var d in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                using (d) urz.Add(new UrzadzenieAudio(d.ID, d.FriendlyName, d.ID == dom.ID));
            }

            var apki = new Dictionary<uint, AplikacjaAudio>();
            var mgr = dom.AudioSessionManager;
            mgr.RefreshSessions();
            var sesje = mgr.Sessions;
            for (var i = 0; i < sesje.Count; i++)
            {
                var s = sesje[i];
                if (s.IsSystemSoundsSession) continue;
                var pid = s.GetProcessID;
                if (pid == 0) continue;
                var aktywna = s.State == NAudio.CoreAudioApi.Interfaces.AudioSessionState.AudioSessionStateActive;
                var wpis = new AplikacjaAudio(pid, NazwaProcesu(pid, s.DisplayName),
                    (int)Math.Round(s.SimpleAudioVolume.Volume * 100), s.SimpleAudioVolume.Mute, aktywna);
                // jedna aplikacja potrafi mieć kilka sesji (np. przeglądarka) — zostawiamy aktywną
                if (!apki.TryGetValue(pid, out var byla) || (!byla.Aktywna && aktywna)) apki[pid] = wpis;
            }

            var vol = dom.AudioEndpointVolume;
            return new StanAudio(urz, dom.ID, (int)Math.Round(vol.MasterVolumeLevelScalar * 100), vol.Mute,
                apki.Values.OrderByDescending(a => a.Aktywna).ThenBy(a => a.Nazwa).ToList());
        }
    }

    public static void UstawGlosnosc(int procent)
    {
        lock (Blokada)
        {
            using var en = new MMDeviceEnumerator();
            using var dom = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            dom.AudioEndpointVolume.MasterVolumeLevelScalar = Math.Clamp(procent, 0, 100) / 100f;
        }
    }

    public static bool PrzelaczWyciszenie(bool? wyciszony)
    {
        lock (Blokada)
        {
            using var en = new MMDeviceEnumerator();
            using var dom = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var v = dom.AudioEndpointVolume;
            v.Mute = wyciszony ?? !v.Mute;
            return v.Mute;
        }
    }

    public static void UstawAplikacje(uint pid, int? glosnosc, bool? wyciszona)
    {
        lock (Blokada)
        {
            using var en = new MMDeviceEnumerator();
            using var dom = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var mgr = dom.AudioSessionManager;
            mgr.RefreshSessions();
            var sesje = mgr.Sessions;
            var znaleziona = false;
            for (var i = 0; i < sesje.Count; i++)
            {
                var s = sesje[i];
                if (s.GetProcessID != pid) continue;
                znaleziona = true;
                if (glosnosc.HasValue) s.SimpleAudioVolume.Volume = Math.Clamp(glosnosc.Value, 0, 100) / 100f;
                if (wyciszona.HasValue) s.SimpleAudioVolume.Mute = wyciszona.Value;
            }
            if (!znaleziona) throw new ArgumentException($"brak sesji audio dla procesu {pid}");
        }
    }

    /// <summary>Zmiana domyślnego wyjścia (słuchawki/głośniki) — nieudokumentowany, ale stabilny od Win7 IPolicyConfig.</summary>
    public static void UstawWyjscie(string idUrzadzenia)
    {
        lock (Blokada)
        {
            using (var en = new MMDeviceEnumerator())
            {
                var istnieje = en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).Any(d => d.ID == idUrzadzenia);
                if (!istnieje) throw new ArgumentException("nie ma takiego aktywnego urządzenia");
            }
            var pc = (IPolicyConfig)new CPolicyConfigClient();
            try
            {
                foreach (var rola in new[] { ERole.Console, ERole.Multimedia, ERole.Communications })
                {
                    var hr = pc.SetDefaultEndpoint(idUrzadzenia, rola);
                    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                }
            }
            finally
            {
                Marshal.ReleaseComObject(pc);
            }
        }
    }

    static string NazwaProcesu(uint pid, string? wyswietlana)
    {
        if (!string.IsNullOrWhiteSpace(wyswietlana) && !wyswietlana.StartsWith('@')) return wyswietlana;
        try
        {
            using var p = Process.GetProcessById((int)pid);
            var opis = p.MainModule?.FileVersionInfo.FileDescription;
            return string.IsNullOrWhiteSpace(opis) ? p.ProcessName : opis;
        }
        catch
        {
            return $"PID {pid}";
        }
    }

    // ---------------------------------------------------------------- COM: IPolicyConfig
    enum ERole
    {
        Console = 0,
        Multimedia = 1,
        Communications = 2,
    }

    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    class CPolicyConfigClient
    {
    }

    [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        // kolejność metod = kolejność w vtable; używamy tylko SetDefaultEndpoint
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string device, IntPtr format);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string device, int useDefault, IntPtr format);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string device);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string device, IntPtr endpointFormat, IntPtr mixFormat);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string device, int useDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string device, IntPtr period);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string device, IntPtr mode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string device, IntPtr mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string device, int fxStore, IntPtr key, IntPtr value);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string device, int fxStore, IntPtr key, IntPtr value);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string device, ERole role);
        [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string device, int visible);
    }
}
