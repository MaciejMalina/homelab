// Przenoszenie zaplanowanego treningu na dziś (bez AI) + wykrywanie, co z planu jest już zrobione
import { prisma } from "./db";
import { intervalsConfigured, moveEvent } from "./intervals";
import { addDays, todayPL, weekStart } from "./time";
import { sportGroup } from "./sport";

type PW = { id: number; date: string; sport: string; title: string };

const GRUPA: Record<string, string> = { Bieg: "run", Rower: "ride", Basen: "swim" };
const jestBieznia = (w: PW) => w.sport === "Bieg" && /^bieżnia/i.test(w.title.trim());

/** Zbiór id pozycji planu, które są już wykonane (siłownia: zakończona sesja z planu; reszta: aktywność z zegarka tego dnia) */
export async function doneIds(workouts: PW[]): Promise<Set<number>> {
  if (!workouts.length) return new Set();
  const daty = [...new Set(workouts.map((w) => w.date))];
  const akt = await prisma.activity.findMany({ where: { date: { in: daty } }, select: { date: true, type: true } });
  const sil = await prisma.strengthSession.findMany({
    where: { plannedId: { in: workouts.map((w) => w.id) }, finishedAt: { not: null } },
    select: { plannedId: true },
  });
  const done = new Set<number>(sil.map((s) => s.plannedId!).filter(Boolean));
  for (const w of workouts) {
    const g = GRUPA[w.sport];
    if (g && akt.some((a) => a.date === w.date && sportGroup(a.type) === g)) done.add(w.id);
  }
  return done;
}

/** Pozycje do przeniesienia razem: siłownia i jej bieżnia z tego samego dnia idą w parze */
async function pakiet(w: PW & { planId: number }): Promise<PW[]> {
  const tenDzien = await prisma.plannedWorkout.findMany({ where: { planId: w.planId, date: w.date } });
  if (w.sport === "Siłownia") return [w, ...tenDzien.filter((x) => x.id !== w.id && jestBieznia(x))];
  if (jestBieznia(w)) return [w, ...tenDzien.filter((x) => x.id !== w.id && x.sport === "Siłownia")];
  return [w];
}

export async function moveToToday(id: number) {
  const today = todayPL();
  const ws = weekStart(today);
  const w = await prisma.plannedWorkout.findUnique({ where: { id }, include: { plan: true } });
  if (!w) throw new Error("Nie ma takiego treningu w planie");
  if (w.date === today) throw new Error("Ten trening już jest na dziś");
  if (w.plan.weekStart !== ws || w.date < ws || w.date > addDays(ws, 6)) throw new Error("Przenosić można tylko treningi z bieżącego tygodnia");
  if (w.sport === "Odpoczynek") throw new Error("Odpoczynku nie przenosimy 🙂");

  const doPrzeniesienia = await pakiet(w);
  const ostrzezenia: string[] = [];
  for (const x of doPrzeniesienia) {
    const full = await prisma.plannedWorkout.findUniqueOrThrow({ where: { id: x.id } });
    await prisma.plannedWorkout.update({ where: { id: x.id }, data: { date: today } });
    if (full.intervalsEventId && intervalsConfigured()) {
      try {
        await moveEvent(full.intervalsEventId, today);
      } catch (e) {
        ostrzezenia.push(`${full.title}: nie udało się przesunąć na zegarku (${String((e as Error).message).slice(0, 80)})`);
      }
    }
  }
  return { przeniesione: doPrzeniesienia.map((x) => x.title), ostrzezenia };
}

/** Niezrobione treningi z minionych dni bieżącego tygodnia (do „nadrobienia”) */
export async function zalegle() {
  const today = todayPL();
  const ws = weekStart(today);
  const plan = await prisma.plan.findUnique({ where: { weekStart: ws }, include: { workouts: { orderBy: [{ date: "asc" }, { id: "asc" }] } } });
  if (!plan) return [];
  const minione = plan.workouts.filter((w) => w.date < today && w.date >= ws && w.date <= addDays(ws, 6) && w.sport !== "Odpoczynek");
  const done = await doneIds(minione);
  // bieżnię pokazujemy razem z jej siłownią, więc osobno jej nie listujemy, jeśli siłownia tego dnia jest
  return minione.filter((w) => !done.has(w.id) && !(jestBieznia(w) && minione.some((s) => s.date === w.date && s.sport === "Siłownia")));
}
