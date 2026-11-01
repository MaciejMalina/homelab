"use client";
// Zapis treningu siłowego w trakcie — w stylu Strong/Hevy:
// kolumna "Poprzednio", ✓ zalicza serię i startuje przerwę, pusta seria przy ✓ bierze wartości z poprzedniego razu,
// autozapis co chwilę, ekran nie gaśnie w trakcie treningu.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ItemDTO, SessionDTO, SetDTO } from "@/lib/session";
import Md from "./Md";

interface Ex { id: number; name: string; category: string; rest: number }

const e1rm = (w: number | null, r: number | null) => (w && r && r <= 12 ? (r === 1 ? w : w * (1 + r / 30)) : 0);
const fmtNum = (n: number | null) => (n == null ? "" : String(n).replace(".", ","));
const parseNum = (t: string) => {
  const v = t.replace(",", ".").trim();
  if (v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};
const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
};
const serie = (n: number) => (n === 1 ? "seria" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "serie" : "serii");
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

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
  const [items, setItems] = useState<ItemDTO[]>(initial.items);
  const [save, setSave] = useState<"ok" | "busy" | "err">("ok");
  const [now, setNow] = useState(Date.now());
  const [restEnd, setRestEnd] = useState<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [records, setRecords] = useState<string[] | null>(null);
  const finished = !!initial.finishedAt;
  const dirty = useRef(false);
  const first = useRef(true);

  // zegar
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // ekran nie gaśnie w trakcie treningu
  useEffect(() => {
    if (finished || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const get = () => navigator.wakeLock.request("screen").then((l) => (lock = l)).catch(() => {});
    get();
    const onVis = () => document.visibilityState === "visible" && get();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, [finished]);

  // koniec przerwy
  const restLeft = restEnd ? Math.ceil((restEnd - now) / 1000) : null;
  useEffect(() => {
    if (restLeft !== null && restLeft <= 0) {
      setRestEnd(null);
      navigator.vibrate?.([300, 120, 300]);
      beep();
    }
  }, [restLeft]);

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
      // pusta seria -> weź wartości z poprzedniego razu (albo z poprzedniej serii)
      const ref = it.prev[k] ?? it.sets[k - 1] ?? null;
      const weight = s.weight ?? ref?.weight ?? null;
      const reps = s.reps ?? ref?.reps ?? null;
      if (reps == null) return; // bez powtórzeń nie zaliczamy
      updSet(i, k, { weight, reps, done: true });
      if (!finished) setRestEnd(Date.now() + (s.warmup ? Math.min(60, it.rest) : it.rest) * 1000);
    } else updSet(i, k, { done: false });
  };

  const addSet = (i: number) =>
    upd(i, (it) => {
      const last = it.sets[it.sets.length - 1];
      return { ...it, sets: [...it.sets, { weight: last?.weight ?? null, reps: last?.reps ?? null, rpe: null, warmup: false, done: false }] };
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

  async function addExercise(e: Ex) {
    setPicker(false);
    const prev = await fetch(`/api/strength/${initial.id}/prev?exerciseId=${e.id}`).then((r) => r.json()).catch(() => []);
    const p = Array.isArray(prev) ? prev : [];
    const n = Math.max(3, p.filter((x: SetDTO) => !x.warmup).length || 0);
    setItems((xs) => [
      ...xs,
      {
        exerciseId: e.id,
        name: e.name,
        category: e.category,
        rest: e.rest,
        notes: "",
        target: "",
        prev: p,
        sets: Array.from({ length: Math.min(n, 8) }, () => ({ weight: null, reps: null, rpe: null, warmup: false, done: false })),
      },
    ]);
  }

  async function finish() {
    const niezal = items.reduce((n, it) => n + it.sets.filter((s) => !s.done).length, 0);
    if (niezal && !confirm(`${niezal} serii nie jest odhaczonych — nie wejdą do statystyk. Zakończyć?`)) return;
    setFinishing(true);
    await doSave();
    const r = await fetch(`/api/strength/${initial.id}/finish`, { method: "POST" }).then((x) => x.json()).catch(() => ({}));
    setRecords(r.rekordy ?? []);
    setRestEnd(null);
    router.refresh();
  }

  const elapsed = Math.floor(((initial.finishedAt ? new Date(initial.finishedAt).getTime() : now) - new Date(initial.startedAt).getTime()) / 1000);
  const doneSets = items.flatMap((it) => it.sets.filter((s) => s.done && !s.warmup));
  const volume = doneSets.reduce((n, s) => n + (s.weight ?? 0) * (s.reps ?? 0), 0);

  return (
    <>
      <div className="sticky">
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <Link href="/silownia" className="mut" aria-label="Wróć">←</Link>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ fontWeight: 700, border: "none", background: "transparent", padding: "4px 0" }} />
          <span className="clock">{clock(elapsed)}</span>
          {!finished && (
            <button className="pri" onClick={finish} disabled={finishing}>
              {finishing ? "…" : "Zakończ"}
            </button>
          )}
        </div>
        <div className="small mut" style={{ marginTop: 2 }}>
          {doneSets.length} {serie(doneSets.length)} · {Math.round(volume).toLocaleString("pl-PL")} kg
          {initial.plannedTitle ? ` · z planu: ${initial.plannedTitle}` : ""} ·{" "}
          <span className={save === "err" ? "err" : ""}>{save === "busy" ? "zapisuję…" : save === "err" ? "błąd zapisu — sprawdź Tailscale" : "zapisano"}</span>
        </div>
      </div>

      {records && (
        <div className="card" style={{ borderColor: "var(--ok)" }}>
          <b>✅ Trening zapisany.</b>
          {records.length > 0 && <div style={{ marginTop: 6 }}>{records.map((r) => <div key={r}>🏆 {r}</div>)}</div>}
          <div className="mut small" style={{ marginTop: 6 }}>Analiza trenera pojawi się na Discordzie i tutaj za ok. minutę.</div>
        </div>
      )}

      {items.map((it, i) => {
        const best = Math.max(0, ...it.sets.filter((s) => s.done && !s.warmup).map((s) => e1rm(s.weight, s.reps)));
        return (
          <div key={`${it.exerciseId}-${i}`} className="card ex">
            <div className="ex-head">
              <div className="grow">
                <h3>{it.name}</h3>
                {it.target && <div className="small"><span className="tag acc">cel: {it.target}</span></div>}
              </div>
              <ItemMenu
                rest={it.rest}
                onRest={(r) => upd(i, (x) => ({ ...x, rest: r }))}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={() => confirm(`Usunąć ${it.name}?`) && setItems((xs) => xs.filter((_, j) => j !== i))}
              />
            </div>
            <table className="sets">
              <thead>
                <tr><th>Seria</th><th>Poprzednio</th><th>kg</th><th>Powt.</th><th>✓</th></tr>
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
                      <td className="prev">{p ? `${fmtNum(p.weight)}×${p.reps ?? ""}` : "—"}</td>
                      <td style={{ width: "26%" }}>
                        <input inputMode="decimal" placeholder={p?.weight != null ? fmtNum(p.weight) : ""} value={fmtNum(s.weight)} onChange={(e) => updSet(i, k, { weight: parseNum(e.target.value) })} onFocus={(e) => e.target.select()} />
                      </td>
                      <td style={{ width: "20%" }}>
                        <input inputMode="numeric" placeholder={p?.reps != null ? String(p.reps) : ""} value={s.reps ?? ""} onChange={(e) => updSet(i, k, { reps: parseNum(e.target.value) })} onFocus={(e) => e.target.select()} />
                      </td>
                      <td>
                        <button className={`tick ${s.done ? "on" : ""}`} onClick={() => toggleDone(i, k)} aria-label="Zalicz serię">✓</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="ex-foot">
              <button onClick={() => addSet(i)}>＋ Seria</button>
              <button onClick={() => removeSet(i)} disabled={!it.sets.length}>− Seria</button>
            </div>
            {best > 0 && <div className="small mut" style={{ marginTop: 6 }}>Szac. 1RM dziś: {Math.round(best * 10) / 10} kg</div>}
          </div>
        );
      })}

      <button className="block" onClick={() => setPicker(true)} style={{ marginBottom: 10 }}>＋ Dodaj ćwiczenie</button>
      <label>Notatka do treningu (trener ją przeczyta)</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="np. bark lekko pobolewał przy wyciskaniu, słaby sen" />

      {finished && (
        <>
          <h2>Analiza trenera</h2>
          <div className="card">
            {initial.analysis ? <Md text={initial.analysis} /> : <p className="mut" style={{ marginTop: 0 }}>Analiza w drodze albo wyłączona. Odśwież za chwilę.</p>}
            <Reanalyze id={initial.id} />
          </div>
          <DeleteSession id={initial.id} />
        </>
      )}

      {restLeft !== null && restLeft > 0 && (
        <div className="rest">
          <span>⏱ Przerwa</span>
          <b>{mmss(restLeft)}</b>
          <button onClick={() => setRestEnd((e) => (e ? e - 15000 : e))}>−15</button>
          <button onClick={() => setRestEnd((e) => (e ? e + 15000 : e))}>+15</button>
          <button onClick={() => setRestEnd(null)}>Pomiń</button>
        </div>
      )}

      {picker && <ExercisePicker onPick={addExercise} onClose={() => setPicker(false)} />}
    </>
  );
}

