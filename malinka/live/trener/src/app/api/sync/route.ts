import { syncAll } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const r = await syncAll();
  return Response.json(r, { status: r.bledy.length && !r.nowe && !r.zaktualizowane ? 502 : 200 });
}
