// Katalog ćwiczeń: podstawowy (polski, pod cele Macieja) + biblioteka free-exercise-db (876 ćw., domena publiczna,
// nazwy przetłumaczone na polski). Typy serii i ich formatowanie.
import { prisma, kvGet, kvSet } from "./db";
import LIB from "../data/exercise-lib.json";
import { type Kind } from "./kinds";
export * from "./kinds";

interface LibEntry {
  id: string;
  en: string;
  pl: string;
  kind: Kind;
  cat: string;
  eq: string;
  musc: string[];
  musc2: string[];
  img: string[];
  ins: string[];
  lvl: string;
}
const LIBRARY = LIB as LibEntry[];

// [nazwa, kategoria, wielostawowe, przerwa s, typ serii, id w bibliotece]
type Core = [string, string, boolean, number, Kind, string | null];
const KATALOG: Core[] = [
  // --- podciąganie / plecy
  ["Podciąganie nachwytem", "Podciąganie", true, 150, "bodyweight", "Pullups"],
  ["Podciąganie podchwytem", "Podciąganie", true, 150, "bodyweight", "Chin-Up"],
  ["Podciąganie neutralnym chwytem", "Podciąganie", true, 150, "bodyweight", null],
  ["Podciąganie z obciążeniem", "Podciąganie", true, 180, "bodyweight", "Weighted_Pull_Ups"],
  ["Podciąganie negatywne (5 s w dół)", "Podciąganie", true, 120, "bodyweight", null],
  ["Podciąganie z gumą", "Podciąganie", true, 90, "bodyweight", "Band_Assisted_Pull-Up"],
  ["Australijskie podciąganie", "Podciąganie", true, 90, "bodyweight", "Inverted_Row"],
  ["Zwis na drążku (czas)", "Chwyt", false, 90, "time", null],
  ["Ściąganie drążka wyciągu górnego", "Plecy", true, 90, "weight_reps", "Wide-Grip_Lat_Pulldown"],
  ["Wiosłowanie sztangą", "Plecy", true, 120, "weight_reps", "Bent_Over_Barbell_Row"],
  ["Wiosłowanie hantlem", "Plecy", true, 90, "weight_reps", "One-Arm_Dumbbell_Row"],
  ["Wiosłowanie na wyciągu dolnym", "Plecy", true, 90, "weight_reps", "Seated_Cable_Rows"],
  ["Face pull", "Barki", false, 60, "weight_reps", "Face_Pull"],
  // --- siłowanie na rękę (armwrestling)
  ["Uginanie nadgarstka z hantlem (flexion)", "Armwrestling", false, 60, "weight_reps", "Palms-Up_Dumbbell_Wrist_Curl_Over_A_Bench"],
  ["Cupping — zwijanie nadgarstka na wyciągu", "Armwrestling", false, 75, "weight_reps", "Cable_Wrist_Curl"],
  ["Pronacja z młotkiem / hantlem z jednej strony", "Armwrestling", false, 60, "weight_reps", "Dumbbell_Lying_Pronation"],
  ["Supinacja z młotkiem / hantlem z jednej strony", "Armwrestling", false, 60, "weight_reps", "Dumbbell_Lying_Supination"],
  ["Rising — odwodzenie promieniowe z młotkiem", "Armwrestling", false, 60, "weight_reps", null],
  ["Side pressure na wyciągu", "Armwrestling", false, 90, "weight_reps", null],
  ["Back pressure na wyciągu", "Armwrestling", false, 90, "weight_reps", null],
  ["Uginanie ramion młotkowe", "Armwrestling", false, 60, "weight_reps", "Hammer_Curls"],
  ["Uginanie ramion ze sztangą", "Biceps", false, 60, "weight_reps", "Barbell_Curl"],
  ["Chwyt na grubym gryfie (fat grip)", "Chwyt", false, 75, "time", null],
  ["Spacer farmera", "Chwyt", true, 90, "distance", "Farmers_Walk"],
  ["Ściskanie gripera", "Chwyt", false, 60, "bodyweight", null],
  // --- nogi pod bieganie
  ["Przysiad ze sztangą", "Nogi", true, 150, "weight_reps", "Barbell_Squat"],
  ["Przysiad przedni", "Nogi", true, 150, "weight_reps", "Front_Barbell_Squat"],
  ["Martwy ciąg", "Nogi", true, 180, "weight_reps", "Barbell_Deadlift"],
  ["Martwy ciąg rumuński", "Nogi", true, 120, "weight_reps", "Romanian_Deadlift"],
  ["Martwy ciąg na jednej nodze", "Nogi", true, 90, "weight_reps", "Kettlebell_One-Legged_Deadlift"],
  ["Przysiad bułgarski", "Nogi", true, 90, "weight_reps", "Split_Squat_with_Dumbbells"],
  ["Wykroki z hantlami", "Nogi", true, 90, "weight_reps", "Dumbbell_Lunges"],
  ["Wejścia na skrzynię (step-up)", "Nogi", true, 90, "weight_reps", "Dumbbell_Step_Ups"],
  ["Hip thrust", "Nogi", true, 120, "weight_reps", "Barbell_Hip_Thrust"],
  ["Nordic curl", "Nogi", false, 90, "bodyweight", "Natural_Glute_Ham_Raise"],
  ["Uginanie nóg na maszynie", "Nogi", false, 60, "weight_reps", "Lying_Leg_Curls"],
  ["Wypychanie na suwnicy", "Nogi", true, 120, "weight_reps", "Leg_Press"],
  ["Wspięcia na palce stojąc (jednonóż)", "Łydki", false, 60, "weight_reps", "Standing_Dumbbell_Calf_Raise"],
  ["Wspięcia na palce siedząc", "Łydki", false, 60, "weight_reps", "Seated_Calf_Raise"],
  ["Copenhagen plank", "Core", false, 60, "time", null],
  // --- pchanie / reszta FBW
  ["Pompki", "Klatka", true, 60, "bodyweight", "Pushups"],
  ["Pompki na poręczach (dipy)", "Klatka", true, 120, "bodyweight", "Parallel_Bar_Dip"],
  ["Wyciskanie sztangi leżąc", "Klatka", true, 150, "weight_reps", "Barbell_Bench_Press_-_Medium_Grip"],
  ["Wyciskanie hantli leżąc", "Klatka", true, 120, "weight_reps", "Dumbbell_Bench_Press"],
  ["Wyciskanie żołnierskie", "Barki", true, 150, "weight_reps", "Standing_Military_Press"],
  ["Wyciskanie hantli nad głowę siedząc", "Barki", true, 120, "weight_reps", "Seated_Dumbbell_Press"],
  ["Wznosy hantli bokiem", "Barki", false, 60, "weight_reps", "Side_Lateral_Raise"],
  ["Prostowanie ramion na wyciągu", "Triceps", false, 60, "weight_reps", "Triceps_Pushdown"],
  // --- core
  ["Plank", "Core", false, 60, "time", "Plank"],
  ["Unoszenie nóg w zwisie", "Core", false, 60, "bodyweight", "Hanging_Leg_Raise"],
  ["Pallof press", "Core", false, 60, "weight_reps", "Pallof_Press"],
  ["Dead bug", "Core", false, 45, "bodyweight", "Dead_Bug"],
  ["Allachy (spięcia na wyciągu)", "Core", false, 60, "weight_reps", "Cable_Crunch"],
];

