import { PrismaClient } from "@prisma/client";
import { PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma =
  g.prisma ?? new PrismaClient({ adapter: new PrismaBetterSQLite3({ url: (process.env.DATABASE_URL ?? "file:./data/trener.sqlite").replace(/^file:/, "") }) });
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

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
  // katalog ćwiczeń + biblioteka (tylko gdy zmieniła się wersja katalogu)
  const { syncCatalog } = await import("./exercises");
  await syncCatalog();
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

/** Znajdź ćwiczenie po nazwie polskiej lub angielskiej (bez względu na wielkość liter) albo załóż nowe */
export async function exerciseByName(name: string) {
  await ensureSeed();
  const n = name.trim();
  const low = n.toLowerCase();
  const all = await prisma.exercise.findMany({ select: { id: true, name: true, nameEn: true } });
  const hit = all.find((e) => e.name.toLowerCase() === low) ?? all.find((e) => e.nameEn?.toLowerCase() === low);
  if (hit) return prisma.exercise.findUniqueOrThrow({ where: { id: hit.id } });
  const { guessKind } = await import("./exercises");
  const kind = guessKind(n);
  return prisma.exercise.create({ data: { name: n, category: "Inne", compound: false, rest: kind === "time" ? 60 : 90, kind } });
}
