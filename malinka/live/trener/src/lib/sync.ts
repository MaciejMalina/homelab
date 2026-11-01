// Synchronizacja z intervals.icu + automatyczne analizy
import { prisma, getSettings, kvGet, kvSet } from "./db";
import { getActivityDetail, intervalsConfigured, listActivities, listWellness, mapActivity, mapLaps, mapWellness, slimRaw } from "./intervals";
import { analyzeActivity } from "./coach";
import { claudeConfigured } from "./claude";
import { addDays, todayPL } from "./time";

export interface SyncResult {
  nowe: number;
  zaktualizowane: number;
  wellness: number;
  przeanalizowane: number;
  bledy: string[];
}

let running: Promise<SyncResult> | null = null;

/** Pobiera aktywności i wellness. Pierwsze uruchomienie: 120 dni historii (bez analiz). */
export function syncAll(): Promise<SyncResult> {
  if (!running) running = doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<SyncResult> {
  const r: SyncResult = { nowe: 0, zaktualizowane: 0, wellness: 0, przeanalizowane: 0, bledy: [] };
  if (!intervalsConfigured()) {
    r.bledy.push("intervals.icu nie jest skonfigurowane (.env)");
    return r;
  }
  const today = todayPL();
  const first = !(await kvGet("firstSyncDone"));
  const oldest = addDays(today, first ? -120 : -4);
  const analyzeFrom = addDays(today, -2); // tylko świeże aktywności dostają analizę AI

  try {
    const acts = await listActivities(oldest, today);
    for (const raw of acts) {
      const a = mapActivity(raw);
      if (!a.id || !a.date) continue;
      const prev = await prisma.activity.findUnique({ where: { id: a.id }, select: { id: true, laps: true } });
      let laps = prev?.laps ?? undefined;
      if (!laps) {
        try {
          laps = mapLaps(await getActivityDetail(a.id));
        } catch (e) {
          console.error("[sync] odcinki", a.id, e);
        }
      }
      const data = { ...a, laps, raw: slimRaw(raw) };
      if (prev) {
        await prisma.activity.update({ where: { id: a.id }, data });
        r.zaktualizowane++;
      } else {
        await prisma.activity.create({ data: { ...data, skipAnalysis: first || a.date < analyzeFrom } });
        r.nowe++;
      }
    }
  } catch (e) {
    r.bledy.push(String((e as Error).message ?? e));
  }

  try {
    const well = await listWellness(oldest, today);
    for (const raw of well) {
      const w = mapWellness(raw);
      if (!w.date) continue;
      const data = { ...w, raw: slimRaw(raw) };
      await prisma.wellness.upsert({ where: { date: w.date }, update: data, create: data });
      r.wellness++;
    }
  } catch (e) {
    r.bledy.push(String((e as Error).message ?? e));
  }

  if (first && !r.bledy.length) await kvSet("firstSyncDone", today);

  // analizy AI — maks. 3 na przebieg, najstarsze najpierw
  const s = await getSettings();
  if (s.autoAnalyze && claudeConfigured()) {
    const todo = await prisma.activity.findMany({
      where: { analysis: null, skipAnalysis: false, date: { gte: analyzeFrom } },
      orderBy: { startLocal: "asc" },
      take: 3,
    });
    for (const a of todo) {
      try {
        await analyzeActivity(a.id);
        r.przeanalizowane++;
      } catch (e) {
        r.bledy.push(`analiza ${a.id}: ${String((e as Error).message ?? e).slice(0, 200)}`);
        // nie próbuj w nieskończoność — po błędzie oznacz do ręcznego ponowienia
        await prisma.activity.update({ where: { id: a.id }, data: { skipAnalysis: true } });
      }
    }
  }

  await kvSet("lastSync", JSON.stringify({ at: new Date().toISOString(), ...r }));
  return r;
}
