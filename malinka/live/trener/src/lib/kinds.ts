// Typy serii i ich formatowanie — bez dostępu do bazy, więc używane też w przeglądarce (logger)

export type Kind = "weight_reps" | "bodyweight" | "time" | "distance";
export const KINDS: Kind[] = ["weight_reps", "bodyweight", "time", "distance"];
export const KIND_LABEL: Record<Kind, string> = {
  weight_reps: "kg × powt.",
  bodyweight: "masa ciała (+kg)",
  time: "na czas",
  distance: "dystans",
};
export const asKind = (k: string | null | undefined): Kind => (KINDS.includes(k as Kind) ? (k as Kind) : "weight_reps");

/** Repozytorium zdjęć biblioteki (ładowane przez przeglądarkę dopiero przy oglądaniu) */
export const IMG_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";

// ---------------------------------------------------------------- formatowanie serii
export interface SetLike {
  weight: number | null;
  reps: number | null;
  seconds?: number | null;
  meters?: number | null;
  rpe?: number | null;
  warmup?: boolean;
}
const kg = (w: number) => `${String(Math.round(w * 100) / 100).replace(".", ",")}`;
export const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s)} s`);

/** Seria jako tekst, np. „80 kg × 5”, „8 powt.”, „+10 kg × 6”, „1:30”, „+10 kg · 45 s”, „32 kg · 40 m” */
export function fmtSet(kind: Kind, s: SetLike): string {
  const w = s.weight && s.weight > 0 ? s.weight : null;
  switch (kind) {
    case "bodyweight":
      return w ? `+${kg(w)} kg × ${s.reps ?? 0}` : `${s.reps ?? 0} powt.`;
    case "time":
      return `${w ? `+${kg(w)} kg · ` : ""}${fmtSec(s.seconds ?? 0)}`;
    case "distance":
      return `${w ? `${kg(w)} kg · ` : ""}${Math.round(s.meters ?? 0)} m`;
    default:
      return `${kg(w ?? 0)} kg × ${s.reps ?? 0}`;
  }
}

/** Czy seria ma wpisany główny wynik (powt. / czas / dystans) */
export function hasResult(kind: Kind, s: SetLike) {
  if (kind === "time") return !!s.seconds;
  if (kind === "distance") return !!s.meters;
  return !!s.reps;
}

/** Cel z planu AI jako tekst: „4×6 @ 80 kg RPE 8”, „3×45 s”, „3×40 m @ 32 kg” */
export function fmtPlanTarget(p: {
  serie?: number | null;
  powtorzenia?: string | null;
  czas_s?: number | null;
  dystans_m?: number | null;
  ciezar_kg?: number | null;
  rpe?: number | null;
  uwagi?: string | null;
}) {
  const ile = p.czas_s ? fmtSec(p.czas_s) : p.dystans_m ? `${Math.round(p.dystans_m)} m` : p.powtorzenia ?? "";
  return `${p.serie ? `${p.serie}×` : ""}${ile}${p.ciezar_kg ? ` @ ${kg(p.ciezar_kg)} kg` : ""}${p.rpe ? ` RPE ${p.rpe}` : ""}${p.uwagi ? ` — ${p.uwagi}` : ""}`;
}
