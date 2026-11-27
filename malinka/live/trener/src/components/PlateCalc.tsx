"use client";
// Kalkulator talerzy: ile i jakich talerzy na stronę gryfu dla zadanego ciężaru
import { useState } from "react";
import { platesFor } from "@/lib/plates";
import NumInput from "./NumInput";
import Icon from "./Icon";

// kolory talerzy jak na zawodach (IWF), wysokość ~ średnica
const WYGLAD: Record<number, { c: string; h: number; w: number }> = {
  25: { c: "#e5484d", h: 104, w: 18 },
  20: { c: "#3b82f6", h: 104, w: 16 },
  15: { c: "#facc15", h: 92, w: 14 },
  10: { c: "#22c55e", h: 80, w: 12 },
  5: { c: "#f3f4f6", h: 62, w: 10 },
  2.5: { c: "#6b7280", h: 50, w: 9 },
  1.25: { c: "#cbd5e1", h: 40, w: 8 },
};
const GRYFY = [20, 15, 10];
const kg = (n: number) => String(Math.round(n * 100) / 100).replace(".", ",");

export default function PlateCalc({ initial, onApply, onClose }: { initial: number | null; onApply?: (w: number) => void; onClose: () => void }) {
  const [w, setW] = useState<number | null>(initial ?? 60);
  const [bar, setBar] = useState(() => {
    try {
      return Number(localStorage.getItem("trener.gryf")) || 20;
    } catch {
      return 20;
    }
  });
  const r = platesFor(w ?? 0, bar);
  const zbior = r.plates.reduce<Record<string, number>>((a, p) => ({ ...a, [p]: (a[p] ?? 0) + 1 }), {});
  return (
    <>
      <div className="sheet-bg" onClick={onClose} style={{ zIndex: 50 }} />
      <div className="sheet" style={{ zIndex: 51 }}>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <h3 className="grow" style={{ margin: 0 }}>Kalkulator talerzy</h3>
          <button className="ibtn" onClick={onClose} aria-label="Zamknij"><Icon name="close" size={18} /></button>
        </div>
        <div className="row" style={{ flexWrap: "nowrap", marginTop: 12 }}>
          <div className="grow">
            <label style={{ marginTop: 0 }}>Ciężar całkowity (kg)</label>
            <NumInput mode="decimal" value={w} onChange={setW} />
          </div>
          <div>
            <label style={{ marginTop: 0 }}>Gryf</label>
            <div className="row" style={{ flexWrap: "nowrap", gap: 4 }}>
              {GRYFY.map((g) => (
                <button
                  key={g}
                  className={g === bar ? "pri" : ""}
                  style={{ padding: "10px 11px" }}
                  onClick={() => {
                    setBar(g);
                    try { localStorage.setItem("trener.gryf", String(g)); } catch {}
                  }}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="bar-vis" aria-label="Jedna strona gryfu">
          <span className="gryf" />
          <span className="tul" />
          {r.plates.map((p, i) => (
            <span key={i} className="pl" style={{ background: WYGLAD[p]?.c ?? "#999", height: WYGLAD[p]?.h ?? 40, width: WYGLAD[p]?.w ?? 8 }}>
              {p >= 5 ? kg(p) : ""}
            </span>
          ))}
        </div>

        {(w ?? 0) <= bar ? (
          <p className="mut" style={{ textAlign: "center" }}>Sam gryf ({bar} kg) — bez talerzy.</p>
        ) : (
          <>
            <p style={{ textAlign: "center", margin: "0 0 4px" }}>
              Na każdą stronę: <b>{Object.entries(zbior).sort((a, b) => Number(b[0]) - Number(a[0])).map(([p, n]) => `${n > 1 ? `${n} × ` : ""}${kg(Number(p))}`).join(" + ")} kg</b>
            </p>
            <p className="small mut" style={{ textAlign: "center", margin: 0 }}>
              {kg(r.side)} kg na stronę · gryf {bar} kg
              {r.rest > 0 && <span className="err"> · brakuje {kg(r.rest * 2)} kg — najbliżej: {kg(r.real)} kg</span>}
            </p>
          </>
        )}
        {onApply && w != null && (
          <button className="pri block" style={{ marginTop: 14 }} onClick={() => { onApply(r.rest > 0 ? r.real : w); onClose(); }}>
            Wpisz {kg(r.rest > 0 ? r.real : w)} kg do serii
          </button>
        )}
      </div>
    </>
  );
}