export const CORE_NAMES = KATALOG.map(([n, , , , k]) => ({ name: n, kind: k }));

// podnieś przy zmianie katalogu/biblioteki — wtedy przy starcie appka zsynchronizuje bazę
const CATALOG_VERSION = "2";

const libMeta = (e: LibEntry) => ({
  nameEn: e.en,
  libId: e.id,
  equipment: e.eq,
  muscles: [...e.musc, ...e.musc2.map((m) => `(${m})`)].join(", "),
  level: e.lvl,
  images: e.img.length ? JSON.stringify(e.img) : null,
  instructions: e.ins.length ? JSON.stringify(e.ins) : null,
});

/** Synchronizuje katalog podstawowy i bibliotekę z bazą. Nie rusza ćwiczeń dodanych ręcznie ani historii. */
export async function syncCatalog() {
  if ((await kvGet("catalogVersion")) === CATALOG_VERSION) return;
  const libById = new Map(LIBRARY.map((e) => [e.id, e]));
  const existing = await prisma.exercise.findMany({ select: { id: true, name: true, libId: true } });
  const byName = new Map(existing.map((e) => [e.name.toLowerCase(), e]));
  const usedLib = new Set(existing.map((e) => e.libId).filter(Boolean) as string[]);
  const usedNames = new Set(existing.map((e) => e.name.toLowerCase()));

  // 1) katalog podstawowy: utwórz brakujące, istniejącym nadaj typ, flagę core i powiązanie z biblioteką
  for (const [name, category, compound, rest, kind, libId] of KATALOG) {
    const lib = libId ? libById.get(libId) : undefined;
    const meta = lib && !usedLib.has(lib.id) ? libMeta(lib) : {};
    if (lib && !usedLib.has(lib.id)) usedLib.add(lib.id);
    const row = byName.get(name.toLowerCase());
    if (row) {
      await prisma.exercise.update({ where: { id: row.id }, data: { kind, core: true, ...(row.libId ? {} : meta) } });
    } else {
      await prisma.exercise.create({ data: { name, category, compound, rest, kind, core: true, ...meta } });
      usedNames.add(name.toLowerCase());
    }
  }

  // 2) biblioteka: dopisz to, czego jeszcze nie ma (po id), z unikalną nazwą
  const nowe = [];
  for (const e of LIBRARY) {
    if (usedLib.has(e.id)) continue;
    let name = e.pl;
    if (usedNames.has(name.toLowerCase())) name = `${e.pl} (${e.en})`;
    if (usedNames.has(name.toLowerCase())) continue;
    usedNames.add(name.toLowerCase());
    nowe.push({
      name,
      category: e.cat,
      compound: false,
      rest: e.kind === "time" ? 60 : 90,
      kind: e.kind,
      core: false,
      ...libMeta(e),
    });
  }
  for (let i = 0; i < nowe.length; i += 200) await prisma.exercise.createMany({ data: nowe.slice(i, i + 200) });
  await kvSet("catalogVersion", CATALOG_VERSION);
  console.log(`[katalog] zsynchronizowano: ${nowe.length} ćwiczeń z biblioteki`);
}

/** Typ dla ćwiczenia spoza katalogu — zgadywany z polskiej/angielskiej nazwy */
export function guessKind(name: string): Kind {
  const n = name.toLowerCase();
  if (/deska|plank|zwis|wis\b|trzymani|izometr|hold|hang\b|wall sit|krzesełko/.test(n)) return "time";
  if (/spacer|noszeni|sań|sanie|farmer|yoke|walk|carry|sled/.test(n)) return "distance";
  if (/podciąg|pompk|dip|poręcz|australijsk|muscle|pull-?up|chin|push-?up/.test(n)) return "bodyweight";
  return "weight_reps";
}

