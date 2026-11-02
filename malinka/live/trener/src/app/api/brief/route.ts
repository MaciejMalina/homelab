// Fragment porannego briefu JARVIS-a (n8n na serwerze pobiera GET /api/brief)
import { prisma } from "@/lib/db";
import { goalStatus } from "@/lib/context";
import { addDays, fmtDuration, fmtPace, todayPL, weekStart } from "@/lib/time";
import { PLAN_ICON, sportGroup, sportName } from "@/lib/sport";

export const dynamic = "force-dynamic";

export async function GET() {
  const today = todayPL();
  const wczoraj = addDays(today, -1);
  const ws = weekStart(today);
  const lines: string[] = [];

  const plan = await prisma.plan.findUnique({ where: { weekStart: ws }, include: { workouts: true } });
  const dzis = plan?.workouts.filter((w) => w.date === today) ?? [];
  if (!plan) lines.push("📋 Brak planu na ten tydzień — ułóż go w appce (zakładka Plan)");
  else if (!dzis.length) lines.push("😴 Dziś nic zaplanowanego");
  else
    for (const w of dzis)
      lines.push(`${PLAN_ICON[w.sport] ?? "•"} **${w.title}**${w.durationMin ? ` (${w.durationMin} min)` : ""}${w.sport === "Odpoczynek" ? "" : ` — ${w.description.split(/(?<=\.)\s/)[0]}`}`);

  const akt = await prisma.activity.findMany({ where: { date: wczoraj } });
  const sil = await prisma.strengthSession.findMany({ where: { date: wczoraj, finishedAt: { not: null } } });
  const wcz = [
    ...akt.map((a) => {
      const g = sportGroup(a.type);
      const dist = a.distance ? ` ${(a.distance / 1000).toFixed(1).replace(".", ",")} km` : a.movingTime ? ` ${fmtDuration(a.movingTime)}` : "";
      const pace = g === "run" && a.distance && a.movingTime ? ` ${fmtPace(a.movingTime / (a.distance / 1000))}` : "";
      return `${sportName(a.type)}${dist}${pace}`;
    }),
    ...sil.map((s) => `Siłownia „${s.name}”`),
  ];
  if (wcz.length) lines.push(`✔️ Wczoraj: ${wcz.join(", ")}`);

  const sen = await prisma.wellness.findUnique({ where: { date: today } });
  if (sen?.sleepSecs || sen?.restingHr)
    lines.push(`🛌 ${sen.sleepSecs ? `Sen ${(sen.sleepSecs / 3600).toFixed(1).replace(".", ",")} h` : ""}${sen.sleepSecs && sen.restingHr ? ", " : ""}${sen.restingHr ? `HR spocz. ${sen.restingHr}` : ""}`);

  if (plan) {
    const zaplanowane = plan.workouts.filter((w) => w.sport !== "Odpoczynek" && w.date < today).length;
    const zrobione =
      (await prisma.activity.count({ where: { date: { gte: ws, lt: today } } })) +
      (await prisma.strengthSession.count({ where: { date: { gte: ws, lt: today }, finishedAt: { not: null } } }));
    if (zaplanowane) lines.push(`📈 Tydzień: ${zrobione}/${zaplanowane} zaplanowanych do wczoraj`);
  }

  const g = await goalStatus();
  const cele = [
    g.pullup ? `podciąganie ${g.pullup.reps}/${g.pullupGoal} powt.` : null,
    g.half ? `półmaraton ~${fmtDuration(g.half.sec)}` : null,
  ].filter(Boolean);
  if (cele.length) lines.push(`🎯 ${cele.join(" • ")}`);

  return Response.json({ lines });
}
