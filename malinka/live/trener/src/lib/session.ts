// Odczyt/zapis sesji siłowej dla loggera (typy współdzielone z komponentem klienta)
import { prisma, exerciseByName } from "./db";
import { parseStrength } from "./coach";
import { todayPL } from "./time";

export interface SetDTO {
  weight: number | null;
  reps: number | null;
  rpe: number | null;
  warmup: boolean;
  done: boolean;
}
export interface ItemDTO {
  exerciseId: number;
  name: string;
  category: string;
  rest: number;
  notes: string;
  target: string;
  sets: SetDTO[];
  /** serie z poprzedniego treningu z tym ćwiczeniem */
  prev: { weight: number | null; reps: number | null; warmup: boolean }[];
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
  items: ItemDTO[];
}

export async function previousSets(exerciseId: number, excludeSessionId: number) {
  const last = await prisma.sessionExercise.findFirst({
    where: { exerciseId, sessionId: { not: excludeSessionId }, session: { finishedAt: { not: null } } },
    orderBy: { session: { startedAt: "desc" } },
    include: { sets: { where: { done: true }, orderBy: { order: "asc" } } },
  });
  return (last?.sets ?? []).map((s) => ({ weight: s.weight, reps: s.reps, warmup: s.warmup }));
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
      rest: e.exercise.rest,
      notes: e.notes,
      target: e.target,
      sets: e.sets.map((x) => ({ weight: x.weight, reps: x.reps, rpe: x.rpe, warmup: x.warmup, done: x.done })),
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
    items,
  };
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
          sets: {
            create: (Array.isArray(it.sets) ? it.sets : []).slice(0, 30).map((x, j) => ({
              order: j,
              weight: num(x.weight),
              reps: num(x.reps) === null ? null : Math.round(num(x.reps)!),
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

export async function createSession(opts: { plannedId?: number | null; name?: string }) {
  const planned = opts.plannedId ? await prisma.plannedWorkout.findUnique({ where: { id: opts.plannedId } }) : null;
  const s = await prisma.strengthSession.create({
    data: { name: (opts.name || planned?.title || "Trening siłowy").slice(0, 120), date: todayPL(), plannedId: planned?.id ?? null },
  });
  const plan = parseStrength(planned?.strength ?? null);
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const ex = await exerciseByName(p.nazwa);
    const reps = firstNum(p.powtorzenia);
    const serie = Math.min(Math.max(1, Number(p.serie) || 1), 10);
    await prisma.sessionExercise.create({
      data: {
        sessionId: s.id,
        exerciseId: ex.id,
        order: i,
        target: `${serie}×${p.powtorzenia}${p.ciezar_kg ? ` @ ${p.ciezar_kg} kg` : ""}${p.rpe ? ` RPE ${p.rpe}` : ""}${p.uwagi ? ` — ${p.uwagi}` : ""}`.slice(0, 200),
        sets: { create: Array.from({ length: serie }, (_, j) => ({ order: j, weight: p.ciezar_kg ?? null, reps, rpe: null })) },
      },
    });
  }
  return s.id;
}
