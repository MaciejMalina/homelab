import { getSettings, kvGet, prisma } from "@/lib/db";
import { getAthlete, intervalsConfigured } from "@/lib/intervals";
import { claudeConfigured, MODEL, usageThisMonth } from "@/lib/claude";
import { fmtDuration } from "@/lib/time";
import SettingsForm from "@/components/SettingsForm";
import ActionButton from "@/components/ActionButton";

export const dynamic = "force-dynamic";

export default async function Ustawienia() {
  const s = await getSettings();
  let intervals = "nie skonfigurowane (.env)";
  let intervalsOk = false;
  if (intervalsConfigured()) {
    try {
      const a = await getAthlete();
      intervals = `połączono — ${String(a.name ?? a.id ?? "")}`;
      intervalsOk = true;
    } catch (e) {
      intervals = `błąd: ${String((e as Error).message).slice(0, 160)}`;
    }
  }
  const usage = await usageThisMonth();
  const sync = JSON.parse((await kvGet("lastSync")) ?? "null") as { at: string; nowe: number; bledy: string[] } | null;
  const counts = { akt: await prisma.activity.count(), well: await prisma.wellness.count(), sil: await prisma.strengthSession.count() };

  return (
    <>
      <h1>Ustawienia</h1>
      <h2>Połączenia</h2>
      <div className="card small stack">
        <div>⌚ intervals.icu: <span className={intervalsOk ? "ok" : "err"}>{intervals}</span></div>
        <div>🤖 Claude ({MODEL()}): <span className={claudeConfigured() ? "ok" : "err"}>{claudeConfigured() ? "klucz ustawiony" : "brak ANTHROPIC_API_KEY"}</span></div>
        <div>💬 Discord: <span className={process.env.DISCORD_WEBHOOK ? "ok" : "mut"}>{process.env.DISCORD_WEBHOOK ? "webhook ustawiony" : "brak (bez powiadomień)"}</span></div>
        <div className="mut">
          W bazie: {counts.akt} aktywności, {counts.well} dni regeneracji, {counts.sil} treningów siłowych. Ostatnia synchronizacja:{" "}
          {sync ? new Date(sync.at).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "—"}
          {sync?.bledy?.length ? <span className="err"> ({sync.bledy.join("; ").slice(0, 200)})</span> : null}
        </div>
        <div className="mut">AI w tym miesiącu: {usage.calls} wywołań, {Math.round(usage.in / 1000)}k / {Math.round(usage.out / 1000)}k tokenów, ≈ ${usage.usd.toFixed(2)}</div>
        <div><ActionButton url="/api/sync" label="↻ Synchronizuj teraz" busyLabel="Synchronizuję…" /></div>
      </div>
      <h2>Profil i plan</h2>
      <SettingsForm
        initial={{
          name: s.name,
          birthYear: s.birthYear ?? "",
          weightKg: s.weightKg ?? "",
          heightCm: s.heightCm ?? "",
          goals: s.goals,
          benchGoalKg: s.benchGoalKg,
          halfGoal: fmtDuration(s.halfGoalSec),
          trainingDays: s.trainingDays,
          sessionsPerWeek: s.sessionsPerWeek,
          longRunDay: s.longRunDay,
          sports: s.sports,
          gymEquipment: s.gymEquipment,
          injuries: s.injuries,
          notes: s.notes,
          planHour: s.planHour,
          autoPlan: s.autoPlan,
          autoAnalyze: s.autoAnalyze,
          pushToIntervals: s.pushToIntervals,
        }}
      />
    </>
  );
}
