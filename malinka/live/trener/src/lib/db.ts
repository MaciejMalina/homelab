import { PrismaClient } from "@prisma/client";
import { PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma =
  g.prisma ?? new PrismaClient({ adapter: new PrismaBetterSQLite3({ url: (process.env.DATABASE_URL ?? "file:./data/trener.sqlite").replace(/^file:/, "") }) });
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

// [nazwa, kategoria, wielostawowe, przerwa s]
const KATALOG: [string, string, boolean, number][] = [
  ["Wyciskanie sztangi leżąc", "Klatka", true, 180],
  ["Wyciskanie sztangi na skosie dodatnim", "Klatka", true, 150],
  ["Wyciskanie hantli leżąc", "Klatka", true, 120],
  ["Wyciskanie hantli na skosie dodatnim", "Klatka", true, 120],
  ["Wyciskanie wąskim chwytem", "Triceps", true, 150],
  ["Pompki na poręczach (dipy)", "Klatka", true, 120],
  ["Rozpiętki na wyciągu", "Klatka", false, 60],
  ["Pompki", "Klatka", true, 60],
  ["Przysiad ze sztangą", "Nogi", true, 180],
  ["Przysiad przedni", "Nogi", true, 180],
  ["Martwy ciąg", "Plecy", true, 180],
  ["Martwy ciąg rumuński", "Nogi", true, 150],
  ["Wykroki z hantlami", "Nogi", true, 90],
  ["Przysiad bułgarski", "Nogi", true, 90],
  ["Wypychanie na suwnicy", "Nogi", true, 120],
  ["Uginanie nóg na maszynie", "Nogi", false, 60],
  ["Prostowanie nóg na maszynie", "Nogi", false, 60],
  ["Wspięcia na palce", "Łydki", false, 60],
  ["Hip thrust", "Pośladki", true, 120],
  ["Podciąganie nachwytem", "Plecy", true, 120],
  ["Wiosłowanie sztangą", "Plecy", true, 120],
  ["Wiosłowanie hantlem", "Plecy", true, 90],
  ["Ściąganie drążka wyciągu górnego", "Plecy", true, 90],
  ["Wiosłowanie na wyciągu dolnym", "Plecy", true, 90],
  ["Face pull", "Barki", false, 60],
  ["Wyciskanie żołnierskie", "Barki", true, 150],
  ["Wyciskanie hantli nad głowę siedząc", "Barki", true, 120],
  ["Wznosy hantli bokiem", "Barki", false, 60],
  ["Uginanie ramion ze sztangą", "Biceps", false, 60],
  ["Uginanie ramion z hantlami", "Biceps", false, 60],
  ["Prostowanie ramion na wyciągu", "Triceps", false, 60],
  ["Francuskie wyciskanie", "Triceps", false, 60],
  ["Plank", "Core", false, 60],
  ["Allachy (spięcia na wyciągu)", "Core", false, 60],
  ["Unoszenie nóg w zwisie", "Core", false, 60],
  ["Pallof press", "Core", false, 60],
];

let seeded = false;

/** Ustawienia + katalog ćwiczeń przy pierwszym uruchomieniu */
export async function ensureSeed() {
  if (seeded) return;
  await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  if ((await prisma.exercise.count()) === 0) {
    await prisma.exercise.createMany({
      data: KATALOG.map(([name, category, compound, rest]) => ({ name, category, compound, rest })),
    });
  }
  seeded = true;
}

export async function getSettings() {
  await ensureSeed();
  return prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
}

export async function kvGet(key: string): Promise<string | null> {
  return (await prisma.kV.findUnique({ where: { key } }))?.value ?? null;
}
export async function kvSet(key: string, value: string) {
  await prisma.kV.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** Znajdź ćwiczenie po nazwie (bez względu na wielkość liter) albo załóż nowe */
export async function exerciseByName(name: string) {
  const n = name.trim();
  const all = await prisma.exercise.findMany();
  const hit = all.find((e) => e.name.toLowerCase() === n.toLowerCase());
  if (hit) return hit;
  return prisma.exercise.create({ data: { name: n, category: "Inne", compound: false, rest: 90 } });
}
