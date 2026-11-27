"use client";
// Wybór ćwiczenia z katalogu i biblioteki (logger i edytor szablonów)
import { useEffect, useMemo, useState } from "react";
import { IMG_BASE, KIND_LABEL, KINDS, type Kind } from "@/lib/kinds";

export interface Ex { id: number; name: string; nameEn: string | null; category: string; kind: Kind; rest: number; core: boolean; muscles: string; info: boolean; thumb: string | null; used: number }

export function Thumb({ src, name, sm, onClick }: { src: string | null; name: string; sm?: boolean; onClick?: () => void }) {
  const cls = `thumb ${sm ? "sm" : ""} ${src ? "" : "none"}`;
  // eslint-disable-next-line @next/next/no-img-element
  const inner = src ? <img src={IMG_BASE + src} alt="" loading="lazy" /> : name.trim()[0]?.toUpperCase();
  return onClick ? <button className={cls} onClick={onClick} aria-label={`Jak wykonać: ${name}`}>{inner}</button> : <span className={cls}>{inner}</span>;
}

export default function ExercisePicker({ onPick, onInfo, onClose }: { onPick: (e: Ex[]) => void; onInfo: (id: number) => void; onClose: () => void }) {
  const [all, setAll] = useState<Ex[]>([]);
  const [wybrane, setWybrane] = useState<Ex[]>([]);
  const toggle = (e: Ex) => setWybrane((w) => (w.some((x) => x.id === e.id) ? w.filter((x) => x.id !== e.id) : [...w, e]));
  const [q, setQ] = useState("");
  const [kat, setKat] = useState("");
  const [nowyTyp, setNowyTyp] = useState<Kind | "">("");
  useEffect(() => {
    fetch("/api/exercises").then((r) => r.json()).then((x) => Array.isArray(x) && setAll(x)).catch(() => {});
  }, []);
  const kategorie = useMemo(() => [...new Set(all.map((e) => e.category))].sort((a, b) => a.localeCompare(b, "pl")), [all]);
  const { lista, ile } = useMemo(() => {
    const t = q.trim().toLowerCase();
    let x = all;
    if (kat) x = x.filter((e) => e.category === kat);
    if (t) {
      const slowa = t.split(/\s+/);
      x = x.filter((e) => {
        const h = `${e.name} ${e.nameEn ?? ""} ${e.category} ${e.muscles}`.toLowerCase();
        return slowa.every((w) => h.includes(w));
      });
    } else if (!kat) {
      x = x.filter((e) => e.core || e.used > 0); // bez wyszukiwania: Twoje i podstawowe
    }
    // najpierw używane, potem podstawowe, potem reszta
    x = [...x].sort((a, b) => b.used - a.used || Number(b.core) - Number(a.core) || a.name.localeCompare(b.name, "pl"));
    return { lista: x.slice(0, 80), ile: x.length };
  }, [all, q, kat]);
  const exact = all.some((e) => e.name.toLowerCase() === q.trim().toLowerCase());
  return (
    <>
      <div className="sheet-bg" onClick={onClose} />
      <div className="sheet">
        <div className="row" style={{ marginBottom: 8, flexWrap: "nowrap" }}>
          <input autoFocus placeholder={`Szukaj w ${all.length || "…"} ćwiczeniach (PL / EN)…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <button onClick={onClose}>✕</button>
        </div>
        <div className="row" style={{ marginBottom: 8, flexWrap: "nowrap", overflowX: "auto", paddingBottom: 4 }}>
          <button className={`tag ${kat === "" ? "acc" : ""}`} style={{ border: "none", whiteSpace: "nowrap" }} onClick={() => setKat("")}>
            {q ? "Wszystkie" : "Moje i podstawowe"}
          </button>
          {kategorie.map((k) => (
            <button key={k} className={`tag ${kat === k ? "acc" : ""}`} style={{ border: "none", whiteSpace: "nowrap" }} onClick={() => setKat(kat === k ? "" : k)}>
              {k}
            </button>
          ))}
        </div>
        {q.trim() && !exact && (
          <div className="row" style={{ marginBottom: 8, flexWrap: "nowrap" }}>
            <select value={nowyTyp} onChange={(e) => setNowyTyp(e.target.value as Kind | "")} style={{ width: "auto" }} aria-label="Typ nowego ćwiczenia">
              <option value="">typ: auto</option>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <button
              className="pri grow"
              onClick={async () => {
                const e = await fetch("/api/exercises", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: q.trim(), kind: nowyTyp || undefined }),
                }).then((r) => r.json());
                if (e?.id) onPick([...wybrane, e]);
              }}
            >
              ＋ Nowe: „{q.trim()}”
            </button>
          </div>
        )}
        {lista.map((e) => {
          const nr = wybrane.findIndex((x) => x.id === e.id);
          return (
            <div key={e.id} className="row" style={{ flexWrap: "nowrap", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
              <Thumb src={e.thumb} name={e.name} sm onClick={e.info ? () => onInfo(e.id) : undefined} />
              <button className="grow" onClick={() => toggle(e)} style={{ background: "none", border: "none", padding: "4px 0", justifyContent: "flex-start", textAlign: "left", display: "block" }}>
                <div style={{ fontWeight: 600 }}>{e.name}</div>
                <div className="mut small">
                  {e.category}
                  {e.kind !== "weight_reps" ? ` · ${KIND_LABEL[e.kind]}` : ""}
                  {e.used ? ` · ${e.used}×` : ""}
                </div>
              </button>
              <button className={`tick ${nr >= 0 ? "on" : ""}`} onClick={() => toggle(e)} aria-label={nr >= 0 ? "Odznacz" : "Zaznacz"} style={{ width: 36, height: 36 }}>
                {nr >= 0 ? nr + 1 : "+"}
              </button>
            </div>
          );
        })}
        {ile > lista.length && <div className="small mut">…i {ile - lista.length} więcej — zawęź wyszukiwanie.</div>}
        {!lista.length && all.length > 0 && <div className="small mut">Nic nie znaleziono — dodaj jako nowe ćwiczenie.</div>}
        {wybrane.length > 0 && (
          <div style={{ position: "sticky", bottom: 0, paddingTop: 10, background: "var(--card)" }}>
            <button className="pri block big-start" onClick={() => onPick(wybrane)}>
              Dodaj {wybrane.length} {wybrane.length === 1 ? "ćwiczenie" : wybrane.length < 5 ? "ćwiczenia" : "ćwiczeń"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
