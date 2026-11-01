"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function StartStrength({ plannedId, label, className = "pri block" }: { plannedId?: number; label: string; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await fetch("/api/strength", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plannedId }) });
        const j = await r.json();
        router.push(`/silownia/${j.id}`);
      }}
    >
      {busy ? "Zakładam trening…" : label}
    </button>
  );
}
