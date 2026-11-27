// Parsowanie i formatowanie liczb w polach loggera (przecinek dziesiętny, czas m:ss)

export type Mode = "decimal" | "int" | "time";

export function parseNum(t: string, mode: Mode): number | null | undefined {
  const v = t.trim().replace(/\s+/g, "");
  if (v === "") return null;
  if (mode === "time") {
    const m = v.match(/^(\d+)[:.,](\d{1,2})$/); // 1:30, 1.30, 1,30 -> 90 s
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return /^\d+$/.test(v) ? Number(v) : undefined; // same sekundy
  }
  const n = Number(v.replace(",", "."));
  if (!isFinite(n) || n < 0) return undefined;
  // powtórzenia: tylko całe liczby (13,5 nie zamienia się po cichu w 14)
  if (mode === "int") return Number.isInteger(n) ? n : undefined;
  return Math.round(n * 1000) / 1000;
}

export function fmtNum(n: number | null | undefined, mode: Mode): string {
  if (n == null) return "";
  if (mode === "time") return n >= 60 ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}` : String(n);
  return String(n).replace(".", ",");
}