function ItemMenu({ rest, onRest, onUp, onDown, onRemove }: { rest: number; onRest: (r: number) => void; onUp: () => void; onDown: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button onClick={() => setOpen(true)} aria-label="Opcje" style={{ padding: "6px 10px" }}>⋯</button>;
  return (
    <div className="row" style={{ justifyContent: "flex-end" }}>
      <button onClick={() => onRest(Math.max(15, rest - 15))}>−</button>
      <span className="small">⏱ {mmss(rest)}</span>
      <button onClick={() => onRest(Math.min(600, rest + 15))}>+</button>
      <button onClick={onUp}>↑</button>
      <button onClick={onDown}>↓</button>
      <button className="danger" onClick={onRemove}>🗑</button>
      <button onClick={() => setOpen(false)}>✕</button>
    </div>
  );
}

function ExercisePicker({ onPick, onClose }: { onPick: (e: Ex) => void; onClose: () => void }) {
  const [all, setAll] = useState<Ex[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    fetch("/api/exercises").then((r) => r.json()).then(setAll).catch(() => {});
  }, []);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? all.filter((e) => e.name.toLowerCase().includes(t) || e.category.toLowerCase().includes(t)) : all;
  }, [all, q]);
  const exact = all.some((e) => e.name.toLowerCase() === q.trim().toLowerCase());
  return (
    <>
      <div className="sheet-bg" onClick={onClose} />
      <div className="sheet">
        <div className="row" style={{ marginBottom: 10, flexWrap: "nowrap" }}>
          <input autoFocus placeholder="Szukaj ćwiczenia…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button onClick={onClose}>✕</button>
        </div>
        {q.trim() && !exact && (
          <button
            className="pick pri"
            onClick={async () => {
              const e = await fetch("/api/exercises", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: q.trim() }) }).then((r) => r.json());
              if (e?.id) onPick(e);
            }}
          >
            ＋ Nowe ćwiczenie: „{q.trim()}”
          </button>
        )}
        {list.map((e) => (
          <button key={e.id} className="pick" onClick={() => onPick(e)}>
            <span>{e.name}</span>
            <span className="mut small">{e.category}</span>
          </button>
        ))}
      </div>
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
