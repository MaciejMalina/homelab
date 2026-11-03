import { moveToToday } from "@/lib/move";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { id } = (await req.json().catch(() => ({}))) as { id?: number };
  if (typeof id !== "number") return Response.json({ ok: false, error: "Brak id" }, { status: 400 });
  try {
    return Response.json({ ok: true, ...(await moveToToday(id)) });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 400 });
  }
}
