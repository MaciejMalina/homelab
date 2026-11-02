"use client";
import { useEffect, useRef, useState } from "react";
import Md from "@/components/Md";

interface M { id?: number; role: "user" | "assistant"; content: string }

const PODPOWIEDZI = ["Jak mi idzie w tym tygodniu?", "Na jaki czas w półmaratonie jestem dziś gotowy?", "Jak szybciej zwiększyć liczbę podciągnięć?", "Co dołożyć pod siłowanie na rękę?", "Źle spałem — co dziś zrobić?"];

export default function Trener() {
  const [msgs, setMsgs] = useState<M[]>([]);
  const [txt, setTxt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/chat").then((r) => r.json()).then((x) => Array.isArray(x) && setMsgs(x)).catch(() => {});
  }, []);
  // w klamrach: nowy Chrome zwraca z scrollIntoView() Promise, a React wziąłby go za funkcję sprzątającą efektu
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(t = txt) {
    const m = t.trim();
    if (!m || busy) return;
    setTxt("");
    setErr("");
    setMsgs((x) => [...x, { role: "user", content: m }]);
    setBusy(true);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: m }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMsgs((x) => [...x, { role: "assistant", content: j.reply }]);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setMsgs((x) => x.slice(0, -1));
      setTxt(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ paddingBottom: 90 }}>
      <div className="top">
        <h1>Trener</h1>
        {msgs.length > 0 && (
          <button className="small" onClick={async () => { if (confirm("Wyczyścić historię rozmowy?")) { await fetch("/api/chat", { method: "DELETE" }); setMsgs([]); } }}>Wyczyść</button>
        )}
      </div>
      {!msgs.length && (
        <div className="stack">
          <p className="mut">Trener zna Twoje treningi z zegarka, siłownię, sen i plan. Zapytaj o cokolwiek.</p>
          {PODPOWIEDZI.map((p) => <button key={p} className="block" style={{ justifyContent: "flex-start" }} onClick={() => send(p)}>{p}</button>)}
        </div>
      )}
      {msgs.map((m, i) => (
        <div key={m.id ?? `n${i}`} className={`bubble ${m.role}`}>
          {m.role === "assistant" ? <Md text={m.content} /> : m.content}
        </div>
      ))}
      {busy && <div className="bubble assistant mut">Trener myśli…</div>}
      {err && <div className="err small">{err}</div>}
      <div ref={end} />
      <div className="composer">
        <div className="row">
          <textarea value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="Napisz do trenera…" rows={1}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); send(); } }} />
          <button className="pri" onClick={() => send()} disabled={busy || !txt.trim()}>➤</button>
        </div>
      </div>
    </div>
  );
}
