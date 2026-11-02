"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type V = Record<string, string | number | boolean>;

export default function SettingsForm({ initial }: { initial: V }) {
  const router = useRouter();
  const [v, setV] = useState<V>(initial);
  const [msg, setMsg] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV((x) => ({ ...x, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  const T = (k: string, label: string, ph = "") => (
    <>
      <label>{label}</label>
      <input value={String(v[k] ?? "")} onChange={set(k)} placeholder={ph} />
    </>
  );
  const A = (k: string, label: string, ph = "") => (
    <>
      <label>{label}</label>
      <textarea value={String(v[k] ?? "")} onChange={set(k)} placeholder={ph} />
    </>
  );
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg("Zapisuję…");
        const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
        setMsg(r.ok ? "✔ Zapisano" : "Błąd zapisu");
        router.refresh();
      }}
    >
      <div className="grid2">
        <div>{T("name", "Imię")}</div>
        <div>{T("birthYear", "Rok urodzenia")}</div>
        <div>{T("weightKg", "Waga (kg)")}</div>
        <div>{T("heightCm", "Wzrost (cm)")}</div>
        <div>{T("pullupGoalReps", "Cel: podciągnięcia w serii")}</div>
        <div>{T("pullupStartReps", "Podciągnięcia teraz (start)")}</div>
        <div>{T("halfGoal", "Półmaraton — czas odniesienia (h:mm:ss)")}</div>
      </div>
      {A("goals", "Cele (opisowo — trener to czyta)")}
      {T("trainingDays", "Dni treningowe", "pn,wt,śr,cz,pt,sb,nd")}
      <div className="grid2">
        <div>{T("gymPerWeek", "Siłownia × w tygodniu")}</div>
        <div>{T("swimPerWeek", "Basen × w tygodniu")}</div>
        <div>{T("runPerWeek", "Osobne biegi × w tygodniu")}</div>
        <div>{T("longRunDay", "Dzień długiego wybiegania", "nd")}</div>
      </div>
      {A("sports", "Dyscypliny")}
      {A("gymEquipment", "Sprzęt / siłownia")}
      {A("injuries", "Kontuzje i ograniczenia", "np. kolano po skręceniu w 2025, unikać skoków")}
      {A("notes", "Inne uwagi dla trenera", "np. pracuję zdalnie, trenuję wieczorami, basen tylko w weekend")}
      <label>Wysyłaj do kalendarza intervals.icu (→ zegarek)</label>
      <select value={String(v.pushToIntervals)} onChange={set("pushToIntervals")}>
        <option value="run">Tylko biegi</option>
        <option value="endurance">Biegi, rower i basen</option>
        <option value="none">Nic nie wysyłaj</option>
      </select>
      <div className="grid2">
        <div>{T("planHour", "Godzina planu w niedzielę")}</div>
      </div>
      <label className="check"><input type="checkbox" checked={!!v.autoPlan} onChange={set("autoPlan")} /> Układaj plan automatycznie w niedzielę</label>
      <label className="check"><input type="checkbox" checked={!!v.autoAnalyze} onChange={set("autoAnalyze")} /> Analizuj każdy trening (Discord)</label>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="pri" type="submit">Zapisz</button>
        <span className="small mut">{msg}</span>
      </div>
    </form>
  );
}
