// Zwięzły opis sytuacji treningowej dla AI (podsumowania, nie surowe strumienie — oszczędza tokeny)
import { prisma, getSettings } from "./db";
import { addDays, fmtDuration, fmtPace, todayPL, weekdayLong, weekStart } from "./time";
import { sportGroup, sportName } from "./sport";
import { bestHalfPrediction, e1rm } from "./strength";

/** Główny miernik siły: podciąganie nachwytem bez obciążenia (maks. powtórzeń w serii) */
const PULLUP = /^podciąganie nachwytem/i;
const bezObciazenia = (w: number | null) => w == null || w <= 0;

/** Status celów: rekord podciągnięć (90 dni) i prognoza półmaratonu (60 dni) */
export async function goalStatus() {
  const s = await getSettings();
  const od = addDays(todayPL(), -90);

  const sets = await prisma.strengthSet.findMany({
    where: { done: true, warmup: false, item: { session: { date: { gte: od } } } },
    include: { item: { include: { exercise: true, session: true } } },
  });
  let pullup: { reps: number; date: string } | null = null;
  for (const st of sets) {
    if (!PULLUP.test(st.item.exercise.name) || !bezObciazenia(st.weight) || !st.reps) continue;
    if (!pullup || st.reps > pullup.reps) pullup = { reps: st.reps, date: st.item.session.date };
  }

  const runs = (await prisma.activity.findMany({ where: { date: { gte: addDays(todayPL(), -60) } } })).filter((a) => sportGroup(a.type) === "run");
  const half = bestHalfPrediction(runs);

  // dopóki nic nie zapisano w appce — poziom wyjściowy podany w ustawieniach
  if (!pullup && s.pullupStartReps) pullup = { reps: s.pullupStartReps, date: "" };

  return {
    pullupGoal: s.pullupGoalReps,
    pullup,
    halfGoal: s.halfGoalSec,
    half: half ? { sec: Math.round(half.sec), activityId: half.id } : null,
  };
}

/** Najlepsze wyniki w każdym ćwiczeniu (90 dni): szac. 1RM dla serii z ciężarem, maks. powtórzeń bez ciężaru */
export async function exerciseBests(days = 90) {
  const sets = await prisma.strengthSet.findMany({
    where: { done: true, warmup: false, item: { session: { date: { gte: addDays(todayPL(), -days) } } } },
    include: { item: { include: { exercise: true, session: true } } },
  });
  const best = new Map<string, { kg: number; set: string; reps: number; date: string }>();
  for (const st of sets) {
    const name = st.item.exercise.name;
    const cur = best.get(name) ?? { kg: 0, set: "", reps: 0, date: "" };
    const v = e1rm(st.weight, st.reps);
    if (v && v > cur.kg) Object.assign(cur, { kg: v, set: `${st.weight}kg×${st.reps}`, date: st.item.session.date });
    if (bezObciazenia(st.weight) && st.reps && st.reps > cur.reps) Object.assign(cur, { reps: st.reps, date: cur.date || st.item.session.date });
    best.set(name, cur);
  }
  return best;
}

function actLine(a: {
  date: string;
  type: string;
  name: string;
  movingTime: number | null;
  distance: number | null;
  avgHr: number | null;
  maxHr: number | null;
  load: number | null;
  rpe: number | null;
}) {
  const g = sportGroup(a.type);
  const parts = [`${a.date}`, sportName(a.type)];
  if (a.name) parts.push(`„${a.name}”`);
  if (a.movingTime) parts.push(fmtDuration(a.movingTime));
  if (a.distance) parts.push(`${(a.distance / 1000).toFixed(2)} km`);
  if (a.distance && a.movingTime && g === "run") parts.push(fmtPace(a.movingTime / (a.distance / 1000)));
  if (a.distance && a.movingTime && g === "swim") parts.push(`${fmtDuration((a.movingTime / a.distance) * 100)}/100m`);
  if (a.distance && a.movingTime && g === "ride") parts.push(`${((a.distance / a.movingTime) * 3.6).toFixed(1)} km/h`);
  if (a.avgHr) parts.push(`HR śr ${a.avgHr}${a.maxHr ? `/max ${a.maxHr}` : ""}`);
  if (a.load) parts.push(`obciążenie ${a.load}`);
  if (a.rpe) parts.push(`RPE ${a.rpe}`);
  return "- " + parts.join(" | ");
}

