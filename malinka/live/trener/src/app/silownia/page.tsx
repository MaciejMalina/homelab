import Link from "next/link";
import { prisma } from "@/lib/db";
import { fmtDate, todayPL } from "@/lib/time";
import { asKind, fmtSet } from "@/lib/kinds";
import { listTemplates } from "@/lib/templates";
import StartStrength from "@/components/StartStrength";
import Icon from "@/components/Icon";

export const dynamic = "force-dynamic";

export default async function Silownia() {
  const today = todayPL();
  const open = await prisma.strengthSession.findMany({ where: { finishedAt: null }, orderBy: { startedAt: "desc" } });
  const planned = await prisma.plannedWorkout.findMany({ where: { date: today, sport: "Siłownia" } });
  const templates = await listTemplates();
  const done = await prisma.strengthSession.findMany({
    where: { finishedAt: { not: null } },
    orderBy: { startedAt: "desc" },
    take: 30,
    include: { exercises: { orderBy: { order: "asc" }, include: { sets: { where: { done: true }, orderBy: { order: "asc" } }, exercise: true } } },
  });

  return (
    <>
      <h1>Trening</h1>

      {open.map((s) => (
        <Link key={s.id} href={`/silownia/${s.id}`} className="card link hero row" style={{ flexWrap: "nowrap" }}>
          <Icon name="play" size={22} style={{ color: "var(--acc)" }} />
          <span className="grow">
            <b>Kontynuuj: {s.name}</b>
            <div className="mut small">rozpoczęty {s.startedAt.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "short" })}</div>
          </span>
        </Link>
      ))}

      <div className="card">
        <div className="small mut" style={{ marginBottom: 8 }}>Szybki start</div>
        <div className="stack">
          {planned.map((p) => <StartStrength key={p.id} plannedId={p.id} label={`Z planu: ${p.title}`} icon="play" className="pri block big-start" />)}
          <StartStrength label="Pusty trening" icon="plus" className={`${planned.length ? "" : "pri"} block big-start`} />
        </div>
      </div>

      <div className="sec">
        <h2>Moje szablony</h2>
        <Link href="/silownia/szablon/nowy"><Icon name="plus" size={15} style={{ verticalAlign: -2 }} /> Nowy</Link>
      </div>
      {templates.length ? (
        <div className="tgrid">
          {templates.map((t) => (
            <div key={t.id} className="tcard">
              <div className="row" style={{ alignItems: "flex-start" }}>
                <h3 className="grow">{t.name}</h3>
                <Link href={`/silownia/szablon/${t.id}`} className="mut" aria-label={`Edytuj ${t.name}`}><Icon name="edit" size={17} /></Link>
              </div>
              <div className="ex-list">{t.items.map((it) => `${it.sets}× ${it.name}`).join(" · ") || "brak ćwiczeń"}</div>
              <div className="row">
                <StartStrength templateId={t.id} label="Start" icon="play" className="pri" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card mut small">
          Zapisz ulubiony trening jako szablon (przycisk pod ukończonym treningiem) albo <Link href="/silownia/szablon/nowy" style={{ color: "var(--acc)" }}>ułóż nowy</Link> — potem zaczniesz go jednym dotknięciem.
        </div>
      )}

      <div className="sec">
        <h2>Historia</h2>
        <Link href="/postepy?tab=cwiczenia">Rekordy</Link>
      </div>
      {done.map((s) => {
        const serie = s.exercises.flatMap((e) => e.sets.filter((x) => !x.warmup));
        const vol = serie.reduce((n, x) => n + (x.weight ?? 0) * (x.reps ?? 0), 0);
        const min = s.finishedAt ? Math.round((s.finishedAt.getTime() - s.startedAt.getTime()) / 60000) : 0;
        return (
          <Link key={s.id} href={`/silownia/${s.id}`} className="card link hcard" style={{ display: "block" }}>
            <div className="row"><b className="grow" style={{ fontSize: 16 }}>{s.name}</b><span className="mut small">{fmtDate(s.date)}</span></div>
            <div className="chips">
              <span><Icon name="timer" size={14} style={{ verticalAlign: -2 }} /> <b>{min}</b> min</span>
              <span><b>{Math.round(vol).toLocaleString("pl-PL")}</b> kg</span>
              <span><b>{serie.length}</b> serii</span>
              {s.analysis && <span><Icon name="chat" size={14} style={{ verticalAlign: -2 }} /> analiza</span>}
            </div>
            {s.exercises.filter((e) => e.sets.some((x) => !x.warmup)).slice(0, 5).map((e) => {
              const robocze = e.sets.filter((x) => !x.warmup);
              const kind = asKind(e.exercise.kind);
              return (
                <div key={e.id} className="ex-line">
                  <span>{robocze.length} × {e.exercise.name}</span>
                  <span>{fmtSet(kind, robocze[robocze.length - 1])}</span>
                </div>
              );
            })}
            {s.exercises.length > 5 && <div className="small mut">+{s.exercises.length - 5} więcej</div>}
          </Link>
        );
      })}
      {!done.length && <div className="card mut">Jeszcze żadnego zapisanego treningu.</div>}
    </>
  );
}
