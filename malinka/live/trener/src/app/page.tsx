import Link from "next/link";
import { prisma, getSettings, kvGet } from "@/lib/db";
import { goalStatus } from "@/lib/context";
import { addDays, fmtDate, fmtDuration, fmtKm, fmtPace, todayPL, weekStart } from "@/lib/time";
import { ICON, PLAN_ICON, sportGroup, sportName } from "@/lib/sport";
import ActionButton from "@/components/ActionButton";
import StartStrength from "@/components/StartStrength";

export const dynamic = "force-dynamic";

export default async function Home() {
  const today = todayPL();
  const ws = weekStart(today);
  const s = await getSettings();
  const g = await goalStatus();
  const plan = await prisma.plan.findUnique({ where: { weekStart: ws }, include: { workouts: { orderBy: { id: "asc" } } } });
  const dzis = plan?.workouts.filter((w) => w.date === today) ?? [];
  const jutro = plan?.workouts.filter((w) => w.date === addDays(today, 1)) ?? [];
  const last = await prisma.activity.findMany({ orderBy: { startLocal: "desc" }, take: 4 });
  const open = await prisma.strengthSession.findFirst({ where: { finishedAt: null }, orderBy: { startedAt: "desc" } });
  const sen = await prisma.wellness.findMany({ orderBy: { date: "desc" }, take: 7 });
  const tydz = await prisma.activity.findMany({ where: { date: { gte: ws } } });
  const kmBieg = tydz.filter((a) => sportGroup(a.type) === "run").reduce((n, a) => n + (a.distance ?? 0), 0) / 1000;
  const gymTydz = await prisma.strengthSession.count({ where: { date: { gte: ws }, finishedAt: { not: null } } });
  const zrobione = new Set(
    (await prisma.strengthSession.findMany({ where: { plannedId: { in: dzis.map((w) => w.id) }, finishedAt: { not: null } }, select: { plannedId: true } })).map((x) => x.plannedId),
  );
  const sync = JSON.parse((await kvGet("lastSync")) ?? "null") as { at: string; bledy: string[] } | null;

  const pullPct = g.pullup ? Math.min(100, (g.pullup.reps / g.pullupGoal) * 100) : 0;
  const halfPct = g.half ? Math.min(100, (g.halfGoal / g.half.sec) * 100) : 0;
  const ost = sen[0];

  return (
    <>
      <div className="top">
        <h1>Cześć, {s.name} 👋</h1>
        <Link href="/ustawienia" className="btn" aria-label="Ustawienia">⚙️</Link>
      </div>

      {open && (
        <Link href={`/silownia/${open.id}`} className="card link" style={{ display: "block", borderColor: "var(--acc)" }}>
          <b>🏋️ Trwa trening: {open.name}</b>
          <div className="mut small">Wróć do zapisu serii →</div>
        </Link>
      )}

      <h2>Dziś — {fmtDate(today)}</h2>
      {!plan && (
        <div className="card">
          <p style={{ marginTop: 0 }}>Nie ma jeszcze planu na ten tydzień.</p>
          <ActionButton url="/api/plan" body={{ week: "current" }} label="Ułóż plan od dziś" busyLabel="Trener układa plan… (do minuty)" className="pri" />
        </div>
      )}
      {plan && !dzis.length && <div className="card mut">Dziś nic zaplanowanego.</div>}
      {dzis.map((w) => (
        <div key={w.id} className="card">
          <div className="row">
            <h3 className="grow">{PLAN_ICON[w.sport] ?? "•"} {w.title}</h3>
            {w.durationMin ? <span className="tag">{w.durationMin} min</span> : null}
          </div>
          <div className="mut">{w.description}</div>
          {w.intervalsText && <pre className="steps">{w.intervalsText}</pre>}
          {zrobione.has(w.id) && <div className="ok small" style={{ marginTop: 8 }}>✔ Zrobione</div>}
          {w.sport === "Siłownia" && !open && !zrobione.has(w.id) && (
            <div style={{ marginTop: 10 }}>
              <StartStrength plannedId={w.id} label="▶ Rozpocznij ten trening" />
            </div>
          )}
          {w.intervalsEventId && <div className="small mut" style={{ marginTop: 8 }}>📲 Wysłany na zegarek (Kursy → Własne kursy)</div>}
        </div>
      ))}
      {jutro.length > 0 && (
        <div className="small mut">Jutro: {jutro.map((w) => `${PLAN_ICON[w.sport] ?? ""} ${w.title}`).join(", ")}</div>
      )}

      <h2>Cele</h2>
      <div className="grid2">
        <div className="stat">
          <span>Podciąganie {g.pullup && !g.pullup.date ? "(start)" : "(rekord serii)"}</span>
          <b>{g.pullup ? `${g.pullup.reps} powt.` : "–"}</b>
          <span>cel {g.pullupGoal} powt.</span>
          <div className="bar"><i style={{ width: `${pullPct}%` }} /></div>
        </div>
        <div className="stat">
          <span>Półmaraton (prognoza)</span>
          <b>{g.half ? fmtDuration(g.half.sec) : "–"}</b>
          <span>odniesienie {fmtDuration(g.halfGoal)} · {fmtPace(g.halfGoal / 21.0975)}</span>
          <div className="bar"><i style={{ width: `${halfPct}%` }} /></div>
        </div>
      </div>

      <h2>Ten tydzień</h2>
      <div className="grid2">
        <div className="stat"><span>Bieganie</span><b>{kmBieg.toFixed(1).replace(".", ",")} km</b></div>
        <div className="stat"><span>Siłownia</span><b>{gymTydz}×</b></div>
        <div className="stat"><span>Sen (ostatnia noc)</span><b>{ost?.sleepSecs ? `${(ost.sleepSecs / 3600).toFixed(1).replace(".", ",")} h` : "–"}</b><span>{ost ? fmtDate(ost.date) : ""}</span></div>
        <div className="stat"><span>Tętno spoczynkowe</span><b>{ost?.restingHr ?? "–"}</b><span>śr. 7 dni: {avg(sen.map((x) => x.restingHr)) ?? "–"}</span></div>
      </div>

      <div className="top" style={{ marginTop: 22 }}>
        <h2 style={{ margin: 0 }}>Ostatnie treningi</h2>
        <Link href="/aktywnosci" className="small mut">wszystkie →</Link>
      </div>
      <div style={{ marginTop: 10 }}>
        {last.map((a) => {
          const gr = sportGroup(a.type);
          return (
            <Link key={a.id} href={`/aktywnosci/${a.id}`} className="card link" style={{ display: "block" }}>
              <div className="row">
                <b className="grow">{ICON[gr]} {a.name || sportName(a.type)}</b>
                <span className="mut small">{fmtDate(a.date)}</span>
              </div>
              <div className="mut small">
                {[a.distance ? fmtKm(a.distance) : null, a.movingTime ? fmtDuration(a.movingTime) : null, gr === "run" && a.distance && a.movingTime ? fmtPace(a.movingTime / (a.distance / 1000)) : null, a.avgHr ? `♥ ${a.avgHr}` : null]
                  .filter(Boolean)
                  .join(" · ")}
                {a.analysis ? " · 🤖 analiza" : ""}
              </div>
            </Link>
          );
        })}
        {!last.length && <div className="card mut">Brak treningów z zegarka — sprawdź połączenie w ustawieniach.</div>}
      </div>

      <div className="row small mut" style={{ marginTop: 14 }}>
        <span className="grow">
          Synchronizacja: {sync ? new Date(sync.at).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "short" }) : "jeszcze nie było"}
          {sync?.bledy?.length ? <span className="err"> · {sync.bledy[0].slice(0, 80)}</span> : null}
        </span>
        <ActionButton url="/api/sync" label="↻ Synchronizuj" busyLabel="Synchronizuję…" />
      </div>
    </>
  );
}

function avg(xs: (number | null)[]) {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}
