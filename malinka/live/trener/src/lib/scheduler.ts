// Harmonogram w procesie serwera (startuje z instrumentation.ts)
//  - co 20 min: synchronizacja z intervals.icu + analizy nowych treningów
//  - niedziela o godzinie z ustawień: plan na kolejny tydzień (jeśli jeszcze go nie ma)
import { prisma, getSettings, kvSet } from "./db";
import { syncAll } from "./sync";
import { generatePlan } from "./coach";
import { claudeConfigured } from "./claude";
import { notify, COLOR } from "./discord";
import { addDays, nowPL, weekStart, weekdayIdx } from "./time";

const SYNC_EVERY_MIN = 20;
let started = false;
let lastSyncAt = 0;
let planBusy = false;

export function startScheduler() {
  if (started) return;
  started = true;
  console.log("[scheduler] start");
  setTimeout(tick, 15_000); // pierwszy przebieg chwilę po starcie
  setInterval(tick, 60_000);
}

async function tick() {
  try {
    if (Date.now() - lastSyncAt >= SYNC_EVERY_MIN * 60_000) {
      lastSyncAt = Date.now();
      const r = await syncAll();
      if (r.nowe || r.bledy.length) console.log("[scheduler] sync", JSON.stringify(r));
    }
    await maybePlan();
  } catch (e) {
    console.error("[scheduler]", e);
  }
}

async function maybePlan() {
  if (planBusy || !claudeConfigured()) return;
  const s = await getSettings();
  if (!s.autoPlan) return;
  const { date, hour } = nowPL();
  if (weekdayIdx(date) !== 0 || hour < s.planHour) return;
  const next = addDays(weekStart(date), 7);
  if (await prisma.plan.findUnique({ where: { weekStart: next } })) return;

  planBusy = true;
  try {
    await syncAll(); // świeże dane przed planowaniem
    await generatePlan(next);
    console.log("[scheduler] plan na", next);
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    console.error("[scheduler] plan", msg);
    await kvSet("lastPlanError", JSON.stringify({ at: new Date().toISOString(), msg }));
    await notify({ title: "⚠️ Nie udało się ułożyć planu", description: `${msg}\n\nSpróbuję ponownie za godzinę albo ułóż ręcznie w zakładce Plan.`, color: COLOR.err, path: "/plan" });
    // kolejna próba za godzinę: przesuń "blokadę" przez odczekanie
    await new Promise((r) => setTimeout(r, 60 * 60_000));
  } finally {
    planBusy = false;
  }
}
