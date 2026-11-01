// Daty liczone zawsze w strefie Europe/Warsaw, niezależnie od TZ kontenera.
// Daty dzienne przechowujemy jako "YYYY-MM-DD" (bez czasu), arytmetyka w UTC w południe — bez pułapek DST.

export const TZ = "Europe/Warsaw";

const DNI_KROTKIE = ["nd", "pn", "wt", "śr", "cz", "pt", "sb"] as const;
const DNI_DLUGIE = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];

export function nowPL(d: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

export const todayPL = () => nowPL().date;

function toUTC(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
function fromUTC(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number) {
  const d = toUTC(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

/** 0 = niedziela ... 6 = sobota */
export const weekdayIdx = (date: string) => toUTC(date).getUTCDay();
export const weekdayShort = (date: string) => DNI_KROTKIE[weekdayIdx(date)];
export const weekdayLong = (date: string) => DNI_DLUGIE[weekdayIdx(date)];

/** Poniedziałek tygodnia, do którego należy data */
export function weekStart(date: string) {
  const idx = weekdayIdx(date);
  return addDays(date, idx === 0 ? -6 : 1 - idx);
}

export function daysBetween(a: string, b: string) {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86400000);
}

export function fmtDate(date: string) {
  const [y, m, d] = date.split("-");
  return `${weekdayShort(date)} ${d}.${m}${y === todayPL().slice(0, 4) ? "" : "." + y}`;
}

export function fmtDuration(sec?: number | null) {
  if (sec == null || !isFinite(sec)) return "–";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

/** sekundy na km -> "4:16/km" */
export function fmtPace(secPerKm?: number | null) {
  if (secPerKm == null || !isFinite(secPerKm) || secPerKm <= 0) return "–";
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`;
}

export function fmtKm(m?: number | null) {
  if (m == null) return "–";
  return `${(m / 1000).toFixed(m >= 10000 ? 1 : 2).replace(".", ",")} km`;
}

/** "1:29:59" / "89:59" / "5400" -> sekundy */
export function parseDuration(txt: string): number | null {
  const t = txt.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const p = t.split(":").map(Number);
  if (p.some((x) => !isFinite(x))) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return null;
}
