"use client";
// Karta ćwiczenia: zdjęcia i instrukcja z biblioteki free-exercise-db (zdjęcia ładowane z GitHuba dopiero tutaj)
import { useEffect, useState } from "react";
import { IMG_BASE, KIND_LABEL, asKind } from "@/lib/kinds";

interface Full {
  id: number;
  name: string;
  nameEn: string | null;
  category: string;
  kind: string;
  equipment: string;
  muscles: string;
  level: string;
  images: string[];
  instructions: string[];
}

const POZIOM: Record<string, string> = { beginner: "początkujący", intermediate: "średniozaawansowany", expert: "zaawansowany" };

export default function ExerciseInfo({ id, onClose }: { id: number; onClose: () => void }) {
  const [e, setE] = useState<Full | null>(null);
  const [img, setImg] = useState(0);
  useEffect(() => {
    fetch(`/api/exercises/${id}`).then((r) => r.json()).then(setE).catch(() => {});
  }, [id]);
  // dwa zdjęcia z bazy = pozycja startowa i końcowa — przełączamy je jak animację
  useEffect(() => {
    if (!e || e.images.length < 2) return;
    const t = setInterval(() => setImg((i) => (i + 1) % e.images.length), 1200);
    return () => clearInterval(t);
  }, [e]);
  return (
    <>
      <div className="sheet-bg" onClick={onClose} style={{ zIndex: 50 }} />
      <div className="sheet" style={{ zIndex: 51 }}>
        <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <div className="grow">
            <h3 style={{ margin: 0 }}>{e?.name ?? "…"}</h3>
            {e?.nameEn && <div className="small mut">{e.nameEn}</div>}
          </div>
          <button onClick={onClose}>✕</button>
        </div>
        {e && (
          <>
            <div className="row small" style={{ margin: "8px 0" }}>
              <span className="tag acc">{KIND_LABEL[asKind(e.kind)]}</span>
              <span className="tag">{e.category}</span>
              {e.equipment && <span className="tag">{e.equipment}</span>}
              {e.level && <span className="tag">{POZIOM[e.level] ?? e.level}</span>}
            </div>
            {e.muscles && <div className="small mut">Mięśnie: {e.muscles}</div>}
            {e.images.length > 0 && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={IMG_BASE + e.images[img]}
                alt={e.name}
                style={{ width: "100%", borderRadius: 12, marginTop: 10, background: "#fff", aspectRatio: "4 / 3", objectFit: "contain" }}
              />
            )}
            {e.instructions.length > 0 && (
              <>
                <h2 style={{ marginTop: 14 }}>Jak wykonać <span className="small">(EN)</span></h2>
                <ol style={{ paddingLeft: 20, margin: 0 }} className="small">
                  {e.instructions.map((s, i) => <li key={i} style={{ marginBottom: 6 }}>{s}</li>)}
                </ol>
              </>
            )}
            {!e.images.length && !e.instructions.length && <p className="mut small">Brak opisu w bazie dla tego ćwiczenia.</p>}
          </>
        )}
      </div>
    </>
  );
}
