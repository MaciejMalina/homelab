import { prisma, ensureSeed } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  return Response.json(await prisma.exercise.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] }));
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { name?: string; category?: string; rest?: number };
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) return Response.json({ error: "Podaj nazwę" }, { status: 400 });
  const ex = await prisma.exercise.upsert({
    where: { name },
    update: {},
    create: { name, category: String(b.category || "Inne").slice(0, 40), rest: Math.min(600, Math.max(15, Number(b.rest) || 90)) },
  });
  return Response.json(ex);
}
