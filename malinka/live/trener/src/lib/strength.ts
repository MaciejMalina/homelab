// Szacunki siłowe i biegowe — czyste funkcje (testy: strength.test.ts)

/** Szacowane 1RM wzorem Epleya. Powyżej 12 powtórzeń szacunek jest zbyt niepewny -> null. */
export function e1rm(weight?: number | null, reps?: number | null): number | null {
  if (!weight || !reps || weight <= 0 || reps <= 0 || reps > 12) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

/** Prognoza czasu na innym dystansie wzorem Riegela (wykładnik 1.06). */
export function riegel(timeSec: number, distM: number, targetM: number): number {
  return timeSec * Math.pow(targetM / distM, 1.06);
}

export const HALF_M = 21097.5;

/** Najlepsza prognoza półmaratonu z listy biegów (≥ 5 km). Zwraca sekundy i bieg źródłowy. */
export function bestHalfPrediction(runs: { id: string; distance?: number | null; movingTime?: number | null }[]) {
  let best: { sec: number; id: string } | null = null;
  for (const r of runs) {
    if (!r.distance || !r.movingTime || r.distance < 5000) continue;
    const sec = riegel(r.movingTime, r.distance, HALF_M);
    if (!best || sec < best.sec) best = { sec, id: r.id };
  }
  return best;
}

/** Zaokrąglenie ciężaru do dostępnych talerzy (domyślnie 2,5 kg) */
export const roundPlate = (kg: number, step = 2.5) => Math.round(kg / step) * step;

export function fmtKg(kg?: number | null) {
  if (kg == null) return "–";
  return `${String(Math.round(kg * 100) / 100).replace(".", ",")} kg`;
}
