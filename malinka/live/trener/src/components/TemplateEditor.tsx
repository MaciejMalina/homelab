"use client";
// Edytor szablonu treningu: ćwiczenia, liczba serii, cel, superserie, kolejność
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TemplateDTO, TemplateItemDTO } from "@/lib/templates";
import ExercisePicker, { Thumb } from "./ExercisePicker";
import ExerciseInfo from "./ExerciseInfo";
import Icon from "./Icon";

export default function TemplateEditor({ initial }: { initial: TemplateDTO }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [notes, setNotes] = useState(initial.notes);
  const [items, setItems] = useState<TemplateItemDTO[]>(initial.items);
  const [picker, setPicker] = useState(false);
  const [info, setInfo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const upd = (i: number, p: Partial<TemplateItemDTO>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: -1 | 1) =>
    setItems((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const c = [...xs];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  const toggleLink = (i: number) =>
    setItems((xs) => {
      const linked = xs[i].superset != null && xs[i + 1]?.superset === xs[i].superset;
      if (linked) return xs.map((x, j) => (j === i + 1 ? { ...x, superset: null } : x));
      const s = xs[i].superset ?? Math.max(0, ...xs.map((x) => x.superset ?? 0)) + 1;
      return xs.map((x, j) => (j === i || j === i + 1 ? { ...x, superset: s } : x));
    });

  async function zapisz() {
    if (!items.length) return setErr("Dodaj przynajmniej jedno ćwiczenie.");
    setBusy(true);
    setErr("");
    const r = await fetch(initial.id ? `/api/templates/${initial.id}` : "/api/templates", {
      method: initial.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() || "Mój trening", notes, items }),
    });
    setBusy(false);
    if (!r.ok) return setErr("Nie udało się zapisać.");
    router.push("/silownia");
    router.refresh();
  }

  async function usun() {
    if (!confirm(`Usunąć szablon „${initial.name}”? Zapisane treningi zostają.`)) return;
    await fetch(`/api/templates/${initial.id}`, { method: "DELETE" });
    router.push("/silownia");
    router.refresh();
  }

  return (
    <>
      <div className="row" style={{ flexWrap: "nowrap", marginBottom: 6 }}>
        <Link href="/silownia" className="mut" aria-label="Wróć" style={{ display: "grid" }}><Icon name="back" /></Link>
        <h1 className="grow" style={{ margin: 0, fontSize: 22 }}>{initial.id ? "Edytuj szablon" : "Nowy szablon"}</h1>
        <button className="pri" onClick={zapisz} disabled={busy}>{busy ? "…" : "Zapisz"}</button>
      </div>
      {err && <div className="err small">{err}</div>}
      <label>Nazwa</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="np. Podciąganie + armwrestling" />

      <h2>Ćwiczenia</h2>
      {items.map((it, i) => {
        const linkedNext = it.superset != null && items[i + 1]?.superset === it.superset;
        const inSS = it.superset != null && (linkedNext || items[i - 1]?.superset === it.superset);
        return (
          <div key={`${it.exerciseId}-${i}`} className={`card ${inSS ? "ss" : ""}`} style={{ padding: 12, marginBottom: linkedNext ? 4 : 12 }}>
            <div className="exrow">
              <Thumb src={it.thumb} name={it.name} sm onClick={() => setInfo(it.exerciseId)} />
              <div className="grow"><b>{it.name}</b><div className="small mut">{it.category}{inSS ? " · superseria" : ""}</div></div>
              <button className="ibtn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="W górę"><Icon name="up" size={16} /></button>
              <button className="ibtn" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="W dół"><Icon name="down" size={16} /></button>
            </div>
            <div className="row" style={{ marginTop: 10, flexWrap: "nowrap" }}>
              <span className="small mut">Serie</span>
              <button className="ibtn" onClick={() => upd(i, { sets: Math.max(1, it.sets - 1) })} aria-label="Mniej serii">−</button>
              <b style={{ minWidth: 18, textAlign: "center" }}>{it.sets}</b>
              <button className="ibtn" onClick={() => upd(i, { sets: Math.min(10, it.sets + 1) })} aria-label="Więcej serii">+</button>
              <input value={it.target} onChange={(e) => upd(i, { target: e.target.value })} placeholder="cel, np. 8-10" style={{ padding: "8px 10px" }} />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              {i < items.length - 1 && (
                <button onClick={() => toggleLink(i)} style={{ padding: "7px 10px", fontSize: 13 }}>
                  <Icon name="link" size={14} /> {linkedNext ? "Rozłącz z następnym" : "Superseria z następnym"}
                </button>
              )}
              <button className="danger" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))} style={{ padding: "7px 10px", fontSize: 13, marginLeft: "auto" }}>
                <Icon name="trash" size={14} /> Usuń
              </button>
            </div>
          </div>
        );
      })}
      <button className="block big-start" onClick={() => setPicker(true)}><Icon name="plus" size={18} /> Dodaj ćwiczenia</button>

      <label>Notatka</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="np. najpierw 30 min bieżni" />

      {initial.id > 0 && <button className="danger block" style={{ marginTop: 16 }} onClick={usun}>Usuń szablon</button>}

      {picker && (
        <ExercisePicker
          onClose={() => setPicker(false)}
          onInfo={setInfo}
          onPick={(list) => {
            setPicker(false);
            setItems((xs) => [
              ...xs,
              ...list.map((e) => ({ exerciseId: e.id, name: e.name, category: e.category, kind: e.kind, thumb: e.thumb, sets: 3, target: "", superset: null })),
            ]);
          }}
        />
      )}
      {info !== null && <ExerciseInfo id={info} onClose={() => setInfo(null)} />}
    </>
  );
}
