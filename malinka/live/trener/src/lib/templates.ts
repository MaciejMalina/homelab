// Szablony treningów (rutyny): lista, zapis, utworzenie z ukończonego treningu
import { prisma } from "./db";
import { asKind, type Kind } from "./kinds";
import { firstImage } from "./session";

export interface TemplateItemDTO {
  exerciseId: number;
  name: string;
  category: string;
  kind: Kind;
  thumb: string | null;
  sets: number;
  target: string;
  superset: number | null;
}
export interface TemplateDTO {
  id: number;
  name: string;
  notes: string;
  lastUsed: string | null;
  items: TemplateItemDTO[];
}

const include = { items: { orderBy: { order: "asc" as const }, include: { exercise: true } } };

type Row = Awaited<ReturnType<typeof loadRows>>[number];
const loadRows = () => prisma.template.findMany({ include, orderBy: [{ lastUsed: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }] });

function toDTO(t: Row): TemplateDTO {
  return {
    id: t.id,
    name: t.name,
    notes: t.notes,
    lastUsed: t.lastUsed?.toISOString() ?? null,
    items: t.items.map((it) => ({
      exerciseId: it.exerciseId,
      name: it.exercise.name,
      category: it.exercise.category,
      kind: asKind(it.exercise.kind),
      thumb: firstImage(it.exercise.images),
      sets: it.sets,
      target: it.target,
      superset: it.superset,
    })),
  };
}

export async function listTemplates(): Promise<TemplateDTO[]> {
  return (await loadRows()).map(toDTO);
}

export async function getTemplate(id: number): Promise<TemplateDTO | null> {
  const t = await prisma.template.findUnique({ where: { id }, include });
  return t ? toDTO(t) : null;
}

type ItemIn = { exerciseId?: unknown; sets?: unknown; target?: unknown; superset?: unknown };
const int = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/** Utwórz (id = null) albo nadpisz szablon */
export async function saveTemplate(id: number | null, body: { name?: unknown; notes?: unknown; items?: ItemIn[] }) {
  const name = String(body.name ?? "").trim().slice(0, 80) || "Mój trening";
  const notes = String(body.notes ?? "").slice(0, 1000);
  const items = (Array.isArray(body.items) ? body.items : []).filter((x) => typeof x.exerciseId === "number").slice(0, 30);
  return prisma.$transaction(async (tx) => {
    const t = id
      ? await tx.template.update({ where: { id }, data: { name, notes } })
      : await tx.template.create({ data: { name, notes } });
    await tx.templateExercise.deleteMany({ where: { templateId: t.id } });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await tx.templateExercise.create({
        data: {
          templateId: t.id,
          exerciseId: it.exerciseId as number,
          order: i,
          sets: int(it.sets, 1, 10, 3),
          target: String(it.target ?? "").slice(0, 120),
          superset: it.superset == null || it.superset === "" ? null : int(it.superset, 0, 99, 0),
        },
      });
    }
    return t.id;
  });
}

/** Szablon z ukończonego (albo trwającego) treningu: te same ćwiczenia, liczba serii roboczych, superserie */
export async function templateFromSession(sessionId: number, name?: string) {
  const s = await prisma.strengthSession.findUnique({
    where: { id: sessionId },
    include: { exercises: { orderBy: { order: "asc" }, include: { sets: true } } },
  });
  if (!s) return null;
  return saveTemplate(null, {
    name: name || s.name,
    items: s.exercises.map((e) => ({
      exerciseId: e.exerciseId,
      sets: Math.max(1, e.sets.filter((x) => !x.warmup).length),
      target: e.target,
      superset: e.superset,
    })),
  });
}
