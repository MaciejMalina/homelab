import { notFound } from "next/navigation";
import { loadSession } from "@/lib/session";
import Logger from "@/components/Logger";

export const dynamic = "force-dynamic";

export default async function Sesja({ params }: { params: Promise<{ id: string }> }) {
  const s = await loadSession(Number((await params).id));
  if (!s) notFound();
  return <Logger initial={s} />;
}
