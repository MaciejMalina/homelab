import Link from "next/link";
import { prisma } from "@/lib/db";
import { fmtDate, todayPL } from "@/lib/time";
import { exerciseBests } from "@/lib/context";
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

  // najlepsze wyniki (cała historia), ostatnio trenowane na górze
  const top = [...(await exerciseBests(3650)).entries()].sort((a, b) => b[1].last.localeCompare(a[1].last)).slice(0, 12);

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
          <h2>Najlepsze wyniki</h2>
          <div className="card">
            <table className="list">
              <tbody>
                {top.map(([n, v]) => (
                  <tr key={n}><td>{n}</td><td style={{ textAlign: "right" }}><b>{v.text}</b> <span className="mut small">· {fmtDate(v.last)}</span></td></tr>
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
