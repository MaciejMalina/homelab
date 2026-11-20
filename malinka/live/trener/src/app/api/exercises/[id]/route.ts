import { prisma } from "@/lib/db";
import { asKind } from "@/lib/exercises";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const arr = (s: string | null) => {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

export async function GET(_: Request, { params }: Ctx) {
  const e = await prisma.exercise.findUnique({ where: { id: Number((await params).id) } });
  if (!e) return Response.json({ error: "Nie znaleziono" }, { status: 404 });
  return Response.json({ ...e, kind: asKind(e.kind), images: arr(e.images), instructions: arr(e.instructions) });
}

/** Zmiana typu serii (np. gdy appka źle zgadła dla nowego ćwiczenia) */
export async function PATCH(req: Request, { params }: Ctx) {
  const b = (await req.json().catch(() => ({}))) as { kind?: string };
  const e = await prisma.exercise
    .update({ where: { id: Number((await params).id) }, data: { ...(b.kind ? { kind: asKind(b.kind) } : {}) } })
    .catch(() => null);
  return e ? Response.json({ ok: true, kind: asKind(e.kind) }) : Response.json({ error: "Nie znaleziono" }, { status: 404 });
}
