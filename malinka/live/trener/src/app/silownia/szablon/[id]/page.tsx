import { notFound } from "next/navigation";
import { getTemplate } from "@/lib/templates";
import TemplateEditor from "@/components/TemplateEditor";

export const dynamic = "force-dynamic";

export default async function Szablon({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (id === "nowy") return <TemplateEditor initial={{ id: 0, name: "", notes: "", lastUsed: null, items: [] }} />;
  const t = await getTemplate(Number(id));
  if (!t) notFound();
  return <TemplateEditor initial={t} />;
}
