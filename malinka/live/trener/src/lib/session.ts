// Odczyt/zapis sesji siłowej dla loggera (typy współdzielone z komponentem klienta)
import { prisma, exerciseByName } from "./db";
import { parseStrength } from "./coach";
import { todayPL } from "./time";
import { asKind, fmtPlanTarget, type Kind } from "./kinds";

export interface SetDTO {
  weight: number | null;
  reps: number | null;
  seconds: number | null;
  meters: number | null;
  rpe: number | null;
  warmup: boolean;
  done: boolean;
}
export type PrevSet = { weight: number | null; reps: number | null; seconds: number | null; meters: number | null; warmup: boolean };
export interface ItemDTO {
  exerciseId: number;
  name: string;
  category: string;
  kind: Kind;
  /** czy ćwiczenie ma zdjęcia/instrukcję z biblioteki */
  info: boolean;
  /** pierwsze zdjęcie z biblioteki (ścieżka względem IMG_BASE) — miniatura w karcie */
  thumb: string | null;
  /** numer superserii albo null */
  superset: number | null;
  rest: number;
  notes: string;
  target: string;
  sets: SetDTO[];
  /** serie z poprzedniego treningu z tym ćwiczeniem */
  prev: PrevSet[];
}
export interface SessionDTO {
  id: number;
  name: string;
  date: string;
  startedAt: string;
  finishedAt: string | null;
  notes: string;
  analysis: string | null;
  plannedTitle: string | null;
  templateId: number | null;
  items: ItemDTO[];
}

export async function previousSets(exerciseId: number, excludeSessionId: number) {
  const last = await prisma.sessionExercise.findFirst({
    where: { exerciseId, sessionId: { not: excludeSessionId }, session: { finishedAt: { not: null } } },
    orderBy: { session: { startedAt: "desc" } },
    include: { sets: { where: { done: true }, orderBy: { order: "asc" } } },
  });
  return (last?.sets ?? []).map((s) => ({ weight: s.weight, reps: s.reps, seconds: s.seconds, meters: s.meters, warmup: s.warmup }));
}

export async function loadSession(id: number): Promise<SessionDTO | null> {
  const s = await prisma.strengthSession.findUnique({
    where: { id },
    include: { exercises: { orderBy: { order: "asc" }, include: { exercise: true, sets: { orderBy: { order: "asc" } } } } },
  });
  if (!s) return null;
  const planned = s.plannedId ? await prisma.plannedWorkout.findUnique({ where: { id: s.plannedId } }) : null;
  const items: ItemDTO[] = [];
  for (const e of s.exercises) {
    items.push({
      exerciseId: e.exerciseId,
      name: e.exercise.name,
      category: e.exercise.category,
      kind: asKind(e.exercise.kind),
      info: !!(e.exercise.images || e.exercise.instructions),
      thumb: firstImage(e.exercise.images),
      superset: e.superset,
      rest: e.exercise.rest,
      notes: e.notes,
      target: e.target,
      sets: e.sets.map((x) => ({ weight: x.weight, reps: x.reps, seconds: x.seconds, meters: x.meters, rpe: x.rpe, warmup: x.warmup, done: x.done })),
      prev: await previousSets(e.exerciseId, s.id),
    });
  }
  return {
    id: s.id,
    name: s.name,
    date: s.date,
    startedAt: s.startedAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    notes: s.notes,
    analysis: s.analysis,
    plannedTitle: planned?.title ?? null,
    templateId: s.templateId,
    items,
  };
}

