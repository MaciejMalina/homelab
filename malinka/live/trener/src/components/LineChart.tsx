"use client";
// Jeden przebieg w czasie: cienka linia 2 px, znaczniki 8 px, przyciemniona siatka, podpowiedź po dotknięciu/najechaniu
import { useState } from "react";

export interface Pt { label: string; value: number; sub?: string }

export default function LineChart({ points, unit = "", height = 200 }: { points: Pt[]; unit?: string; height?: number }) {
  const [sel, setSel] = useState<number | null>(null);
  if (points.length === 0) return <div className="mut small">Brak danych.</div>;
  const W = 340;
  const H = height;
  const L = 38, R = 12, T = 14, B = 26;
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  // "ładne" wartości na osi: krok 1/2/2,5/5 × 10^k
  const surowy = (hi - lo) / 3;
  const pot = Math.pow(10, Math.floor(Math.log10(surowy)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((x) => x >= surowy) ?? 10 * pot;
  lo = Math.max(0, Math.floor(lo / step) * step);
  hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  const x = (i: number) => (points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 1000) / 1000);
  const fmt = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)).replace(".", ",");
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const maxI = vals.indexOf(Math.max(...vals));
  const lastI = points.length - 1;
  const cur = sel ?? null;
  const pick = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setSel(best);
  };
  return (
    <div className="chart" style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Wykres: ${points.length} punktów, od ${fmt(vals[0])} do ${fmt(vals[lastI])} ${unit}`}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setSel(null)}
        style={{ touchAction: "pan-y" }}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--mut)">{fmt(t)}</text>
          </g>
        ))}
        <text x={L} y={H - 8} fontSize={10} fill="var(--mut)">{points[0].label}</text>
        {lastI > 0 && <text x={W - R} y={H - 8} fontSize={10} fill="var(--mut)" textAnchor="end">{points[lastI].label}</text>}
        <path d={d} fill="none" stroke="var(--acc)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {cur !== null && <line x1={x(cur)} x2={x(cur)} y1={T} y2={H - B} stroke="var(--mut)" strokeWidth={1} strokeDasharray="3 3" />}
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r={i === cur ? 5.5 : 4} fill={i === cur ? "var(--acc)" : "var(--bg)"} stroke="var(--acc)" strokeWidth={2} />
        ))}
        {/* podpisy tylko przy rekordzie i ostatnim punkcie */}
        {[...new Set([maxI, lastI])].map((i) => (
          <text key={`l${i}`} x={Math.min(W - R, Math.max(L, x(i)))} y={y(points[i].value) - 10} textAnchor={i === lastI ? "end" : "middle"} fontSize={11} fontWeight={700} fill="var(--txt)">
            {fmt(points[i].value)}
          </text>
        ))}
      </svg>
      {cur !== null && (
        <div
          className="small"
          style={{
            position: "absolute", top: 0, left: `${(x(cur) / W) * 100}%`, transform: `translateX(${x(cur) > W / 2 ? "-105%" : "5%"})`,
            background: "var(--card2)", border: "1px solid var(--line)", borderRadius: 10, padding: "6px 9px", pointerEvents: "none", whiteSpace: "nowrap",
          }}
        >
          <b>{fmt(points[cur].value)} {unit}</b>
          <div className="mut">{points[cur].label}</div>
          {points[cur].sub && <div className="mut">{points[cur].sub}</div>}
        </div>
      )}
    </div>
  );
}

/** Mini-wykres bez osi (lista ćwiczeń) */
export function Spark({ values, w = 72, h = 26 }: { values: number[]; w?: number; h?: number }) {
  const v = values.filter((n) => n > 0);
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v);
  const y = (n: number) => (hi === lo ? h / 2 : 3 + (1 - (n - lo) / (hi - lo)) * (h - 6));
  const d = v.map((n, i) => `${i ? "L" : "M"}${((i * (w - 6)) / (v.length - 1) + 3).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--acc)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w - 3} cy={y(v[v.length - 1])} r={2.5} fill="var(--acc)" />
    </svg>
  );
}
