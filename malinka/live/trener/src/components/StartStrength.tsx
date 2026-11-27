"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "./Icon";

export default function StartStrength({
  plannedId,
  templateId,
  label,
  className = "pri block",
  icon,
}: {
  plannedId?: number;
  templateId?: number;
  label: string;
  className?: string;
  icon?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await fetch("/api/strength", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plannedId, templateId }) });
        const j = await r.json();
        router.push(`/silownia/${j.id}`);
      }}
    >
      {icon && !busy && <Icon name={icon} size={18} />}
      {busy ? "Zakładam…" : label}
    </button>
  );
}
