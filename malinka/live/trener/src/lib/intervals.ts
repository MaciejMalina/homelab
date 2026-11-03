// Klient API intervals.icu (Basic auth: użytkownik "API_KEY", hasło = klucz API)
// https://forum.intervals.icu/t/api-access-to-intervals-icu/609

const BASE = (process.env.INTERVALS_BASE_URL?.trim() || "https://intervals.icu") + "/api/v1";

type Json = Record<string, unknown>;

function cfg() {
  const id = process.env.INTERVALS_ATHLETE_ID?.trim();
  const key = process.env.INTERVALS_API_KEY?.trim();
  if (!id || !key) throw new Error("Brak INTERVALS_ATHLETE_ID / INTERVALS_API_KEY w .env");
  return { id, auth: "Basic " + Buffer.from(`API_KEY:${key}`).toString("base64") };
}

export const intervalsConfigured = () =>
  !!(process.env.INTERVALS_ATHLETE_ID?.trim() && process.env.INTERVALS_API_KEY?.trim());

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { auth } = cfg();
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`intervals.icu ${init.method ?? "GET"} ${path.split("?")[0]} → HTTP ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  const txt = await res.text();
  return (txt ? JSON.parse(txt) : undefined) as T;
}

const athlete = () => `/athlete/${encodeURIComponent(cfg().id)}`;

export async function getAthlete() {
  return call<Json>(athlete());
}

export async function listActivities(oldest: string, newest: string) {
  return call<Json[]>(`${athlete()}/activities?oldest=${oldest}&newest=${newest}`);
}

export async function getActivityDetail(id: string) {
  return call<Json>(`/activity/${encodeURIComponent(id)}?intervals=true`);
}

export async function listWellness(oldest: string, newest: string) {
  return call<Json[]>(`${athlete()}/wellness?oldest=${oldest}&newest=${newest}`);
}

export interface NewEvent {
  uid: string;
  date: string;
  type: string;
  name: string;
  description: string;
  movingTimeSec?: number;
}

export async function createEvents(events: NewEvent[]) {
  if (!events.length) return [] as Json[];
  const body = events.map((e) => ({
    category: "WORKOUT",
    start_date_local: `${e.date}T00:00:00`,
    type: e.type,
    name: e.name,
    description: e.description,
    uid: e.uid,
    ...(e.movingTimeSec ? { moving_time: e.movingTimeSec } : {}),
  }));
  return call<Json[]>(`${athlete()}/events/bulk?upsertOnUid=true`, { method: "POST", body: JSON.stringify(body) });
}

/** Przesuwa zaplanowany trening w kalendarzu intervals.icu na inny dzień (stamtąd trafia do Huawei Health / zegarka) */
export async function moveEvent(eventId: string, date: string) {
  return call<Json>(`${athlete()}/events/${encodeURIComponent(eventId)}`, {
    method: "PUT",
    body: JSON.stringify({ start_date_local: `${date}T00:00:00` }),
  });
}

export async function deleteEvent(eventId: string) {
  await call<void>(`${athlete()}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
}

// ---------- mapowanie odpowiedzi (nazwy pól bywają różne, więc szukamy kilku wariantów) ----------

export function pick<T = unknown>(o: Json, ...keys: string[]): T | undefined {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v as T;
  }
  return undefined;
}
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && isFinite(Number(v)) ? Number(v) : undefined);
const int = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
};

export function mapActivity(a: Json) {
  const start = String(pick(a, "start_date_local", "start_date") ?? "");
  return {
    id: String(a.id),
    startLocal: start,
    date: start.slice(0, 10),
    type: String(pick(a, "type") ?? "Workout"),
    name: String(pick(a, "name") ?? ""),
    movingTime: int(pick(a, "moving_time", "icu_recording_time")),
    elapsedTime: int(pick(a, "elapsed_time")),
    distance: num(pick(a, "distance", "icu_distance")),
    avgHr: int(pick(a, "average_heartrate", "icu_average_hr")),
    maxHr: int(pick(a, "max_heartrate", "icu_max_hr")),
    load: int(pick(a, "icu_training_load", "training_load")),
    elevation: num(pick(a, "total_elevation_gain", "icu_elevation_gain")),
    calories: int(pick(a, "calories", "icu_calories")),
    avgCadence: num(pick(a, "average_cadence")),
    rpe: int(pick(a, "icu_rpe", "perceived_exertion")),
    hrZones: (() => {
      const z = pick<unknown[]>(a, "icu_hr_zone_times");
      return Array.isArray(z) ? JSON.stringify(z) : undefined;
    })(),
  };
}

/** Skrót odcinków z /activity/{id}?intervals=true — maks. 40 pozycji */
export function mapLaps(detail: Json): string | undefined {
  const arr = pick<Json[]>(detail, "icu_intervals");
  if (!Array.isArray(arr) || !arr.length) return undefined;
  const laps = arr.slice(0, 40).map((l) => {
    const dist = num(pick(l, "distance"));
    const time = int(pick(l, "moving_time", "elapsed_time"));
    return {
      typ: pick(l, "type") ?? "",
      dyst_m: dist !== undefined ? Math.round(dist) : undefined,
      czas_s: time,
      tempo_s_km: dist && time ? Math.round(time / (dist / 1000)) : undefined,
      hr: int(pick(l, "average_heartrate")),
      hr_max: int(pick(l, "max_heartrate")),
      kadencja: int(pick(l, "average_cadence")),
    };
  });
  return JSON.stringify(laps);
}

export function mapWellness(w: Json) {
  return {
    date: String(w.id).slice(0, 10),
    sleepSecs: int(pick(w, "sleepSecs", "sleep_secs")),
    sleepScore: num(pick(w, "sleepScore", "sleep_score")),
    restingHr: int(pick(w, "restingHR", "restingHr", "resting_hr")),
    hrv: num(pick(w, "hrv", "hrvSDNN")),
    weight: num(pick(w, "weight")),
    steps: int(pick(w, "steps")),
    vo2max: num(pick(w, "vo2max", "VO2max")),
  };
}

/** Surowy JSON bez dużych tablic (strumienie, mapy) — żeby baza nie puchła */
export function slimRaw(o: Json) {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.length > 20) continue;
    if (typeof v === "string" && v.length > 2000) continue;
    out[k] = v;
  }
  return JSON.stringify(out);
}
