"use client";
// Pole liczbowe, które pozwala spokojnie wpisać „7,5” albo „1:30”.
// Trzyma własny tekst w trakcie pisania (sterowane pole z liczbą zjadało przecinek: „7,” -> 7),
// a wartość liczbową oddaje rodzicowi przy każdej poprawnej zmianie.
import { useEffect, useState } from "react";

import { fmtNum, parseNum, type Mode } from "@/lib/numfmt";

export default function NumInput({
  value,
  onChange,
  mode = "decimal",
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  mode?: Mode;
  placeholder?: string;
}) {
  const [text, setText] = useState(fmtNum(value, mode));
  const [focus, setFocus] = useState(false);

  // zmiana z zewnątrz (np. ✓ uzupełnił serię z poprzedniego razu) — tylko gdy nie piszesz
  useEffect(() => {
    if (!focus) setText(fmtNum(value, mode));
  }, [value, mode, focus]);

  return (
    <input
      inputMode={mode === "int" ? "numeric" : mode === "time" ? "text" : "decimal"}
      placeholder={placeholder}
      value={text}
      onFocus={(e) => {
        setFocus(true);
        e.target.select();
      }}
      onBlur={() => {
        setFocus(false);
        const v = parseNum(text, mode);
        setText(fmtNum(v === undefined ? value : v, mode));
      }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const v = parseNum(t, mode);
        if (v !== undefined) onChange(v);
      }}
    />
  );
}
