import { generatePlan } from "@/lib/coach";
import { addDays, todayPL, weekStart } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { week?: "current" | "next"; uwagi?: string };
  const ws = weekStart(todayPL());
  try {
    const plan = await generatePlan(body.week === "next" ? addDays(ws, 7) : ws, String(body.uwagi ?? "").slice(0, 1000));
    return Response.json({ ok: true, id: plan.id });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
