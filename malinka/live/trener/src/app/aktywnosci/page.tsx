import Link from "next/link";
import { prisma } from "@/lib/db";
import { fmtDate, fmtDuration, fmtKm, fmtPace } from "@/lib/time";
import { ICON, sportGroup, sportName } from "@/lib/sport";

export const dynamic = "force-dynamic";

export default async function Aktywnosci({ searchParams }: { searchParams: Promise<{ typ?: string }> }) {
  const { typ } = await searchParams;
  const all = await prisma.activity.findMany({ orderBy: { startLocal: "desc" }, take: 300 });
  const list = typ ? all.filter((a) => sportGroup(a.type) === typ) : all;
  const filtry: [string, string][] = [["", "Wszystko"], ["run", "🏃 Bieg"], ["ride", "🚴 Rower"], ["swim", "🏊 Basen"], ["strength", "🏋️ Siłownia"]];
  return (
    <>
      <h1>Treningi z zegarka</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        {filtry.map(([k, l]) => (
          <Link key={k} href={k ? `/aktywnosci?typ=${k}` : "/aktywnosci"} className={`tag ${(typ ?? "") === k ? "acc" : ""}`}>{l}</Link>
        ))}
      </div>
      {list.map((a) => {
        const g = sportGroup(a.type);
        return (
          <Link key={a.id} href={`/aktywnosci/${a.id}`} className="card link" style={{ display: "block" }}>
            <div className="row">
              <b className="grow">{ICON[g]} {a.name || sportName(a.type)}</b>
              <span className="mut small">{fmtDate(a.date)}</span>
            </div>
            <div className="mut small">
              {[sportName(a.type), a.distance ? fmtKm(a.distance) : null, a.movingTime ? fmtDuration(a.movingTime) : null, g === "run" && a.distance && a.movingTime ? fmtPace(a.movingTime / (a.distance / 1000)) : null, a.avgHr ? `♥ ${a.avgHr}` : null, a.load ? `obc. ${a.load}` : null]
                .filter(Boolean)
                .join(" · ")}
              {a.analysis ? " · 🤖" : ""}
            </div>
          </Link>
        );
      })}
      {!list.length && <div className="card mut">Nic tu jeszcze nie ma.</div>}
    </>
  );
}
