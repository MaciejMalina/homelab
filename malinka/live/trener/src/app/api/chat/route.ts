import { prisma } from "@/lib/db";
import { chat } from "@/lib/coach";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const msgs = await prisma.chatMessage.findMany({ orderBy: { id: "desc" }, take: 60 });
  return Response.json(msgs.reverse());
}

export async function POST(req: Request) {
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  const text = String(message ?? "").trim().slice(0, 4000);
  if (!text) return Response.json({ error: "Pusta wiadomość" }, { status: 400 });
  try {
    return Response.json({ reply: await chat(text) });
  } catch (e) {
    return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}

export async function DELETE() {
  await prisma.chatMessage.deleteMany();
  return Response.json({ ok: true });
}
