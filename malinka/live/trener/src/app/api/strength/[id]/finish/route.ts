import { prisma, getSettings } from "@/lib/db";
import { analyzeStrength, strengthRecords } from "@/lib/coach";
import { claudeConfigured } from "@/lib/claude";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Kończy sesję; analiza AI leci w tle (wynik na Discordzie i w appce po odświeżeniu) */
export async function POST(_: Request, { params }: Ctx) {
  const id = Number((await params).id);
  const s = await prisma.strengthSession.update({ where: { id }, data: { finishedAt: new Date() } }).catch(() => null);
  if (!s) return Response.json({ error: "Nie znaleziono" }, { status: 404 });
  const rekordy = await strengthRecords(id);
  const cfg = await getSettings();
  const analiza = cfg.autoAnalyze && claudeConfigured();
  if (analiza) analyzeStrength(id).catch((e) => console.error("[siłownia] analiza", e));
  return Response.json({ ok: true, rekordy, analiza });
}

/** Ponowna analiza na żądanie */
export async function PUT(_: Request, { params }: Ctx) {
  const id = Number((await params).id);
  try {
    return Response.json({ analysis: await analyzeStrength(id, { notifyDiscord: false }) });
  } catch (e) {
    return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