export async function strengthSummary(sessionId: number) {
  const s = await prisma.strengthSession.findUnique({
    where: { id: sessionId },
    include: { exercises: { orderBy: { order: "asc" }, include: { exercise: true, sets: { orderBy: { order: "asc" } } } } },
  });
  if (!s) return "";
  const lines = [`${s.date} Siłownia „${s.name}”${s.finishedAt ? ` (${Math.round((s.finishedAt.getTime() - s.startedAt.getTime()) / 60000)} min)` : ""}`];
  for (const e of s.exercises) {
    const done = e.sets.filter((x) => x.done);
    if (!done.length) continue;
    const txt = done.map((x) => `${x.warmup ? "r:" : ""}${x.weight ? `${x.weight}kg×${x.reps ?? 0}` : `${x.reps ?? 0} powt.`}${x.rpe ? `@${x.rpe}` : ""}`).join(", ");
    lines.push(`  • ${e.exercise.name}: ${txt}${e.target ? ` (cel: ${e.target})` : ""}`);
  }
  if (s.notes) lines.push(`  notatka: ${s.notes}`);
  return lines.join("\n");
}

export async function buildContext(opts: { days?: number } = {}) {
  const days = opts.days ?? 28;
  const today = todayPL();
  const od = addDays(today, -days);
  const s = await getSettings();
  const goals = await goalStatus();

  const acts = await prisma.activity.findMany({ where: { date: { gte: od } }, orderBy: { startLocal: "asc" } });
  const well = await prisma.wellness.findMany({ where: { date: { gte: addDays(today, -14) } }, orderBy: { date: "asc" } });
  const sessions = await prisma.strengthSession.findMany({
    where: { date: { gte: od }, finishedAt: { not: null } },
    orderBy: { date: "asc" },
    select: { id: true },
  });
  const strength = [];
  for (const x of sessions) strength.push(await strengthSummary(x.id));

  const ws = weekStart(today);
  const plans = await prisma.plan.findMany({
    where: { weekStart: { in: [ws, addDays(ws, 7)] } },
    include: { workouts: { orderBy: { date: "asc" } } },
  });

  // tygodniowe sumy
  const tyg: Record<string, { run: number; ride: number; swim: number; gym: number; load: number }> = {};
  for (const a of acts) {
    const w = weekStart(a.date);
    tyg[w] ??= { run: 0, ride: 0, swim: 0, gym: 0, load: 0 };
    const g = sportGroup(a.type);
    if (g === "run") tyg[w].run += (a.distance ?? 0) / 1000;
    if (g === "ride") tyg[w].ride += (a.distance ?? 0) / 1000;
    if (g === "swim") tyg[w].swim += a.distance ?? 0;
    tyg[w].load += a.load ?? 0;
  }
  for (const x of await prisma.strengthSession.findMany({ where: { date: { gte: od }, finishedAt: { not: null } } })) {
    const w = weekStart(x.date);
    tyg[w] ??= { run: 0, ride: 0, swim: 0, gym: 0, load: 0 };
    tyg[w].gym += 1;
  }

  const out: string[] = [];
  out.push(`DZIŚ: ${today} (${weekdayLong(today)})`);
  out.push(`\n## Profil`);
  out.push(`Imię: ${s.name}${s.birthYear ? `, rocznik ${s.birthYear}` : ""}${s.weightKg ? `, waga ${s.weightKg} kg` : ""}${s.heightCm ? `, wzrost ${s.heightCm} cm` : ""}`);
  out.push(`Cele: ${s.goals}`);
  out.push(`Dyscypliny: ${s.sports}`);
  out.push(`Tydzień treningowy: siłownia ${s.gymPerWeek}× (każda = ok. 30 min bieżni + trening siłowy), basen ${s.swimPerWeek}×, osobne biegi ${s.runPerWeek}× (w tym długie wybieganie: ${s.longRunDay}). Dostępne dni: ${s.trainingDays}`);
  out.push(`Sprzęt: ${s.gymEquipment}`);
  if (s.injuries) out.push(`Kontuzje/ograniczenia: ${s.injuries}`);
  if (s.notes) out.push(`Uwagi: ${s.notes}`);

  out.push(`\n## Stan celów`);
  out.push(
    `Podciąganie nachwytem (bez obciążenia): cel ${s.pullupGoalReps} powt. w serii; ` +
      (goals.pullup?.date
        ? `rekord z 90 dni: ${goals.pullup.reps} powt. (${goals.pullup.date})`
        : goals.pullup
          ? `brak zapisanych serii — poziom wyjściowy wg Macieja: ${goals.pullup.reps} powt. w serii`
          : "brak zapisanych serii z 90 dni"),
  );
  out.push(
    `Półmaraton: jak najlepszy czas, punkt odniesienia ${fmtDuration(s.halfGoalSec)} (tempo ${fmtPace(s.halfGoalSec / 21.0975)}); ` +
      (goals.half ? `prognoza Riegela z najszybszego biegu ≥5 km (60 dni): ${fmtDuration(goals.half.sec)} — szacunek, łatwe biegi go zaniżają` : "brak biegów ≥5 km z 60 dni"),
  );

  const bests = await exerciseBests();
  if (bests.size) {
    out.push(`\n## Najlepsze wyniki w ćwiczeniach (90 dni, serie robocze)`);
    for (const [n, v] of [...bests.entries()].sort()) {
      const parts = [v.kg ? `szac. 1RM ${v.kg} kg (${v.set})` : null, v.reps ? `maks. ${v.reps} powt. bez ciężaru` : null].filter(Boolean);
      if (parts.length) out.push(`- ${n}: ${parts.join(", ")}`);
    }
  }

  out.push(`\n## Tygodnie (pon) — bieg km / rower km / basen m / siłownia sesje / obciążenie`);
  for (const [w, v] of Object.entries(tyg).sort()) {
    out.push(`- ${w}: ${v.run.toFixed(1)} / ${v.ride.toFixed(1)} / ${Math.round(v.swim)} / ${v.gym} / ${v.load}`);
  }

  out.push(`\n## Aktywności z zegarka (ostatnie ${days} dni)`);
  out.push(acts.length ? acts.map(actLine).join("\n") : "- brak");

  out.push(`\n## Siłownia (zapis z appki; r: = seria rozgrzewkowa)`);
  out.push(strength.filter(Boolean).join("\n") || "- brak");

  out.push(`\n## Regeneracja (14 dni): data | sen | wynik snu | HR spocz. | HRV | waga`);
  out.push(
    well.length
      ? well
          .map(
            (w) =>
              `- ${w.date} | ${w.sleepSecs ? (w.sleepSecs / 3600).toFixed(1) + " h" : "–"} | ${w.sleepScore ?? "–"} | ${w.restingHr ?? "–"} | ${w.hrv ?? "–"} | ${w.weight ?? "–"}`,
          )
          .join("\n")
      : "- brak",
  );

  for (const p of plans) {
    out.push(`\n## Plan tygodnia od ${p.weekStart}: ${p.summary}`);
    for (const w of p.workouts) out.push(`- ${w.date} ${w.sport}: ${w.title}${w.durationMin ? ` (${w.durationMin} min)` : ""}`);
  }
  return out.join("\n");
}

export async function lastActivityLine(id: string) {
  const a = await prisma.activity.findUnique({ where: { id } });
  return a ? actLine(a) : "";
}
