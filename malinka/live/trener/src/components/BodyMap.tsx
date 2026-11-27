// Mapa pracujących mięśni (przód i tył) — skala jednego koloru: im więcej serii, tym jaśniejsza limonka
import type { Muscle } from "@/lib/muscles";

type Shape = { m: Muscle | null; el: "e" | "r" | "c"; a: number[] };
// e: elipsa [cx, cy, rx, ry], r: prostokąt [x, y, w, h, rx], c: koło [cx, cy, r]; m = null -> sylwetka
const SYMETRIA = (m: Muscle | null, cx: number, cy: number, rx: number, ry: number): Shape[] => [
  { m, el: "e", a: [cx, cy, rx, ry] },
  { m, el: "e", a: [120 - cx, cy, rx, ry] },
];
const BAZA: Shape[] = [
  { m: null, el: "c", a: [60, 20, 13] },
  { m: null, el: "r", a: [53, 31, 14, 10, 3] },
  { m: null, el: "r", a: [40, 40, 40, 74, 14] },
  { m: null, el: "r", a: [42, 108, 36, 22, 9] },
  ...SYMETRIA(null, 22, 124, 5, 6),
  ...SYMETRIA(null, 50, 238, 8, 5),
];
const PRZOD: Shape[] = [
  ...BAZA,
  { m: "szyja", el: "r", a: [55, 32, 10, 8, 3] },
  ...SYMETRIA("barki", 36, 50, 10, 9),
  ...SYMETRIA("klatka", 50, 59, 11, 9),
  { m: "brzuch", el: "r", a: [49, 71, 22, 36, 7] },
  ...SYMETRIA("biceps", 29, 73, 6, 12),
  ...SYMETRIA("przedramiona", 24, 102, 5.5, 14),
  ...SYMETRIA("czworogłowe", 50, 152, 9, 26),
  ...SYMETRIA("przywodziciele", 56.5, 138, 2.6, 12),
  ...SYMETRIA("łydki", 50, 206, 6, 19),
];
const TYL: Shape[] = [
  ...BAZA,
  { m: "kaptury", el: "e", a: [60, 43, 17, 8] },
  ...SYMETRIA("barki", 36, 51, 10, 9),
  ...SYMETRIA("najszersze", 47, 76, 8.5, 17),
  { m: "środek pleców", el: "r", a: [53, 54, 14, 26, 4] },
  { m: "dolny grzbiet", el: "r", a: [53, 83, 14, 20, 4] },
  ...SYMETRIA("triceps", 29, 73, 6, 12),
  ...SYMETRIA("przedramiona", 24, 102, 5.5, 14),
  ...SYMETRIA("odwodziciele", 42, 116, 3.5, 8),
  ...SYMETRIA("pośladki", 51.5, 120, 9, 10),
  ...SYMETRIA("dwugłowe ud", 50, 156, 8.5, 22),
  ...SYMETRIA("łydki", 50, 206, 7, 19),
];

/** 0 serii -> szary, potem 4 stopnie limonki (1-3, 4-7, 8-12, 13+) */
export function fill(v: number) {
  if (!v) return "#2a3038";
  if (v < 4) return "rgba(198, 244, 50, 0.28)";
  if (v < 8) return "rgba(198, 244, 50, 0.5)";
  if (v < 13) return "rgba(198, 244, 50, 0.75)";
  return "#c6f432";
}

function Body({ shapes, load, title }: { shapes: Shape[]; load: Partial<Record<Muscle, number>>; title: string }) {
  return (
    <svg viewBox="0 0 120 250" role="img" aria-label={title}>
      {shapes.map((s, i) => {
        const v = s.m ? load[s.m] ?? 0 : 0;
        const f = s.m ? fill(v) : "#1d2228";
        const t = s.m ? <title>{`${s.m}: ${String(Math.round(v * 10) / 10).replace(".", ",")} serii`}</title> : null;
        const common = { fill: f, stroke: "var(--bg)", strokeWidth: 2 };
        if (s.el === "c") return <circle key={i} cx={s.a[0]} cy={s.a[1]} r={s.a[2]} {...common}>{t}</circle>;
        if (s.el === "r") return <rect key={i} x={s.a[0]} y={s.a[1]} width={s.a[2]} height={s.a[3]} rx={s.a[4]} {...common}>{t}</rect>;
        return <ellipse key={i} cx={s.a[0]} cy={s.a[1]} rx={s.a[2]} ry={s.a[3]} {...common}>{t}</ellipse>;
      })}
    </svg>
  );
}

export default function BodyMap({ load }: { load: Partial<Record<Muscle, number>> }) {
  return (
    <>
      <div className="bodies">
        <div><Body shapes={PRZOD} load={load} title="Mięśnie — przód" /><div className="cap">przód</div></div>
        <div><Body shapes={TYL} load={load} title="Mięśnie — tył" /><div className="cap">tył</div></div>
      </div>
      <div className="legend">
        <span><i style={{ background: fill(0) }} />0</span>
        <span><i style={{ background: fill(1) }} />1–3</span>
        <span><i style={{ background: fill(5) }} />4–7</span>
        <span><i style={{ background: fill(9) }} />8–12</span>
        <span><i style={{ background: fill(13) }} />13+ serii</span>
      </div>
    </>
  );
}
