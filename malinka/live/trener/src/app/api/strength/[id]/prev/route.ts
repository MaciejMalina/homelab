import { previousSets } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const exerciseId = Number(new URL(req.url).searchParams.get("exerciseId"));
  if (!exerciseId) return Response.json([]);
  return Response.json(await previousSets(exerciseId, Number((await params).id)));
}
