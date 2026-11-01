"use client";
import { useState } from "react";
import ActionButton from "./ActionButton";

export default function PlanControls({ hasCurrent, hasNext }: { hasCurrent: boolean; hasNext: boolean }) {
  const [uwagi, setUwagi] = useState("");
  return (
    <div className="card">
      <label style={{ marginTop: 0 }}>Uwagi dla trenera (opcjonalnie)</label>
      <textarea value={uwagi} onChange={(e) => setUwagi(e.target.value)} placeholder="np. w czwartek nie mam czasu, boli mnie łydka, w sobotę parkrun" />
      <div className="row" style={{ marginTop: 10 }}>
        <ActionButton url="/api/plan" body={{ week: "current", uwagi }} label={hasCurrent ? "↻ Przebuduj ten tydzień od dziś" : "Ułóż ten tydzień od dziś"} busyLabel="Trener układa plan… (do minuty)" className="pri" confirm={hasCurrent ? "Nadpisać plan od dziś do niedzieli?" : undefined} />
        <ActionButton url="/api/plan" body={{ week: "next", uwagi }} label={hasNext ? "↻ Przebuduj przyszły tydzień" : "Ułóż przyszły tydzień"} busyLabel="Trener układa plan…" confirm={hasNext ? "Nadpisać plan na przyszły tydzień?" : undefined} />
      </div>
    </div>
  );
}
