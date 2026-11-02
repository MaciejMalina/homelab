import { prisma, getSettings } from "@/lib/db";
import { parseDuration } from "@/lib/time";

export const dynamic = "force-dynamic";

const TXT = ["name", "goals", "trainingDays", "longRunDay", "sports", "gymEquipment", "injuries", "notes"] as const;

export async function PUT(req: Request) {
  await getSettings();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const k of TXT) if (typeof b[k] === "string") data[k] = (b[k] as string).slice(0, 2000);
  const n = (v: unknown) => (v === "" || v == null ? null : isFinite(Number(v)) ? Number(v) : undefined);
  for (const k of ["birthYear", "heightCm"] as const) {
    const v = n(b[k]);
    if (v !== undefined) data[k] = v === null ? null : Math.round(v);
  }
  const w = n(b.weightKg);
  if (w !== undefined) data.weightKg = w;
  const pull = n(b.pullupGoalReps);
  if (pull) data.pullupGoalReps = Math.min(100, Math.max(1, Math.round(pull)));
  if (typeof b.halfGoal === "string") {
    const sec = parseDuration(b.halfGoal);
    if (sec && sec > 3000) data.halfGoalSec = sec;
  }
  for (const k of ["gymPerWeek", "swimPerWeek", "runPerWeek"] as const) {
    const v = n(b[k]);
    if (v !== undefined && v !== null) data[k] = Math.min(7, Math.max(0, Math.round(v)));
  }
  const start = n(b.pullupStartReps);
  if (start !== undefined) data.pullupStartReps = start === null ? null : Math.min(100, Math.max(0, Math.round(start)));
  const ph = n(b.planHour);
  if (ph !== undefined && ph !== null) data.planHour = Math.min(23, Math.max(0, Math.round(ph)));
  for (const k of ["autoPlan", "autoAnalyze"] as const) if (typeof b[k] === "boolean") data[k] = b[k];
  if (["run", "endurance", "none"].includes(String(b.pushToIntervals))) data.pushToIntervals = String(b.pushToIntervals);
  const s = await prisma.settings.update({ where: { id: 1 }, data });
  return Response.json(s);
}
