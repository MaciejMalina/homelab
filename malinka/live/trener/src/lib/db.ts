import { PrismaClient } from "@prisma/client";
import { PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma =
  g.prisma ?? new PrismaClient({ adapter: new PrismaBetterSQLite3({ url: (process.env.DATABASE_URL ?? "file:./data/trener.sqlite").replace(/^file:/, "") }) });
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

// [nazwa, kategoria, wielostawowe, przerwa s]
const KATALOG: [string, string, boolean, number][] = [
  // --- podciąganie / plecy
  ["Podciąganie nachwytem", "Podciąganie", true, 150],
  ["Podciąganie podchwytem", "Podciąganie", true, 150],
  ["Podciąganie neutralnym chwytem", "Podciąganie", true, 150],
  ["Podciąganie z obciążeniem", "Podciąganie", true, 180],
  ["Podciąganie negatywne (5 s w dół)", "Podciąganie", true, 120],
  ["Podciąganie z gumą", "Podciąganie", true, 90],
  ["Australijskie podciąganie", "Podciąganie", true, 90],
  ["Zwis na drążku (czas)", "Chwyt", false, 90],
  ["Ściąganie drążka wyciągu górnego", "Plecy", true, 90],
  ["Wiosłowanie sztangą", "Plecy", true, 120],
  ["Wiosłowanie hantlem", "Plecy", true, 90],
  ["Wiosłowanie na wyciągu dolnym", "Plecy", true, 90],
  ["Face pull", "Barki", false, 60],
  // --- siłowanie na rękę (armwrestling)
  ["Uginanie nadgarstka z hantlem (flexion)", "Armwrestling", false, 60],
  ["Cupping — zwijanie nadgarstka na wyciągu", "Armwrestling", false, 75],
  ["Pronacja z młotkiem / hantlem z jednej strony", "Armwrestling", false, 60],
  ["Supinacja z młotkiem / hantlem z jednej strony", "Armwrestling", false, 60],
  ["Rising — odwodzenie promieniowe z młotkiem", "Armwrestling", false, 60],
  ["Side pressure na wyciągu", "Armwrestling", false, 90],
  ["Back pressure na wyciągu", "Armwrestling", false, 90],
  ["Uginanie ramion młotkowe", "Armwrestling", false, 60],
  ["Uginanie ramion ze sztangą", "Biceps", false, 60],
  ["Chwyt na grubym gryfie (fat grip)", "Chwyt", false, 75],
  ["Spacer farmera", "Chwyt", true, 90],
  ["Ściskanie gripera", "Chwyt", false, 60],
  // --- nogi pod bieganie
  ["Przysiad ze sztangą", "Nogi", true, 150],
  ["Przysiad przedni", "Nogi", true, 150],
  ["Martwy ciąg", "Nogi", true, 180],
  ["Martwy ciąg rumuński", "Nogi", true, 120],
  ["Martwy ciąg na jednej nodze", "Nogi", true, 90],
  ["Przysiad bułgarski", "Nogi", true, 90],
  ["Wykroki z hantlami", "Nogi", true, 90],
  ["Wejścia na skrzynię (step-up)", "Nogi", true, 90],
  ["Hip thrust", "Nogi", true, 120],
  ["Nordic curl", "Nogi", false, 90],
  ["Uginanie nóg na maszynie", "Nogi", false, 60],
  ["Wypychanie na suwnicy", "Nogi", true, 120],
  ["Wspięcia na palce stojąc (jednonóż)", "Łydki", false, 60],
  ["Wspięcia na palce siedząc", "Łydki", false, 60],
  ["Copenhagen plank", "Core", false, 60],
  // --- pchanie / reszta FBW
  ["Pompki", "Klatka", true, 60],
  ["Pompki na poręczach (dipy)", "Klatka", true, 120],
  ["Wyciskanie sztangi leżąc", "Klatka", true, 150],
  ["Wyciskanie hantli leżąc", "Klatka", true, 120],
  ["Wyciskanie żołnierskie", "Barki", true, 150],
  ["Wyciskanie hantli nad głowę siedząc", "Barki", true, 120],
  ["Wznosy hantli bokiem", "Barki", false, 60],
  ["Prostowanie ramion na wyciągu", "Triceps", false, 60],
  // --- core
  ["Plank", "Core", false, 60],
  ["Unoszenie nóg w zwisie", "Core", false, 60],
  ["Pallof press", "Core", false, 60],
  ["Dead bug", "Core", false, 45],
  ["Allachy (spięcia na wyciągu)", "Core", false, 60],
];

let seeded = false;

/** Ustawienia + katalog ćwiczeń przy pierwszym uruchomieniu */
export async function ensureSeed() {
  if (seeded) return;
  await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  // jednorazowo: stary domyślny opis celów (wyciskanie 100 kg) -> nowe cele (podciąganie, armwrestling, półmaraton)
  await prisma.settings.updateMany({
    where: { id: 1, goals: { startsWith: "1) 100 kg w wyciskaniu" } },
    data: {
      goals:
        "1) Półmaraton w jak najlepszym czasie. 2) Ogólna tężyzna fizyczna: podciąganie i siłowanie na rękę (armwrestling) na pierwszym miejscu, nogi pod bieganie, całe ciało (FBW). Każda siłownia: najpierw ok. 30 min biegu na bieżni, potem trening siłowy.",
    },
  });
  // dopisz brakujące ćwiczenia z katalogu (istniejących i dodanych ręcznie nie rusza)
  const jest = new Set((await prisma.exercise.findMany({ select: { name: true } })).map((e) => e.name.toLowerCase()));
  const brak = KATALOG.filter(([name]) => !jest.has(name.toLowerCase()));
  if (brak.length) {
    await prisma.exercise.createMany({ data: brak.map(([name, category, compound, rest]) => ({ name, category, compound, rest })) });
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
