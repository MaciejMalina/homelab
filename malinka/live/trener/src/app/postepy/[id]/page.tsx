import Link from "next/link";
import { notFound } from "next/navigation";
import { exerciseHistory } from "@/lib/progress";
import { fmtDate } from "@/lib/time";
import { IMG_BASE, KIND_LABEL, fmtSec } from "@/lib/kinds";
import LineChart, { type Pt } from "@/components/LineChart";
import Icon from "@/components/Icon";

export const dynamic = "force-dynamic";

type Miara = { key: string; label: string; unit: string; get: (p: NonNullable<Awaited<ReturnType<typeof exerciseHistory>>>["points"][number]) => number | null };

export default async function Cwiczenie({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ m?: string }> }) {
  const h = await exerciseHistory(Number((await params).id));
  if (!h) notFound();
  const { exercise: e, points, best } = h;
  const miary: Miara[] =
    e.kind === "weight_reps"
      ? [
          { key: "1rm", label: "Szac. 1RM", unit: "kg", get: (p) => p.e1rm && Math.round(p.e1rm * 10) / 10 },
          { key: "max", label: "Max ciężar", unit: "kg", get: (p) => p.maxKg },
          { key: "vol", label: "Objętość", unit: "kg", get: (p) => p.volume || null },
        ]
      : e.kind === "bodyweight"
        ? [
            { key: "reps", label: "Max powt.", unit: "powt.", get: (p) => p.reps },
            { key: "max", label: "Obciążenie", unit: "kg", get: (p) => p.maxKg },
          ]
        : e.kind === "time"
          ? [{ key: "sec", label: "Najdłużej", unit: "s", get: (p) => p.seconds }]
          : [
              { key: "m", label: "Dystans", unit: "m", get: (p) => p.meters },
              { key: "max", label: "Ciężar", unit: "kg", get: (p) => p.maxKg },
            ];
  const mKey = (await searchParams).m;
  const mSel = miary.find((m) => m.key === mKey) ?? miary[0];
  const pts: Pt[] = points
    .map((p) => ({ v: mSel.get(p), p }))
    .filter((x): x is { v: number; p: (typeof points)[number] } => typeof x.v === "number" && x.v > 0)
    .map(({ v, p }) => ({ label: fmtDate(p.date), value: v, sub: p.sets.slice(0, 4).join(", ") + (p.sets.length > 4 ? "…" : "") }));
  let img: string | null = null;
  try { img = e.images ? JSON.parse(e.images)[0] ?? null : null; } catch {}

  return (
    <>
      <Link href="/postepy?tab=cwiczenia" className="mut small row" style={{ gap: 4 }}><Icon name="back" size={16} /> Ćwiczenia</Link>
      <div className="exrow" style={{ margin: "10px 0 14px" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <span className={`thumb ${img ? "" : "none"}`}>{img ? <img src={IMG_BASE + img} alt="" /> : e.name[0]}</span>
        <div className="grow">
          <h1 style={{ margin: 0, fontSize: 22 }}>{e.name}</h1>
          <div className="small mut">{e.category} · {KIND_LABEL[e.kind]}{e.muscles ? ` · ${e.muscles}` : ""}</div>
        </div>
      </div>

      {best && (
        <div className="card hero row" style={{ flexWrap: "nowrap" }}>
          <Icon name="trophy" size={26} style={{ color: "var(--acc)" }} />
          <div><div className="small mut">Najlepszy wynik</div><b>{best}</b></div>
        </div>
      )}

      {miary.length > 1 && (
        <div className="tabs">
          {miary.map((m) => (
            <Link key={m.key} href={`?m=${m.key}`} className={m.key === mSel.key ? "on" : ""}>{m.label}</Link>
          ))}
        </div>
      )}
      <div className="card">
        <div className="small mut" style={{ marginBottom: 6 }}>{mSel.label} ({mSel.unit}) — na trening</div>
        {pts.length ? <LineChart points={pts} unit={mSel.unit} /> : <div className="mut small">Brak danych dla tej miary.</div>}
      </div>

      <h2>Historia</h2>
      {[...points].reverse().map((p) => (
        <Link key={p.sessionId} href={`/silownia/${p.sessionId}`} className="card link" style={{ display: "block", padding: 12 }}>
          <div className="row"><b className="grow">{fmtDate(p.date)}</b>
            <span className="small mut">
              {p.e1rm ? `1RM ${String(Math.round(p.e1rm * 10) / 10).replace(".", ",")} kg` : p.seconds ? fmtSec(p.seconds) : p.reps ? `${p.reps} powt.` : ""}
            </span>
          </div>
          <div className="small mut">{p.sets.join(" · ")}</div>
        </Link>
      ))}
      {!points.length && <div className="card mut">To ćwiczenie nie ma jeszcze ukończonych serii.</div>}
    </>
  );
}
