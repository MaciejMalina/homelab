// Najlepsze wyniki i rekordy zależnie od typu serii (czyste funkcje — testy w bests.test.ts)
import { e1rm } from "./strength.ts";
import { fmtSec, type Kind, type SetLike } from "./kinds.ts";

export interface Best {
  /** weight_reps: najlepsze szacowane 1RM */
  e1rm?: { kg: number; set: string };
  /** bodyweight: najwięcej powtórzeń bez obciążenia */
  reps?: number;
  /** bodyweight/time: największe obciążenie dodatkowe */
  added?: { kg: number; label: string };
  /** time: najdłuższa seria */
  seconds?: number;
  /** distance: największy ciężar i najdłuższy dystans */
  maxKg?: number;
  meters?: number;
}

const kgTxt = (w: number) => String(Math.round(w * 100) / 100).replace(".", ",");

export function bestOf(kind: Kind, sets: SetLike[]): Best {
  const b: Best = {};
  for (const s of sets) {
    if (s.warmup) continue;
    const w = s.weight && s.weight > 0 ? s.weight : 0;
    if (kind === "weight_reps") {
      const v = e1rm(s.weight, s.reps);
      if (v && (!b.e1rm || v > b.e1rm.kg)) b.e1rm = { kg: v, set: `${kgTxt(s.weight!)} kg × ${s.reps}` };
    } else if (kind === "bodyweight") {
      if (!w && s.reps && s.reps > (b.reps ?? 0)) b.reps = s.reps;
      if (w && s.reps && w > (b.added?.kg ?? 0)) b.added = { kg: w, label: `+${kgTxt(w)} kg × ${s.reps}` };
    } else if (kind === "time") {
      if (s.seconds && s.seconds > (b.seconds ?? 0)) b.seconds = s.seconds;
      if (w && s.seconds && w > (b.added?.kg ?? 0)) b.added = { kg: w, label: `+${kgTxt(w)} kg · ${fmtSec(s.seconds)}` };
    } else if (kind === "distance") {
      if (s.meters && w > (b.maxKg ?? 0)) b.maxKg = w;
      if (s.meters && s.meters > (b.meters ?? 0)) b.meters = s.meters;
    }
  }
  return b;
}

/** Opis najlepszego wyniku, np. „szac. 1RM 93,3 kg (80 kg × 5)”, „12 powt.; +10 kg × 5”, „1:30”, „40 kg; 60 m” */
export function describeBest(b: Best): string {
  const p: string[] = [];
  if (b.e1rm) p.push(`szac. 1RM ${kgTxt(b.e1rm.kg)} kg (${b.e1rm.set})`);
  if (b.reps) p.push(`${b.reps} powt.`);
  if (b.seconds) p.push(fmtSec(b.seconds));
  if (b.added) p.push(b.added.label);
  if (b.maxKg) p.push(`${kgTxt(b.maxKg)} kg`);
  if (b.meters) p.push(`${Math.round(b.meters)} m`);
  return p.join("; ");
}

/** Lista pobitych rekordów: teraz vs wcześniej (tylko gdy wcześniej coś było) */
export function recordsBroken(name: string, now: Best, before: Best): string[] {
  const r: string[] = [];
  if (now.e1rm && before.e1rm && now.e1rm.kg > before.e1rm.kg) r.push(`${name}: szac. 1RM ${kgTxt(now.e1rm.kg)} kg (było ${kgTxt(before.e1rm.kg)} kg)`);
  if (now.reps && before.reps && now.reps > before.reps) r.push(`${name}: ${now.reps} powt. w serii (było ${before.reps})`);
  if (now.added && before.added && now.added.kg > before.added.kg) r.push(`${name}: ${now.added.label} (było +${kgTxt(before.added.kg)} kg)`);
  if (now.seconds && before.seconds && now.seconds > before.seconds) r.push(`${name}: ${fmtSec(now.seconds)} (było ${fmtSec(before.seconds)})`);
  if (now.maxKg && before.maxKg && now.maxKg > before.maxKg) r.push(`${name}: ${kgTxt(now.maxKg)} kg (było ${kgTxt(before.maxKg)} kg)`);
  if (now.meters && before.meters && now.meters > before.meters) r.push(`${name}: ${Math.round(now.meters)} m (było ${Math.round(before.meters)} m)`);
  return r;
}
