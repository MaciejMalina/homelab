import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { fmtDate, fmtDuration, fmtKm, fmtPace } from "@/lib/time";
import { ICON, sportGroup, sportName } from "@/lib/sport";
import Md from "@/components/Md";
import ActionButton from "@/components/ActionButton";

export const dynamic = "force-dynamic";

interface Lap { typ?: string; dyst_m?: number; czas_s?: number; tempo_s_km?: number; hr?: number; hr_max?: number }

export default async function Aktywnosc({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await prisma.activity.findUnique({ where: { id } });
  if (!a) notFound();
  const g = sportGroup(a.type);
  const laps: Lap[] = a.laps ? JSON.parse(a.laps) : [];
  const zones: number[] = a.hrZones ? JSON.parse(a.hrZones) : [];
  const zSum = zones.reduce((x, y) => x + y, 0);
  const plan = await prisma.plannedWorkout.findMany({ where: { date: a.date } });

  const stats: [string, string][] = [
    ["Dystans", a.distance ? fmtKm(a.distance) : "–"],
    ["Czas", fmtDuration(a.movingTime)],
    [g === "swim" ? "Tempo /100 m" : g === "ride" ? "Prędkość" : "Tempo",
      a.distance && a.movingTime
        ? g === "swim" ? fmtDuration((a.movingTime / a.distance) * 100) : g === "ride" ? `${((a.distance / a.movingTime) * 3.6).toFixed(1)} km/h` : fmtPace(a.movingTime / (a.distance / 1000))
        : "–"],
    ["Tętno śr./max", a.avgHr ? `${a.avgHr} / ${a.maxHr ?? "–"}` : "–"],
    ["Obciążenie", a.load != null ? String(a.load) : "–"],
    ["Przewyższenie", a.elevation ? `${Math.round(a.elevation)} m` : "–"],
  ];

  return (
    <>
      <Link href="/aktywnosci" className="mut small">← Treningi</Link>
      <h1>{ICON[g]} {a.name || sportName(a.type)}</h1>
      <div className="mut" style={{ marginTop: -8, marginBottom: 12 }}>{sportName(a.type)} · {fmtDate(a.date)} {a.startLocal.slice(11, 16)}</div>
      <div className="grid2">
        {stats.map(([k, v]) => <div key={k} className="stat"><span>{k}</span><b style={{ fontSize: 18 }}>{v}</b></div>)}
      </div>

      {zSum > 0 && (
        <>
          <h2>Strefy tętna</h2>
          <div className="card">
            {zones.map((z, i) => (
              <div key={i} className="row small" style={{ marginBottom: 4 }}>
                <span style={{ width: 28 }}>Z{i + 1}</span>
                <div className="bar grow" style={{ marginTop: 0 }}><i style={{ width: `${(z / zSum) * 100}%` }} /></div>
                <span className="mut" style={{ width: 54, textAlign: "right" }}>{fmtDuration(z)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Analiza trenera</h2>
      <div className="card">
        {a.analysis ? <Md text={a.analysis} /> : <p className="mut" style={{ marginTop: 0 }}>Brak analizy.</p>}
        <ActionButton url={`/api/activity/${a.id}/analyze`} label={a.analysis ? "↻ Przeanalizuj ponownie" : "🤖 Przeanalizuj"} busyLabel="Analizuję…" />
      </div>

      {plan.length > 0 && (
        <>
          <h2>Plan na ten dzień</h2>
          {plan.map((p) => (
            <div key={p.id} className="card"><b>{p.title}</b><div className="mut small">{p.description}</div></div>
          ))}
        </>
      )}

      {laps.length > 0 && (
        <>
          <h2>Odcinki</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="list">
              <thead><tr><th>#</th><th>Dyst.</th><th>Czas</th><th>{g === "run" ? "Tempo" : "Śr."}</th><th>♥</th></tr></thead>
              <tbody>
                {laps.map((l, i) => (
                  <tr key={i}>
                    <td className="mut">{i + 1}{l.typ === "RECOVERY" ? " ↓" : l.typ === "WORK" ? " ↑" : ""}</td>
                    <td>{l.dyst_m ? fmtKm(l.dyst_m) : "–"}</td>
                    <td>{fmtDuration(l.czas_s)}</td>
                    <td>{g === "run" ? fmtPace(l.tempo_s_km) : l.tempo_s_km && g === "ride" ? `${(3600 / l.tempo_s_km).toFixed(1)} km/h` : "–"}</td>
                    <td>{l.hr ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="small mut">
        <a href={`https://intervals.icu/activities/${a.id}`} target="_blank" rel="noreferrer">Otwórz w intervals.icu ↗</a>
      </p>
    </>
  );
}
