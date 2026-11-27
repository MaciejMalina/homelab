"use client";
// Zapis treningu siłowego w trakcie — w stylu Lyfty/Hevy:
// miniatura ćwiczenia, kolumna "Poprzednio" (dotknij, by przepisać), ✓ zalicza serię i startuje przerwę,
// superserie (przerwa dopiero po ostatnim ćwiczeniu z grupy), kalkulator talerzy, duży timer przerwy,
// autozapis co chwilę, ekran nie gaśnie w trakcie treningu.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ItemDTO, SessionDTO, SetDTO } from "@/lib/session";
import { fmtSet, hasResult, KIND_LABEL, KINDS, type Kind } from "@/lib/kinds";
import { bestOf, describeBest } from "@/lib/bests";
import Md from "./Md";
import NumInput from "./NumInput";
import ExerciseInfo from "./ExerciseInfo";
import ExercisePicker, { Thumb, type Ex } from "./ExercisePicker";
import PlateCalc from "./PlateCalc";
import Icon from "./Icon";

/** Kolumny zależnie od typu serii: [etykieta ciężaru, etykieta wyniku, tryb pola wyniku, pole wyniku] */
const KOLUMNY: Record<Kind, { kg: string; res: string; mode: "int" | "time" | "decimal"; field: "reps" | "seconds" | "meters" }> = {
  weight_reps: { kg: "kg", res: "Powt.", mode: "int", field: "reps" },
  bodyweight: { kg: "+kg", res: "Powt.", mode: "int", field: "reps" },
  time: { kg: "+kg", res: "Czas", mode: "time", field: "seconds" },
  distance: { kg: "kg", res: "Metry", mode: "decimal", field: "meters" },
};
const pustaSeria = (): SetDTO => ({ weight: null, reps: null, seconds: null, meters: null, rpe: null, warmup: false, done: false });
const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
};
const serie = (n: number) => (n === 1 ? "seria" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "serie" : "serii");
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

/** Most do aplikacji Android (WebView): ekran nie gaśnie, bo Wake Lock API w WebView nie działa */
type Bridge = { keepScreenOn?: (on: boolean) => void };
const bridge = () => (typeof window !== "undefined" ? (window as unknown as { TrenerApp?: Bridge }).TrenerApp : undefined);

/** Superserie tylko dla sąsiadujących ćwiczeń; grupy z jednym ćwiczeniem znikają, numery 1..n w kolejności */
function normalizeSS(items: ItemDTO[]): ItemDTO[] {
  const src = items.map((x) => x.superset);
  const keep = src.map((s, i) => s != null && (src[i - 1] === s || src[i + 1] === s));
  let n = 0;
  const nowe: (number | null)[] = [];
  for (let i = 0; i < src.length; i++) {
    if (!keep[i]) nowe.push(null);
    else if (i > 0 && keep[i - 1] && src[i - 1] === src[i]) nowe.push(nowe[i - 1]);
    else nowe.push(++n);
  }
  return items.map((x, i) => (x.superset === nowe[i] ? x : { ...x, superset: nowe[i] }));
}

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.25, 0.5].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.2);
    });
  } catch {}
}

