import { createSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { plannedId?: number; templateId?: number; name?: string };
  const id = await createSession({
    plannedId: typeof b.plannedId === "number" ? b.plannedId : null,
    templateId: typeof b.templateId === "number" ? b.templateId : null,
    name: b.name,
  });
  return Response.json({ id });
}
