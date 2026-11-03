import { prisma, getSettings, kvGet } from "@/lib/db";
import { addDays, fmtDate, todayPL, weekStart } from "@/lib/time";
import { PLAN_ICON } from "@/lib/sport";
import { parseStrength } from "@/lib/coach";
import PlanControls from "@/components/PlanControls";
import StartStrength from "@/components/StartStrength";
import ActionButton from "@/components/ActionButton";
import { doneIds } from "@/lib/move";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const today = todayPL();
  const ws = weekStart(today);
  const s = await getSettings();
  const plans = await prisma.plan.findMany({
    where: { weekStart: { in: [ws, addDays(ws, 7)] } },
    orderBy: { weekStart: "asc" },
    include: { workouts: { orderBy: [{ date: "asc" }, { id: "asc" }] } },
  });
  const err = JSON.parse((await kvGet("lastPlanError")) || "null") as { at: string; msg: string } | null;
  const zrobione = await doneIds(plans.flatMap((p) => p.workouts));
  const cur = plans.find((p) => p.weekStart === ws);
  const next = plans.find((p) => p.weekStart === addDays(ws, 7));

  return (
    <>
      <h1>Plan treningowy</h1>
      <p className="small mut" style={{ marginTop: -8 }}>
        {s.autoPlan ? `Nowy plan układa się sam w niedzielę o ${s.planHour}:00.` : "Automatyczne planowanie wyłączone (Ustawienia)."}{" "}
        {s.pushToIntervals !== "none" && "Biegi trafiają na zegarek przez intervals.icu."}
      </p>
      {err && err.msg && <div className="card err small">Ostatni błąd planowania ({new Date(err.at).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}): {err.msg}</div>}
      <PlanControls hasCurrent={!!cur} hasNext={!!next} />

      {plans.map((p) => {
        const dni: string[] = [];
        for (let d = p.weekStart; d <= addDays(p.weekStart, 6); d = addDays(d, 1)) dni.push(d);
        return (
          <section key={p.id}>
            <h2>{p.weekStart === ws ? "Ten tydzień" : "Przyszły tydzień"} — od {fmtDate(p.weekStart)}</h2>
            <div className="card mut">{p.summary}</div>
            {dni.map((d) => {
              const ws_ = p.workouts.filter((w) => w.date === d);
              const past = d < today;
              return (
                <div key={d} className="card" style={{ opacity: past ? 0.55 : 1, borderColor: d === today ? "var(--acc)" : undefined }}>
                  <div className="small mut" style={{ marginBottom: 4 }}>{fmtDate(d)}{d === today ? " · dziś" : ""}</div>
                  {!ws_.length && <div className="mut">—</div>}
                  {ws_.map((w) => {
                    const sil = parseStrength(w.strength);
                    return (
                      <div key={w.id} style={{ marginBottom: 8 }}>
                        <div className="row">
                          <b className="grow">{PLAN_ICON[w.sport] ?? "•"} {w.title}</b>
                          {w.durationMin ? <span className="tag">{w.durationMin} min</span> : null}
                          {w.intervalsEventId ? <span className="tag acc" title="Wysłany do intervals.icu">⌚</span> : null}
                        </div>
                        <div className="mut small">{w.description}</div>
                        {w.intervalsText && <pre className="steps">{w.intervalsText}</pre>}
                        {sil.length > 0 && (
                          <table className="list" style={{ marginTop: 6 }}>
                            <tbody>
                              {sil.map((x, i) => (
                                <tr key={i}>
                                  <td>{x.nazwa}{x.uwagi ? <div className="small mut">{x.uwagi}</div> : null}</td>
                                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                                    {x.serie}×{x.powtorzenia}{x.ciezar_kg ? ` @ ${String(x.ciezar_kg).replace(".", ",")} kg` : ""}{x.rpe ? ` · RPE ${x.rpe}` : ""}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {zrobione.has(w.id) && <div className="ok small" style={{ marginTop: 6 }}>✔ Zrobione</div>}
                        {w.sport === "Siłownia" && d === today && !zrobione.has(w.id) && <div style={{ marginTop: 8 }}><StartStrength plannedId={w.id} label="▶ Rozpocznij" /></div>}
                        {p.weekStart === ws && d !== today && w.sport !== "Odpoczynek" && !zrobione.has(w.id) && !(w.sport === "Bieg" && /^bieżnia/i.test(w.title) && ws_.some((x) => x.sport === "Siłownia")) && (
                          <div style={{ marginTop: 8 }}>
                            <ActionButton
                              url="/api/plan/move"
                              body={{ id: w.id }}
                              label={w.sport === "Siłownia" ? "↪ Przenieś na dziś (z bieżnią)" : "↪ Przenieś na dziś"}
                              busyLabel="Przenoszę…"
                              confirm={`Przenieść „${w.title}” na dziś?${w.intervalsEventId ? " Na zegarku też się przesunie." : ""}`}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </section>
        );
      })}
      {!plans.length && <div className="card mut">Brak planu. Ułóż go przyciskiem wyżej.</div>}
    </>
  );
}
