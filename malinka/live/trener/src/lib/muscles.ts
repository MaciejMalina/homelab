// Grupy mięśni (nazwy jak w bibliotece ćwiczeń, po polsku) — bez bazy, używane też w przeglądarce (mapa mięśni)

export const MUSCLES = [
  "klatka", "barki", "biceps", "triceps", "przedramiona", "brzuch", "najszersze", "środek pleców", "dolny grzbiet",
  "kaptury", "szyja", "czworogłowe", "dwugłowe ud", "pośladki", "łydki", "przywodziciele", "odwodziciele",
] as const;
export type Muscle = (typeof MUSCLES)[number];

/** Ćwiczenia z katalogu bez powiązania z biblioteką: mięśnie z kategorii */
const Z_KATEGORII: Record<string, string> = {
  Podciąganie: "najszersze, biceps, (środek pleców), (przedramiona)",
  Plecy: "najszersze, środek pleców, (biceps)",
  Armwrestling: "przedramiona, (biceps)",
  Chwyt: "przedramiona",
  Biceps: "biceps, (przedramiona)",
  Triceps: "triceps",
  Barki: "barki, (triceps)",
  Klatka: "klatka, (triceps), (barki)",
  Nogi: "czworogłowe, pośladki, (dwugłowe ud)",
  Łydki: "łydki",
  Core: "brzuch",
};

/** "najszersze, (biceps)" -> [[najszersze, 1], [biceps, 0.5]] (główne liczą się za 1, pomocnicze za pół) */
export function parseMuscles(muscles: string, category = ""): [Muscle, number][] {
  const src = muscles.trim() || Z_KATEGORII[category] || "";
  const out: [Muscle, number][] = [];
  for (const raw of src.split(",")) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    const pom = t.startsWith("(");
    const m = t.replace(/[()]/g, "").trim() as Muscle;
    if ((MUSCLES as readonly string[]).includes(m)) out.push([m, pom ? 0.5 : 1]);
  }
  return out;
}
