import { prisma } from "@/lib/db";
import { loadSession, saveSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const s = await loadSession(Number((await params).id));
  return s ? Response.json(s) : Response.json({ error: "Nie znaleziono" }, { status: 404 });
}

export async function PUT(req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!(await prisma.strengthSession.findUnique({ where: { id } }))) return Response.json({ error: "Nie znaleziono" }, { status: 404 });
  await saveSession(id, await req.json());
  return Response.json({ ok: true });
}

export async function DELETE(_: Request, { params }: Ctx) {
  await prisma.strengthSession.delete({ where: { id: Number((await params).id) } }).catch(() => null);
  return Response.json({ ok: true });
}
