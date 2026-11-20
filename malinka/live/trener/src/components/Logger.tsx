"use client";
// Zapis treningu siłowego w trakcie — w stylu Strong/Hevy:
// kolumna "Poprzednio", ✓ zalicza serię i startuje przerwę, pusta seria przy ✓ bierze wartości z poprzedniego razu,
// autozapis co chwilę, ekran nie gaśnie w trakcie treningu.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ItemDTO, SessionDTO, SetDTO } from "@/lib/session";
import { fmtSet, hasResult, KIND_LABEL, KINDS, type Kind } from "@/lib/kinds";
import { bestOf, describeBest } from "@/lib/bests";
import Md from "./Md";
import NumInput from "./NumInput";
import ExerciseInfo from "./ExerciseInfo";

interface Ex { id: number; name: string; nameEn: string | null; category: string; kind: Kind; rest: number; core: boolean; muscles: string; info: boolean; used: number }

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
  const [info, setInfo] = useState<number | null>(null);
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
      if (!finished) setRestEnd(Date.now() + (s.warmup ? Math.min(60, it.rest) : it.rest) * 1000);
    } else updSet(i, k, { done: false });
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
        kind: e.kind,
        info: e.info,
        rest: e.rest,
        notes: "",
        target: "",
        prev: p,
        sets: Array.from({ length: Math.min(n, 8) }, pustaSeria),
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
        const dzis = describeBest(bestOf(it.kind, it.sets.filter((s) => s.done)));
        const kol = KOLUMNY[it.kind];
        return (
          <div key={`${it.exerciseId}-${i}`} className="card ex">
            <div className="ex-head">
              <div className="grow">
                <h3>
                  {it.name}{" "}
                  {it.info && (
                    <button onClick={() => setInfo(it.exerciseId)} aria-label="Jak wykonać" style={{ padding: "2px 8px", fontSize: 13 }}>ⓘ</button>
                  )}
                </h3>
                {it.target && <div className="small"><span className="tag acc">cel: {it.target}</span></div>}
              </div>
              <ItemMenu
                kind={it.kind}
                onKind={async (k) => {
                  await fetch(`/api/exercises/${it.exerciseId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: k }) });
                  setItems((xs) => xs.map((x) => (x.exerciseId === it.exerciseId ? { ...x, kind: k } : x)));
                }}
                rest={it.rest}
                onRest={(r) => upd(i, (x) => ({ ...x, rest: r }))}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={() => confirm(`Usunąć ${it.name}?`) && setItems((xs) => xs.filter((_, j) => j !== i))}
              />
            </div>
            <table className="sets">
              <thead>
                <tr><th>Seria</th><th>Poprzednio</th><th>{kol.kg}</th><th>{kol.res}</th><th>✓</th></tr>
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
                      <td className="prev">{p ? fmtSet(it.kind, p) : "—"}</td>
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
            {dzis && <div className="small mut" style={{ marginTop: 6 }}>Dziś najlepiej: {dzis}</div>}
          </div>
        );
      })}

      <button className="block" onClick={() => setPicker(true)} style={{ marginBottom: 10 }}>＋ Dodaj ćwiczenie</button>
      <label>Notatka do treningu (trener ją przeczyta)</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="np. łokieć pobolewał przy pronacji, słaby sen" />

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

      {picker && <ExercisePicker onPick={addExercise} onInfo={setInfo} onClose={() => setPicker(false)} />}
      {info !== null && <ExerciseInfo id={info} onClose={() => setInfo(null)} />}
    </>
  );
}

function ItemMenu({
  kind,
  onKind,
  rest,
  onRest,
  onUp,
  onDown,
  onRemove,
}: {
  kind: Kind;
  onKind: (k: Kind) => void;
  rest: number;
  onRest: (r: number) => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) return <button onClick={() => setOpen(true)} aria-label="Opcje" style={{ padding: "6px 10px" }}>⋯</button>;
  return (
    <div className="row" style={{ justifyContent: "flex-end" }}>
      <select value={kind} onChange={(e) => onKind(e.target.value as Kind)} style={{ width: "auto", padding: "8px" }} aria-label="Typ serii">
        {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
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

function ExercisePicker({ onPick, onInfo, onClose }: { onPick: (e: Ex) => void; onInfo: (id: number) => void; onClose: () => void }) {
  const [all, setAll] = useState<Ex[]>([]);
  const [q, setQ] = useState("");
  const [kat, setKat] = useState("");
  const [nowyTyp, setNowyTyp] = useState<Kind | "">("");
  useEffect(() => {
    fetch("/api/exercises").then((r) => r.json()).then((x) => Array.isArray(x) && setAll(x)).catch(() => {});
  }, []);
  const kategorie = useMemo(() => [...new Set(all.map((e) => e.category))].sort((a, b) => a.localeCompare(b, "pl")), [all]);
  const { lista, ile } = useMemo(() => {
    const t = q.trim().toLowerCase();
    let x = all;
    if (kat) x = x.filter((e) => e.category === kat);
    if (t) {
      const slowa = t.split(/\s+/);
      x = x.filter((e) => {
        const h = `${e.name} ${e.nameEn ?? ""} ${e.category} ${e.muscles}`.toLowerCase();
        return slowa.every((w) => h.includes(w));
      });
    } else if (!kat) {
      x = x.filter((e) => e.core || e.used > 0); // bez wyszukiwania: Twoje i podstawowe
    }
    // najpierw używane, potem podstawowe, potem reszta
    x = [...x].sort((a, b) => b.used - a.used || Number(b.core) - Number(a.core) || a.name.localeCompare(b.name, "pl"));
    return { lista: x.slice(0, 80), ile: x.length };
  }, [all, q, kat]);
  const exact = all.some((e) => e.name.toLowerCase() === q.trim().toLowerCase());
  return (
    <>
      <div className="sheet-bg" onClick={onClose} />
      <div className="sheet">
        <div className="row" style={{ marginBottom: 8, flexWrap: "nowrap" }}>
          <input autoFocus placeholder={`Szukaj w ${all.length || "…"} ćwiczeniach (PL / EN)…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <button onClick={onClose}>✕</button>
        </div>
        <div className="row" style={{ marginBottom: 8, flexWrap: "nowrap", overflowX: "auto", paddingBottom: 4 }}>
          <button className={`tag ${kat === "" ? "acc" : ""}`} style={{ border: "none", whiteSpace: "nowrap" }} onClick={() => setKat("")}>
            {q ? "Wszystkie" : "Moje i podstawowe"}
          </button>
          {kategorie.map((k) => (
            <button key={k} className={`tag ${kat === k ? "acc" : ""}`} style={{ border: "none", whiteSpace: "nowrap" }} onClick={() => setKat(kat === k ? "" : k)}>
              {k}
            </button>
          ))}
        </div>
        {q.trim() && !exact && (
          <div className="row" style={{ marginBottom: 8, flexWrap: "nowrap" }}>
            <select value={nowyTyp} onChange={(e) => setNowyTyp(e.target.value as Kind | "")} style={{ width: "auto" }} aria-label="Typ nowego ćwiczenia">
              <option value="">typ: auto</option>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <button
              className="pri grow"
              onClick={async () => {
                const e = await fetch("/api/exercises", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: q.trim(), kind: nowyTyp || undefined }),
                }).then((r) => r.json());
                if (e?.id) onPick(e);
              }}
            >
              ＋ Nowe: „{q.trim()}”
            </button>
          </div>
        )}
        {lista.map((e) => (
          <div key={e.id} className="row" style={{ flexWrap: "nowrap", gap: 6, marginBottom: 6 }}>
            <button className="pick grow" style={{ marginBottom: 0 }} onClick={() => onPick(e)}>
              <span>
                {e.name}
                {e.kind !== "weight_reps" && <span className="mut small"> · {KIND_LABEL[e.kind]}</span>}
              </span>
              <span className="mut small">{e.used ? `${e.used}×` : e.category}</span>
            </button>
            {e.info && <button onClick={() => onInfo(e.id)} aria-label="Jak wykonać" style={{ padding: "8px 10px" }}>ⓘ</button>}
          </div>
        ))}
        {ile > lista.length && <div className="small mut">…i {ile - lista.length} więcej — zawęź wyszukiwanie.</div>}
        {!lista.length && all.length > 0 && <div className="small mut">Nic nie znaleziono — dodaj jako nowe ćwiczenie.</div>}
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
