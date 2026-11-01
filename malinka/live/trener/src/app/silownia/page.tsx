import Link from "next/link";
import { prisma } from "@/lib/db";
import { fmtDate, todayPL } from "@/lib/time";
import { e1rm, fmtKg } from "@/lib/strength";
import StartStrength from "@/components/StartStrength";

export const dynamic = "force-dynamic";

export default async function Silownia() {
  const today = todayPL();
  const open = await prisma.strengthSession.findMany({ where: { finishedAt: null }, orderBy: { startedAt: "desc" } });
  const planned = await prisma.plannedWorkout.findMany({ where: { date: today, sport: "Siłownia" } });
  const done = await prisma.strengthSession.findMany({
    where: { finishedAt: { not: null } },
    orderBy: { startedAt: "desc" },
    take: 40,
    include: { exercises: { include: { sets: true, exercise: true } } },
  });

  // rekordy (szac. 1RM) dla wszystkich ćwiczeń
  const sets = await prisma.strengthSet.findMany({ where: { done: true, warmup: false }, include: { item: { include: { exercise: true, session: true } } } });
  const best = new Map<string, { kg: number; set: string; date: string }>();
  for (const s of sets) {
    const v = e1rm(s.weight, s.reps);
    if (!v) continue;
    const k = s.item.exercise.name;
    if (!best.has(k) || best.get(k)!.kg < v) best.set(k, { kg: v, set: `${s.weight}×${s.reps}`, date: s.item.session.date });
  }
  const top = [...best.entries()].sort((a, b) => b[1].kg - a[1].kg).slice(0, 8);

  return (
    <>
      <h1>Siłownia</h1>
      {open.map((s) => (
        <Link key={s.id} href={`/silownia/${s.id}`} className="card link" style={{ display: "block", borderColor: "var(--acc)" }}>
          <b>▶ Kontynuuj: {s.name}</b>
          <div className="mut small">rozpoczęty {s.startedAt.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "short" })}</div>
        </Link>
      ))}
      <div className="stack">
        {planned.map((p) => <StartStrength key={p.id} plannedId={p.id} label={`▶ Z planu: ${p.title}`} />)}
        <StartStrength label="＋ Pusty trening" className={planned.length ? "block" : "pri block"} />
      </div>

      {top.length > 0 && (
        <>
          <h2>Rekordy (szacowane 1RM)</h2>
          <div className="card">
            <table className="list">
              <tbody>
                {top.map(([n, v]) => (
                  <tr key={n}><td>{n}</td><td style={{ textAlign: "right" }}><b>{fmtKg(v.kg)}</b> <span className="mut small">{v.set} · {fmtDate(v.date)}</span></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Historia</h2>
      {done.map((s) => {
        const serie = s.exercises.flatMap((e) => e.sets.filter((x) => x.done && !x.warmup));
        const vol = serie.reduce((n, x) => n + (x.weight ?? 0) * (x.reps ?? 0), 0);
        const min = s.finishedAt ? Math.round((s.finishedAt.getTime() - s.startedAt.getTime()) / 60000) : 0;
        return (
          <Link key={s.id} href={`/silownia/${s.id}`} className="card link" style={{ display: "block" }}>
            <div className="row"><b className="grow">{s.name}</b><span className="mut small">{fmtDate(s.date)}</span></div>
            <div className="mut small">
              {s.exercises.length} ćw. · {serie.length} serii · {Math.round(vol).toLocaleString("pl-PL")} kg · {min} min{s.analysis ? " · 🤖" : ""}
            </div>
          </Link>
        );
      })}
      {!done.length && <div className="card mut">Jeszcze żadnego zapisanego treningu.</div>}
    </>
  );
}