export default function Logger({ initial }: { initial: SessionDTO }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [notes, setNotes] = useState(initial.notes);
  const [items, setItemsRaw] = useState<ItemDTO[]>(() => normalizeSS(initial.items));
  const setItems = (f: (xs: ItemDTO[]) => ItemDTO[]) => setItemsRaw((xs) => normalizeSS(f(xs)));
  const [save, setSave] = useState<"ok" | "busy" | "err">("ok");
  const [now, setNow] = useState(Date.now());
  const [rest, setRest] = useState<{ end: number; total: number } | null>(null);
  const [restFull, setRestFull] = useState(false);
  const [picker, setPicker] = useState(false);
  const [info, setInfo] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [plates, setPlates] = useState<{ i: number; w: number | null } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [records, setRecords] = useState<string[] | null>(null);
  const [tpl, setTpl] = useState<"" | "busy" | "ok">("");
  const finished = !!initial.finishedAt;
  const dirty = useRef(false);
  const first = useRef(true);

  // zegar
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // ekran nie gaśnie w trakcie treningu (przeglądarka: Wake Lock, appka Android: most TrenerApp)
  useEffect(() => {
    if (finished) return;
    const b = bridge();
    b?.keepScreenOn?.(true);
    if (!("wakeLock" in navigator)) return () => b?.keepScreenOn?.(false);
    let lock: WakeLockSentinel | null = null;
    const get = () => navigator.wakeLock.request("screen").then((l) => (lock = l)).catch(() => {});
    get();
    const onVis = () => document.visibilityState === "visible" && get();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
      b?.keepScreenOn?.(false);
    };
  }, [finished]);

  // koniec przerwy
  const restLeft = rest ? Math.ceil((rest.end - now) / 1000) : null;
  useEffect(() => {
    if (restLeft !== null && restLeft <= 0) {
      setRest(null);
      setRestFull(false);
      navigator.vibrate?.([300, 120, 300]);
      beep();
    }
  }, [restLeft]);
  const startRest = (sec: number) => setRest({ end: Date.now() + sec * 1000, total: sec });
  const addRest = (d: number) => setRest((r) => (r ? { end: r.end + d * 1000, total: Math.max(1, r.total + d) } : r));

  // autozapis
  const doSave = useCallback(async () => {
    setSave("busy");
    try {
      const r = await fetch(`/api/strength/${initial.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, notes, items }),
      });
      if (!r.ok) throw new Error();
      dirty.current = false;
      setSave("ok");
    } catch {
      setSave("err");
    }
  }, [initial.id, name, notes, items]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    dirty.current = true;
    const t = setTimeout(doSave, 700);
    return () => clearTimeout(t);
  }, [name, notes, items, doSave]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, []);

  const upd = (i: number, f: (it: ItemDTO) => ItemDTO) => setItems((xs) => xs.map((x, j) => (j === i ? f(x) : x)));
  const updSet = (i: number, k: number, patch: Partial<SetDTO>) =>
    upd(i, (it) => ({ ...it, sets: it.sets.map((s, j) => (j === k ? { ...s, ...patch } : s)) }));

  const toggleDone = (i: number, k: number) => {
    const it = items[i];
    const s = it.sets[k];
    if (!s.done) {
      // puste pola -> wartości z poprzedniego razu (albo z poprzedniej serii)
      const ref = it.prev[k] ?? it.sets[k - 1] ?? null;
      const gotowa = {
        ...s,
        weight: s.weight ?? ref?.weight ?? null,
        reps: s.reps ?? ref?.reps ?? null,
        seconds: s.seconds ?? ref?.seconds ?? null,
        meters: s.meters ?? ref?.meters ?? null,
      };
      if (!hasResult(it.kind, gotowa)) return; // bez wyniku (powt. / czas / dystans) nie zaliczamy
      updSet(i, k, { ...gotowa, done: true });
      // superseria: przerwa dopiero po ostatnim ćwiczeniu z grupy
      const dalejWGrupie = it.superset != null && items[i + 1]?.superset === it.superset;
      if (!finished && !dalejWGrupie) {
        const czas = it.superset != null ? Math.max(...items.filter((x) => x.superset === it.superset).map((x) => x.rest)) : it.rest;
        startRest(s.warmup ? Math.min(60, czas) : czas);
      }
    } else updSet(i, k, { done: false });
  };

  const copyPrev = (i: number, k: number) => {
    const p = items[i].prev[k];
    if (p) updSet(i, k, { weight: p.weight, reps: p.reps, seconds: p.seconds, meters: p.meters });
  };

  const addSet = (i: number) =>
    upd(i, (it) => {
      const last = it.sets[it.sets.length - 1];
      return {
        ...it,
        sets: [...it.sets, { ...pustaSeria(), weight: last?.weight ?? null, reps: last?.reps ?? null, seconds: last?.seconds ?? null, meters: last?.meters ?? null }],
      };
    });
  const removeSet = (i: number) => upd(i, (it) => ({ ...it, sets: it.sets.slice(0, -1) }));
  const move = (i: number, d: -1 | 1) =>
    setItems((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const c = [...xs];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  const linkNext = (i: number) =>
    setItems((xs) => {
      if (i >= xs.length - 1) return xs;
      const s = xs[i].superset ?? Math.max(0, ...xs.map((x) => x.superset ?? 0)) + 100;
      return xs.map((x, j) => (j === i || j === i + 1 ? { ...x, superset: s } : x));
    });
  const unlink = (i: number) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, superset: null } : x)));

  async function addExercises(list: Ex[]) {
    setPicker(false);
    const nowe: ItemDTO[] = [];
    for (const e of list) {
      const prev = await fetch(`/api/strength/${initial.id}/prev?exerciseId=${e.id}`).then((r) => r.json()).catch(() => []);
      const p = Array.isArray(prev) ? prev : [];
      const n = Math.max(3, p.filter((x: SetDTO) => !x.warmup).length || 0);
      nowe.push({
        exerciseId: e.id,
        name: e.name,
        category: e.category,
        kind: e.kind,
        info: e.info,
        thumb: e.thumb,
        superset: null,
        rest: e.rest,
        notes: "",
        target: "",
        prev: p,
        sets: Array.from({ length: Math.min(n, 8) }, pustaSeria),
      });
    }
    setItems((xs) => [...xs, ...nowe]);
  }

  async function finish() {
    const niezal = items.reduce((n, it) => n + it.sets.filter((s) => !s.done).length, 0);
    if (niezal && !confirm(`${niezal} serii nie jest odhaczonych — nie wejdą do statystyk. Zakończyć?`)) return;
    setFinishing(true);
    await doSave();
    const r = await fetch(`/api/strength/${initial.id}/finish`, { method: "POST" }).then((x) => x.json()).catch(() => ({}));
    setRecords(r.rekordy ?? []);
    setRest(null);
    router.refresh();
  }

  async function saveTemplate() {
    const n = prompt("Nazwa szablonu:", name);
    if (!n) return;
    setTpl("busy");
    await doSave();
    const r = await fetch("/api/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromSessionId: initial.id, name: n }) });
    setTpl(r.ok ? "ok" : "");
  }

  const elapsed = Math.floor(((initial.finishedAt ? new Date(initial.finishedAt).getTime() : now) - new Date(initial.startedAt).getTime()) / 1000);
  const doneSets = items.flatMap((it) => it.sets.filter((s) => s.done && !s.warmup));
  const volume = doneSets.reduce((n, s) => n + (s.weight ?? 0) * (s.reps ?? 0), 0);
  const litera = (n: number) => String.fromCharCode(64 + n);

  return (
    <>
      <div className="sticky">
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <Link href="/silownia" className="mut" aria-label="Wróć" style={{ display: "grid" }}><Icon name="back" /></Link>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ fontWeight: 750, fontSize: 17, border: "none", background: "transparent", padding: "4px 0" }} />
          <span className="clock">{clock(elapsed)}</span>
          {!finished && (
            <button className="pri" onClick={finish} disabled={finishing}>
              {finishing ? "…" : "Zakończ"}
            </button>
          )}
        </div>
        <div className="chips" style={{ margin: "4px 0 0" }}>
          <span><b>{doneSets.length}</b> {serie(doneSets.length)}</span>
          <span><b>{Math.round(volume).toLocaleString("pl-PL")}</b> kg</span>
          {initial.plannedTitle && <span>z planu: {initial.plannedTitle}</span>}
          <span className={save === "err" ? "err" : ""} style={{ marginLeft: "auto" }}>
            {save === "busy" ? "zapisuję…" : save === "err" ? "błąd zapisu — sprawdź Tailscale" : "zapisano"}
          </span>
        </div>
      </div>

      {records && (
        <div className="card hero">
          <b>Trening zapisany.</b>
          {records.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {records.map((r) => (
                <div key={r} className="row" style={{ flexWrap: "nowrap", gap: 6 }}><Icon name="trophy" size={16} style={{ color: "var(--acc)" }} /> {r}</div>
              ))}
            </div>
          )}
          <div className="mut small" style={{ marginTop: 6 }}>Analiza trenera pojawi się na Discordzie i tutaj za ok. minutę.</div>
        </div>
      )}

      {items.map((it, i) => {
        const dzis = describeBest(bestOf(it.kind, it.sets.filter((s) => s.done)));
        const kol = KOLUMNY[it.kind];
        const ssStart = it.superset != null && items[i - 1]?.superset !== it.superset;
        const ssNext = it.superset != null && items[i + 1]?.superset === it.superset;
        const nextWeight = (it.sets.find((s) => !s.done) ?? it.sets[it.sets.length - 1])?.weight ?? it.prev.find((p) => !p.warmup)?.weight ?? null;
        return (
          <div key={`${it.exerciseId}-${i}`}>
            {ssStart && <div className="ss-lbl">Superseria {litera(it.superset!)}</div>}
            <div className={`card ex ${it.superset != null ? "ss" : ""}`} style={ssNext ? { marginBottom: 4 } : undefined}>
              <div className="ex-head">
                <Thumb src={it.thumb} name={it.name} onClick={it.info ? () => setInfo(it.exerciseId) : undefined} />
                <div className="grow">
                  <h3 style={{ margin: 0 }}>{it.name}</h3>
                  <div className="small mut">
                    {it.category} · <Icon name="timer" size={13} style={{ verticalAlign: -2 }} /> {mmss(it.rest)}
                  </div>
                  {it.target && <div className="small" style={{ marginTop: 4 }}><span className="tag acc">cel: {it.target}</span></div>}
                </div>
                <button className="ibtn" onClick={() => setMenu(menu === i ? null : i)} aria-label="Opcje ćwiczenia"><Icon name="more" /></button>
              </div>
              {menu === i && (
                <div className="ex-menu">
                  <select
                    value={it.kind}
                    aria-label="Typ serii"
                    onChange={async (e) => {
                      const k = e.target.value as Kind;
                      await fetch(`/api/exercises/${it.exerciseId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: k }) });
                      setItems((xs) => xs.map((x) => (x.exerciseId === it.exerciseId ? { ...x, kind: k } : x)));
                    }}
                  >
                    {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                  <button onClick={() => upd(i, (x) => ({ ...x, rest: Math.max(15, x.rest - 15) }))} aria-label="Krótsza przerwa">−15 s</button>
                  <button onClick={() => upd(i, (x) => ({ ...x, rest: Math.min(600, x.rest + 15) }))} aria-label="Dłuższa przerwa">+15 s</button>
                  {it.kind !== "time" && <button onClick={() => { setPlates({ i, w: nextWeight }); setMenu(null); }}><Icon name="plates" size={16} /> Talerze</button>}
                  {i < items.length - 1 && !ssNext && <button onClick={() => { linkNext(i); setMenu(null); }}><Icon name="link" size={16} /> Superseria z następnym</button>}
                  {it.superset != null && <button onClick={() => { unlink(i); setMenu(null); }}>Wyjmij z superserii</button>}
                  <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="W górę"><Icon name="up" size={16} /></button>
                  <button onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="W dół"><Icon name="down" size={16} /></button>
                  <button className="danger" onClick={() => { if (confirm(`Usunąć ${it.name}?`)) { setItems((xs) => xs.filter((_, j) => j !== i)); setMenu(null); } }} aria-label="Usuń ćwiczenie">
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              )}
              <table className="sets">
                <thead>
                  <tr>
                    <th>Seria</th>
                    <th>Poprzednio</th>
                    <th>
                      {it.kind !== "time" ? (
                        <button className="lnk" style={{ color: "inherit", font: "inherit" }} onClick={() => setPlates({ i, w: nextWeight })} aria-label="Kalkulator talerzy">
                          {kol.kg} <Icon name="plates" size={12} style={{ verticalAlign: -1 }} />
                        </button>
                      ) : kol.kg}
                    </th>
                    <th>{kol.res}</th>
                    <th><Icon name="check" size={14} /></th>
                  </tr>
                </thead>
                <tbody>
                  {it.sets.map((s, k) => {
                    const p = it.prev[k];
                    const nr = it.sets.slice(0, k + 1).filter((x) => !x.warmup).length;
                    return (
                      <tr key={k} className={s.done ? "done" : ""}>
                        <td>
                          <button className={`setno ${s.warmup ? "w" : ""}`} title="Dotknij: rozgrzewkowa / robocza" onClick={() => updSet(i, k, { warmup: !s.warmup })}>
                            {s.warmup ? "R" : nr}
                          </button>
                        </td>
                        <td className="prev">
                          {p ? <button onClick={() => copyPrev(i, k)} title="Przepisz z poprzedniego razu">{fmtSet(it.kind, p)}</button> : "—"}
                        </td>
                        <td style={{ width: "24%" }}>
                          <NumInput mode="decimal" value={s.weight} placeholder={p?.weight ? String(p.weight).replace(".", ",") : "—"} onChange={(v) => updSet(i, k, { weight: v })} />
                        </td>
                        <td style={{ width: "22%" }}>
                          <NumInput
                            mode={kol.mode}
                            value={s[kol.field]}
                            placeholder={p?.[kol.field] != null ? (kol.mode === "time" ? (p.seconds! >= 60 ? `${Math.floor(p.seconds! / 60)}:${String(p.seconds! % 60).padStart(2, "0")}` : String(p.seconds)) : String(p[kol.field]).replace(".", ",")) : kol.mode === "time" ? "s / m:ss" : ""}
                            onChange={(v) => updSet(i, k, { [kol.field]: v } as Partial<SetDTO>)}
                          />
                        </td>
                        <td>
                          <button className={`tick ${s.done ? "on" : ""}`} onClick={() => toggleDone(i, k)} aria-label="Zalicz serię"><Icon name="check" size={20} /></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="ex-foot">
                <button onClick={() => addSet(i)}><Icon name="plus" size={16} /> Seria</button>
                <button onClick={() => removeSet(i)} disabled={!it.sets.length}>− Seria</button>
              </div>
              {dzis && <div className="small mut" style={{ marginTop: 6 }}>Dziś najlepiej: {dzis}</div>}
            </div>
          </div>
        );
      })}

      <button className="block big-start" onClick={() => setPicker(true)} style={{ marginBottom: 10 }}><Icon name="plus" size={18} /> Dodaj ćwiczenia</button>
      <label>Notatka do treningu (trener ją przeczyta)</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="np. łokieć pobolewał przy pronacji, słaby sen" />

      {finished && (
        <>
          <button className="block" style={{ marginTop: 12 }} onClick={saveTemplate} disabled={tpl !== ""}>
            <Icon name="template" size={18} /> {tpl === "ok" ? "Zapisano jako szablon" : tpl === "busy" ? "Zapisuję…" : "Zapisz jako szablon"}
          </button>
          <h2>Analiza trenera</h2>
          <div className="card">
            {initial.analysis ? <Md text={initial.analysis} /> : <p className="mut" style={{ marginTop: 0 }}>Analiza w drodze albo wyłączona. Odśwież za chwilę.</p>}
            <Reanalyze id={initial.id} />
          </div>
          <DeleteSession id={initial.id} />
        </>
      )}

      {rest && restLeft !== null && restLeft > 0 && !restFull && (
        <div className="rest">
          <Icon name="timer" />
          <b onClick={() => setRestFull(true)} title="Pełny ekran">{mmss(restLeft)}</b>
          <button onClick={() => addRest(-15)}>−15</button>
          <button onClick={() => addRest(15)}>+15</button>
          <button onClick={() => setRest(null)}>Pomiń</button>
          <span className="prog" style={{ width: `${Math.min(100, (restLeft / rest.total) * 100)}%` }} />
        </div>
      )}
      {rest && restLeft !== null && restLeft > 0 && restFull && (
        <div className="restfull" onClick={(e) => e.target === e.currentTarget && setRestFull(false)}>
          <div className="mut">Przerwa</div>
          <div className="ring">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="45" fill="none" stroke="var(--card2)" strokeWidth="6" />
              <circle
                cx="50" cy="50" r="45" fill="none" stroke="var(--acc)" strokeWidth="6" strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 45}
                strokeDashoffset={2 * Math.PI * 45 * (1 - Math.min(1, restLeft / rest.total))}
                style={{ transition: "stroke-dashoffset 0.5s linear" }}
              />
            </svg>
            <b>{mmss(restLeft)}</b>
          </div>
          <div className="row" style={{ justifyContent: "center" }}>
            <button onClick={() => addRest(-15)}>−15 s</button>
            <button onClick={() => addRest(15)}>+15 s</button>
          </div>
          <div className="row" style={{ justifyContent: "center" }}>
            <button className="pri" onClick={() => { setRest(null); setRestFull(false); }}>Pomiń przerwę</button>
            <button onClick={() => setRestFull(false)}>Zwiń</button>
          </div>
        </div>
      )}

      {picker && <ExercisePicker onPick={addExercises} onInfo={setInfo} onClose={() => setPicker(false)} />}
      {info !== null && <ExerciseInfo id={info} onClose={() => setInfo(null)} />}
      {plates && (
        <PlateCalc
          initial={plates.w}
          onClose={() => setPlates(null)}
          onApply={(w) => {
            const it = items[plates.i];
            const k = it.sets.findIndex((s) => !s.done);
            if (k >= 0) updSet(plates.i, k, { weight: w });
          }}
        />
      )}
    </>
  );
}

function Reanalyze({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          const r = await fetch(`/api/strength/${id}/finish`, { method: "PUT" });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) setErr(j.error ?? "Błąd");
          setBusy(false);
          router.refresh();
        }}
      >
        {busy ? "Analizuję…" : "↻ Analizuj ponownie"}
      </button>
      {err && <div className="err small">{err}</div>}
    </>
  );
}

function DeleteSession({ id }: { id: number }) {
  const router = useRouter();
  return (
    <button
      className="danger block"
      style={{ marginTop: 16 }}
      onClick={async () => {
        if (!confirm("Usunąć ten trening na stałe?")) return;
        await fetch(`/api/strength/${id}`, { method: "DELETE" });
        router.push("/silownia");
        router.refresh();
      }}
    >
      Usuń trening
    </button>
  );
}
