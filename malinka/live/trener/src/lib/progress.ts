// Postępy: historia ćwiczenia, mapa mięśni, kalendarz i seria tygodni
import { prisma } from "./db";
import { asKind, fmtSet, type Kind } from "./kinds";
import { bestOf, describeBest } from "./bests";
import { e1rm } from "./strength";
import { parseMuscles, type Muscle } from "./muscles";
import { addDays, todayPL, weekStart } from "./time";
import { sportGroup, type Group } from "./sport";

const doneSets = { where: { done: true, warmup: false }, orderBy: { order: "asc" as const } };

export interface HistoryPoint {
  sessionId: number;
  date: string;
  sets: string[];
  e1rm: number | null;
  maxKg: number | null;
  volume: number;
  reps: number | null;
  seconds: number | null;
  meters: number | null;
}

/** Historia ćwiczenia: po jednym punkcie na ukończony trening */
export async function exerciseHistory(exerciseId: number) {
  const ex = await prisma.exercise.findUnique({ where: { id: exerciseId } });
  if (!ex) return null;
  const kind = asKind(ex.kind);
  const rows = await prisma.sessionExercise.findMany({
    where: { exerciseId, session: { finishedAt: { not: null } } },
    include: { session: true, sets: doneSets },
    orderBy: { session: { startedAt: "asc" } },
  });
  const points: HistoryPoint[] = [];
  for (const r of rows) {
    if (!r.sets.length) continue;
    const s = r.sets;
    const max = (f: (x: (typeof s)[number]) => number | null | undefined) => {
      const v = s.map(f).filter((x): x is number => typeof x === "number" && x > 0);
      return v.length ? Math.max(...v) : null;
    };
    points.push({
      sessionId: r.sessionId,
      date: r.session.date,
      sets: s.map((x) => fmtSet(kind, x)),
      e1rm: max((x) => e1rm(x.weight, x.reps)),
      maxKg: max((x) => x.weight),
      volume: Math.round(s.reduce((n, x) => n + (x.weight ?? 0) * (x.reps ?? 0), 0)),
      reps: max((x) => x.reps),
      seconds: max((x) => x.seconds),
      meters: max((x) => x.meters),
    });
  }
  const best = describeBest(bestOf(kind, rows.flatMap((r) => r.sets)));
  return { exercise: { id: ex.id, name: ex.name, category: ex.category, kind, images: ex.images, muscles: ex.muscles }, points, best };
}

export interface TrainedExercise {
  id: number;
  name: string;
  category: string;
  kind: Kind;
  sessions: number;
  last: string;
  best: string;
  /** główna miara z ostatnich treningów (do mini-wykresu) */
  spark: number[];
}

/** Ćwiczenia, które kiedykolwiek robiłeś — ostatnio trenowane na górze */
export async function trainedExercises(): Promise<TrainedExercise[]> {
  const rows = await prisma.sessionExercise.findMany({
    where: { session: { finishedAt: { not: null } } },
    include: { exercise: true, session: true, sets: doneSets },
    orderBy: { session: { startedAt: "asc" } },
  });
  const g = new Map<number, { ex: (typeof rows)[number]["exercise"]; items: typeof rows }>();
  for (const r of rows) {
    if (!r.sets.length) continue;
    const x = g.get(r.exerciseId) ?? { ex: r.exercise, items: [] };
    x.items.push(r);
    g.set(r.exerciseId, x);
  }
  const out: TrainedExercise[] = [];
  for (const [id, { ex, items }] of g) {
    const kind = asKind(ex.kind);
    const miara = (sets: (typeof rows)[number]["sets"]) => {
      const v = sets.map((s) =>
        kind === "weight_reps" ? e1rm(s.weight, s.reps) : kind === "time" ? s.seconds : kind === "distance" ? s.meters : s.reps,
      );
      return Math.max(0, ...v.filter((n): n is number => typeof n === "number"));
    };
    out.push({
      id,
      name: ex.name,
      category: ex.category,
      kind,
      sessions: items.length,
      last: items[items.length - 1].session.date,
      best: describeBest(bestOf(kind, items.flatMap((i) => i.sets))),
      spark: items.slice(-12).map((i) => Math.round(miara(i.sets) * 10) / 10),
    });
  }
  return out.sort((a, b) => b.last.localeCompare(a.last) || b.sessions - a.sessions);
}

/** Serie robocze na grupę mięśni z ostatnich `days` dni (pomocnicze liczą się za pół) */
export async function muscleLoad(days = 7) {
  const from = addDays(todayPL(), -(days - 1));
  const sets = await prisma.strengthSet.findMany({
    where: { done: true, warmup: false, item: { session: { date: { gte: from }, finishedAt: { not: null } } } },
    include: { item: { include: { exercise: true } } },
  });
  const load: Partial<Record<Muscle, number>> = {};
  for (const s of sets) {
    for (const [m, w] of parseMuscles(s.item.exercise.muscles, s.item.exercise.category)) load[m] = (load[m] ?? 0) + w;
  }
  return { load, sets: sets.length, from };
}

export interface DayMark {
  gym: number;
  groups: Group[];
}

/** Dni z treningami w miesiącu "YYYY-MM" (siłownia z appki + aktywności z zegarka) */
export async function monthMarks(ym: string) {
  const from = `${ym}-01`;
  const to = `${ym}-31`;
  const gym = await prisma.strengthSession.findMany({ where: { date: { gte: from, lte: to }, finishedAt: { not: null } }, select: { date: true } });
  const acts = await prisma.activity.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, type: true } });
  const out: Record<string, DayMark> = {};
  const day = (d: string) => (out[d] ??= { gym: 0, groups: [] });
  for (const g of gym) day(g.date).gym++;
  for (const a of acts) {
    const gr = sportGroup(a.type);
    // trening siłowy z zegarka i tak jest w appce — nie dubluj kropki
    if (gr === "strength") continue;
    const d = day(a.date);
    if (!d.groups.includes(gr)) d.groups.push(gr);
  }
  return out;
}

/** Ile tygodni z rzędu był co najmniej jeden trening (bieżący tydzień bez treningu jeszcze nie przerywa serii) */
export async function weekStreak() {
  const from = addDays(todayPL(), -730);
  const gym = await prisma.strengthSession.findMany({ where: { date: { gte: from }, finishedAt: { not: null } }, select: { date: true } });
  const acts = await prisma.activity.findMany({ where: { date: { gte: from } }, select: { date: true } });
  const tyg = new Set([...gym, ...acts].map((x) => weekStart(x.date)));
  let w = weekStart(todayPL());
  if (!tyg.has(w)) w = addDays(w, -7);
  let n = 0;
  while (tyg.has(w)) {
    n++;
    w = addDays(w, -7);
  }
  return n;
}