/** Pierwsza ścieżka z JSON-a zdjęć ćwiczenia */
export function firstImage(images: string | null | undefined): string | null {
  if (!images) return null;
  try {
    const a = JSON.parse(images);
    return Array.isArray(a) && typeof a[0] === "string" ? a[0] : null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

/** Zapis całego stanu sesji (zastępuje ćwiczenia i serie) */
export async function saveSession(id: number, body: { name?: string; notes?: string; items?: Partial<ItemDTO>[] }) {
  const items = Array.isArray(body.items) ? body.items : [];
  await prisma.$transaction(async (tx) => {
    await tx.strengthSession.update({
      where: { id },
      data: { ...(typeof body.name === "string" ? { name: body.name.slice(0, 120) } : {}), ...(typeof body.notes === "string" ? { notes: body.notes.slice(0, 2000) } : {}) },
    });
    await tx.sessionExercise.deleteMany({ where: { sessionId: id } });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (typeof it.exerciseId !== "number") continue;
      if (typeof it.rest === "number" && it.rest >= 15 && it.rest <= 600) {
        await tx.exercise.updateMany({ where: { id: it.exerciseId, rest: { not: Math.round(it.rest) } }, data: { rest: Math.round(it.rest) } });
      }
      await tx.sessionExercise.create({
        data: {
          sessionId: id,
          exerciseId: it.exerciseId,
          order: i,
          notes: String(it.notes ?? "").slice(0, 500),
          target: String(it.target ?? "").slice(0, 200),
          superset: typeof it.superset === "number" && isFinite(it.superset) ? Math.round(it.superset) : null,
          sets: {
            create: (Array.isArray(it.sets) ? it.sets : []).slice(0, 30).map((x, j) => ({
              order: j,
              weight: num(x.weight),
              reps: num(x.reps) === null ? null : Math.round(num(x.reps)!),
              seconds: num(x.seconds) === null ? null : Math.round(num(x.seconds)!),
              meters: num(x.meters),
              rpe: num(x.rpe),
              warmup: !!x.warmup,
              done: !!x.done,
            })),
          },
        },
      });
    }
  });
}

/** Pierwsza liczba z "8-10" / "5" / "AMRAP" -> 8 / 5 / null */
const firstNum = (t: string) => {
  const m = String(t).match(/\d+/);
  return m ? Number(m[0]) : null;
};

export async function createSession(opts: { plannedId?: number | null; templateId?: number | null; name?: string }) {
  if (opts.templateId) {
    const t = await prisma.template.findUnique({ where: { id: opts.templateId }, include: { items: { orderBy: { order: "asc" } } } });
    if (t) {
      const s = await prisma.strengthSession.create({
        data: { name: (opts.name || t.name).slice(0, 120), date: todayPL(), templateId: t.id, notes: "" },
      });
      for (const it of t.items) {
        await prisma.sessionExercise.create({
          data: {
            sessionId: s.id,
            exerciseId: it.exerciseId,
            order: it.order,
            target: it.target,
            superset: it.superset,
            sets: { create: Array.from({ length: Math.min(Math.max(1, it.sets), 10) }, (_, j) => ({ order: j })) },
          },
        });
      }
      await prisma.template.update({ where: { id: t.id }, data: { lastUsed: new Date() } });
      return s.id;
    }
  }
  const planned = opts.plannedId ? await prisma.plannedWorkout.findUnique({ where: { id: opts.plannedId } }) : null;
  const s = await prisma.strengthSession.create({
    data: { name: (opts.name || planned?.title || "Trening siłowy").slice(0, 120), date: todayPL(), plannedId: planned?.id ?? null },
  });
  const plan = parseStrength(planned?.strength ?? null);
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const ex = await exerciseByName(p.nazwa);
    const kind = asKind(ex.kind);
    const reps = kind === "time" || kind === "distance" ? null : firstNum(p.powtorzenia ?? "");
    const seconds = kind === "time" ? (p.czas_s ?? firstNum(p.powtorzenia ?? "")) : null;
    const meters = kind === "distance" ? (p.dystans_m ?? null) : null;
    const serie = Math.min(Math.max(1, Number(p.serie) || 1), 10);
    await prisma.sessionExercise.create({
      data: {
        sessionId: s.id,
        exerciseId: ex.id,
        order: i,
        target: fmtPlanTarget({ ...p, serie }).slice(0, 200),
        sets: { create: Array.from({ length: serie }, (_, j) => ({ order: j, weight: p.ciezar_kg ?? null, reps, seconds, meters, rpe: null })) },
      },
    });
  }
  return s.id;
}
