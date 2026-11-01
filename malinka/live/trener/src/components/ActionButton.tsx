"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Przycisk wywołujący POST do API i odświeżający widok; pokazuje stan i błąd */
export default function ActionButton({
  url,
  body,
  label,
  busyLabel = "Pracuję…",
  className = "",
  confirm: pytanie,
  method = "POST",
  redirect,
}: {
  url: string;
  body?: unknown;
  label: string;
  busyLabel?: string;
  className?: string;
  confirm?: string;
  method?: "POST" | "PUT" | "DELETE";
  redirect?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <span className="stack" style={{ display: "inline-block" }}>
      <button
        className={className}
        disabled={busy}
        onClick={async () => {
          if (pytanie && !window.confirm(pytanie)) return;
          setBusy(true);
          setErr("");
          try {
            const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || j.ok === false) throw new Error(j.error || (j.bledy && j.bledy.join("; ")) || `HTTP ${r.status}`);
            if (redirect) router.push(redirect);
            router.refresh();
          } catch (e) {
            setErr(String((e as Error).message ?? e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? busyLabel : label}
      </button>
      {err && <div className="err small">{err}</div>}
    </span>
  );
}
