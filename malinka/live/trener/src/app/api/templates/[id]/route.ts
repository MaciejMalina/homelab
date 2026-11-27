import { prisma } from "@/lib/db";
import { getTemplate, saveTemplate } from "@/lib/templates";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const t = await getTemplate(Number((await params).id));
  return t ? Response.json(t) : Response.json({ error: "Nie znaleziono" }, { status: 404 });
}

export async function PUT(req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!(await prisma.template.findUnique({ where: { id } }))) return Response.json({ error: "Nie znaleziono" }, { status: 404 });
  return Response.json({ id: await saveTemplate(id, await req.json().catch(() => ({}))) });
}

export async function DELETE(_: Request, { params }: Ctx) {
  await prisma.template.delete({ where: { id: Number((await params).id) } }).catch(() => null);
  return Response.json({ ok: true });
}
