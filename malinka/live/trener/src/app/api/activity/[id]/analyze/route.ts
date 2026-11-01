import { analyzeActivity } from "@/lib/coach";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return Response.json({ analysis: await analyzeActivity((await params).id, { notifyDiscord: false }) });
  } catch (e) {
    return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
