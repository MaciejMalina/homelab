using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace JarvisAgent;

/// <summary>
/// Powiadomienia Windows z aplikacji Claude (desktop): „Claude needs your input to continue” z tytułem rozmowy.
/// Czytane z bazy centrum powiadomień użytkownika (wpndatabase.db) — bez API Claude, bez tokenów i limitów.
/// Baza jest otwarta przez Windows, więc kopiujemy ją (z plikiem -wal) do %TEMP% i czytamy kopię, tylko gdy się zmieniła.
/// W bazie są tylko powiadomienia, które wciąż wiszą w centrum powiadomień — historię trzyma panel na malince.
/// </summary>
public sealed class PowiadomieniaClaude
{
    static readonly string Baza = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        @"Microsoft\Windows\Notifications\wpndatabase.db");
    static readonly Regex Tekst = new("<text[^>]*>(.*?)</text>", RegexOptions.Singleline | RegexOptions.Compiled);
    readonly object _lock = new();
    DateTime _znacznik = DateTime.MinValue;
    List<object> _lista = new();

    public List<object> Lista()
    {
        lock (_lock)
        {
            if (!File.Exists(Baza)) return _lista;
            var wal = Baza + "-wal";
            var z = File.GetLastWriteTimeUtc(Baza);
            if (File.Exists(wal) && File.GetLastWriteTimeUtc(wal) > z) z = File.GetLastWriteTimeUtc(wal);
            if (z == _znacznik) return _lista;

            var kat = Path.Combine(Path.GetTempPath(), "jarvis-wpn");
            Directory.CreateDirectory(kat);
            var kopia = Path.Combine(kat, "wpn.db");
            foreach (var stary in new[] { kopia + "-wal", kopia + "-shm" }) if (File.Exists(stary)) File.Delete(stary);
            File.Copy(Baza, kopia, true);
            if (File.Exists(wal)) File.Copy(wal, kopia + "-wal", true);

            var wynik = new List<object>();
            using (var c = new SqliteConnection($"Data Source={kopia};Pooling=False"))
            {
                c.Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = @"select n.Id, n.ArrivalTime, n.Payload from Notification n
                    join NotificationHandler h on h.RecordId = n.HandlerId
                    where n.Type = 'toast' and h.PrimaryId like 'Claude\_%' escape '\'
                    order by n.ArrivalTime desc limit 30";
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    var surowe = r.IsDBNull(2) ? null : r.GetValue(2);
                    var payload = surowe is byte[] b ? Encoding.UTF8.GetString(b) : surowe?.ToString() ?? "";
                    var teksty = Tekst.Matches(payload).Select(m => WebUtility.HtmlDecode(m.Groups[1].Value).Trim())
                        .Where(s => s.Length > 0).ToList();
                    long ft = r.IsDBNull(1) ? 0 : r.GetInt64(1);
                    wynik.Add(new
                    {
                        id = r.GetInt64(0),
                        czas = ft > 0 ? (DateTime.FromFileTimeUtc(ft) - DateTime.UnixEpoch).TotalSeconds : 0,
                        tytul = teksty.FirstOrDefault() ?? "Claude",
                        tresc = string.Join(" — ", teksty.Skip(1)),
                    });
                }
            }
            _lista = wynik;
            _znacznik = z;
            return _lista;
        }
    }
}
