import { Fragment } from "react";
import Link from "next/link";
import { monthMarks, muscleLoad, trainedExercises, weekStreak } from "@/lib/progress";
import { MUSCLES } from "@/lib/muscles";
import { prisma } from "@/lib/db";
import { addDays, fmtDate, todayPL, weekStart, weekdayIdx } from "@/lib/time";
import { IMG_BASE, KIND_LABEL } from "@/lib/kinds";
import BodyMap from "@/components/BodyMap";
import { Spark } from "@/components/LineChart";
import Icon from "@/components/Icon";

export const dynamic = "force-dynamic";

const MIESIACE = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
const KOLOR = { run: "#338ced", ride: "#e76624", swim: "#00a888", other: "#8b95a1" } as const;

function shiftMonth(ym: string, n: number) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export default async function Postepy({ searchParams }: { searchParams: Promise<{ tab?: string; m?: string; dni?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab === "cwiczenia" ? "cwiczenia" : "przeglad";
  const today = todayPL();
  return (
    <>
      <h1>Postępy</h1>
      <div className="tabs">
        <Link href="/postepy" className={tab === "przeglad" ? "on" : ""}>Przegląd</Link>
        <Link href="/postepy?tab=cwiczenia" className={tab === "cwiczenia" ? "on" : ""}>Ćwiczenia</Link>
        <Link href="/aktywnosci">Zegarek</Link>
      </div>
      {tab === "przeglad" ? <Przeglad today={today} ym={/^\d{4}-\d{2}$/.test(sp.m ?? "") ? sp.m! : today.slice(0, 7)} dni={sp.dni === "30" ? 30 : 7} /> : <Cwiczenia />}
    </>
  );
}

async function Przeglad({ today, ym, dni }: { today: string; ym: string; dni: number }) {
  const [marks, streak, mus] = await Promise.all([monthMarks(ym), weekStreak(), muscleLoad(dni)]);
  const ws = weekStart(today);
  const gymTydz = await prisma.strengthSession.count({ where: { date: { gte: ws }, finishedAt: { not: null } } });
  const wMiesiacu = Object.values(marks).filter((d) => d.gym || d.groups.length).length;

  // siatka miesiąca od poniedziałku
  const first = `${ym}-01`;
  const offset = (weekdayIdx(first) + 6) % 7;
  const days: (string | null)[] = Array.from({ length: offset }, () => null);
  for (let d = first; d.startsWith(ym); d = addDays(d, 1)) days.push(d);
  const [y, m] = ym.split("-").map(Number);
  const top = MUSCLES.map((k) => [k, mus.load[k] ?? 0] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <div className="grid2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        <div className="stat"><b><Icon name="fire" size={18} style={{ color: "var(--acc)", verticalAlign: -2 }} /> {streak}</b><span>tyg. z rzędu</span></div>
        <div className="stat"><b>{gymTydz}</b><span>siłownie w tyg.</span></div>
        <div className="stat"><b>{wMiesiacu}</b><span>dni z treningiem</span></div>
      </div>

      <div className="sec">
        <h2>{MIESIACE[m - 1]} {y}</h2>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <Link href={`/postepy?m=${shiftMonth(ym, -1)}&dni=${dni}`} className="btn ibtn" aria-label="Poprzedni miesiąc"><Icon name="back" size={18} /></Link>
          <Link href={`/postepy?m=${shiftMonth(ym, 1)}&dni=${dni}`} className="btn ibtn" aria-label="Następny miesiąc" style={{ transform: "scaleX(-1)" }}><Icon name="back" size={18} /></Link>
        </div>
      </div>
      <div className="card">
        <div className="cal">
          {["pn", "wt", "śr", "cz", "pt", "sb", "nd"].map((d) => <div key={d} className="dn">{d}</div>)}
          {days.map((d, i) => {
            if (!d) return <div key={`x${i}`} className="d out" />;
            const k = marks[d];
            const cls = `d ${k?.gym ? "gym" : k?.groups.length ? "act" : ""} ${d === today ? "today" : ""}`;
            const opis = [k?.gym ? `siłownia ×${k.gym}` : "", ...(k?.groups ?? [])].filter(Boolean).join(", ");
            return (
              <div key={d} className={cls} title={opis ? `${fmtDate(d)}: ${opis}` : fmtDate(d)}>
                {Number(d.slice(8))}
                <span className="dots">
                  {k?.groups.map((g) => <i key={g} style={{ background: KOLOR[g as keyof typeof KOLOR] ?? KOLOR.other }} />)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="legend">
          <span><i style={{ background: "var(--acc)", borderRadius: 3 }} />siłownia</span>
          <span><i style={{ background: KOLOR.run }} />bieg</span>
          <span><i style={{ background: KOLOR.ride }} />rower</span>
          <span><i style={{ background: KOLOR.swim }} />basen</span>
          <span><i style={{ background: KOLOR.other }} />inne</span>
        </div>
      </div>

      <div className="sec">
        <h2>Pracujące mięśnie</h2>
        <div className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
          <Link href={`/postepy?m=${ym}&dni=7`} className={`tag ${dni === 7 ? "acc" : ""}`}>7 dni</Link>
          <Link href={`/postepy?m=${ym}&dni=30`} className={`tag ${dni === 30 ? "acc" : ""}`}>30 dni</Link>
        </div>
      </div>
      <div className="card">
        {mus.sets ? (
          <>
            <BodyMap load={mus.load} />
            <div className="mlist">
              {top.map(([k, v]) => (
                <Fragment key={k}><span>{k}</span><span>{String(Math.round(v * 10) / 10).replace(".", ",")} serii</span></Fragment>
              ))}
            </div>
            <div className="small mut" style={{ marginTop: 8 }}>Serie robocze; mięśnie pomocnicze liczone za pół serii.</div>
          </>
        ) : (
          <div className="mut">Brak zapisanych serii w ostatnich {dni} dniach.</div>
        )}
      </div>
    </>
  );
}

async function Cwiczenia() {
  const list = await trainedExercises();
  const imgs = new Map(
    (await prisma.exercise.findMany({ where: { id: { in: list.map((l) => l.id) } }, select: { id: true, images: true } })).map((e) => {
      let t: string | null = null;
      try { t = e.images ? JSON.parse(e.images)[0] ?? null : null; } catch {}
      return [e.id, t];
    }),
  );
  if (!list.length) return <div className="card mut">Ukończ pierwszy trening, a tu pojawią się Twoje ćwiczenia z wykresami.</div>;
  return (
    <>
      {list.map((e) => {
        const t = imgs.get(e.id);
        return (
          <Link key={e.id} href={`/postepy/${e.id}`} className="card link exrow" style={{ padding: 12 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <span className={`thumb sm ${t ? "" : "none"}`}>{t ? <img src={IMG_BASE + t} alt="" loading="lazy" /> : e.name[0]}</span>
            <span className="grow">
              <b>{e.name}</b>
              <span className="small mut">{e.best || KIND_LABEL[e.kind]} · {e.sessions}× · {fmtDate(e.last)}</span>
            </span>
            <Spark values={e.spark} />
          </Link>
        );
      })}
    </>
  );
}
