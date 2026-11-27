import { listTemplates, saveTemplate, templateFromSession } from "@/lib/templates";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await listTemplates());
}

/** {name, items} — nowy szablon; {fromSessionId, name?} — szablon z treningu */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Parameters<typeof saveTemplate>[1] & { fromSessionId?: number; name?: string };
  if (typeof b.fromSessionId === "number") {
    const id = await templateFromSession(b.fromSessionId, b.name);
    return id ? Response.json({ id }) : Response.json({ error: "Nie znaleziono treningu" }, { status: 404 });
  }
  return Response.json({ id: await saveTemplate(null, b) });
}
