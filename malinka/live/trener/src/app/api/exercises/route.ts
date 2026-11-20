import { prisma, ensureSeed } from "@/lib/db";
import { asKind, guessKind } from "@/lib/exercises";

export const dynamic = "force-dynamic";

/** Lista ćwiczeń (bez instrukcji) + ile razy używane — do wyszukiwarki w loggerze */
export async function GET() {
  await ensureSeed();
  const ex = await prisma.exercise.findMany({
    select: { id: true, name: true, nameEn: true, category: true, kind: true, rest: true, core: true, muscles: true, images: true, instructions: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  const uzycie = await prisma.sessionExercise.groupBy({ by: ["exerciseId"], _count: { _all: true } });
  const ile = new Map(uzycie.map((u) => [u.exerciseId, u._count._all]));
  return Response.json(
    ex.map((e) => ({
      id: e.id,
      name: e.name,
      nameEn: e.nameEn,
      category: e.category,
      kind: asKind(e.kind),
      rest: e.rest,
      core: e.core,
      muscles: e.muscles,
      info: !!(e.images || e.instructions),
      used: ile.get(e.id) ?? 0,
    })),
  );
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { name?: string; category?: string; rest?: number; kind?: string };
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) return Response.json({ error: "Podaj nazwę" }, { status: 400 });
  const kind = b.kind ? asKind(b.kind) : guessKind(name);
  const ex = await prisma.exercise.upsert({
    where: { name },
    update: {},
    create: { name, category: String(b.category || "Inne").slice(0, 40), rest: Math.min(600, Math.max(15, Number(b.rest) || 90)), kind },
  });
  return Response.json({ ...ex, kind: asKind(ex.kind), info: false, used: 0 });
}
