// Dane dla zakładki "Trening" na panelu w telefonie (jarvis_panel pobiera GET /api/panel).
import { prisma } from "@/lib/db";
import { goalStatus } from "@/lib/context";
import { addDays, todayPL, weekStart, weekdayShort } from "@/lib/time";
import { PLAN_ICON, sportGroup, sportName } from "@/lib/sport";

export const dynamic = "force-dynamic";

type Cwiczenie = { nazwa: string; serie: number | null; powt: string | null; kg: number | null; uwagi: string | null };

function sila(json: string | null): Cwiczenie[] | null {
  if (!json) return null;
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    return arr.map((x: Record<string, unknown>) => ({
      nazwa: String(x.nazwa ?? ""),
      serie: typeof x.serie === "number" ? x.serie : null,
      powt: x.powtorzenia == null ? null : String(x.powtorzenia),
      kg: typeof x.ciezar_kg === "number" ? x.ciezar_kg : null,
      uwagi: x.uwagi == null ? null : String(x.uwagi),
    }));
  } catch {
    return null;
  }
}

export async function GET() {
  const today = todayPL();
  const ws = weekStart(today);
  const we = addDays(ws, 6);

  const plan = await prisma.plan.findUnique({ where: { weekStart: ws }, include: { workouts: true } });
  const akt = await prisma.activity.findMany({ where: { date: { gte: ws, lte: we } } });
  const sil = await prisma.strengthSession.findMany({ where: { date: { gte: ws, lte: we }, finishedAt: { not: null } } });

  const dni = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(ws, i);
    return {
      date,
      dzien: weekdayShort(date),
      dzis: date === today,
      plan: (plan?.workouts ?? [])
        .filter((w) => w.date === date)
        .map((w) => ({
          sport: w.sport,
          ikona: PLAN_ICON[w.sport] ?? "•",
          tytul: w.title,
          min: w.durationMin,
          opis: w.description,
          sila: sila(w.strength),
        })),
      zrobione: [
        ...akt
          .filter((a) => a.date === date)
          .map((a) => ({ typ: sportName(a.type), grupa: sportGroup(a.type) as string, km: a.distance ? a.distance / 1000 : null, sek: a.movingTime })),
        ...sil.filter((s) => s.date === date).map((s) => ({ typ: `Siłownia „${s.name}”`, grupa: "strength", km: null, sek: null })),
      ],
    };
  });

  const g = await goalStatus();
  const sen = await prisma.wellness.findUnique({ where: { date: today } });

  return Response.json({
    tydzien: ws,
    podsumowanie: plan?.summary ?? null,
    dni,
    cele: {
      klata: g.bench ? { kg: g.bench.kg, cel: g.benchGoal, seria: g.bench.set } : { kg: null, cel: g.benchGoal, seria: null },
      polmaraton: { sek: g.half?.sec ?? null, cel: g.halfGoal },
    },
    wellness: sen
      ? { senH: sen.sleepSecs ? sen.sleepSecs / 3600 : null, hrSpocz: sen.restingHr, hrv: sen.hrv, waga: sen.weight }
      : null,
  });
}
