// Logika trenera AI: analiza treningów, plan tygodniowy, czat
import { prisma, getSettings } from "./db";
import { askClaude, type Msg, type Tool } from "./claude";
import { buildContext, lastActivityLine, strengthSummary } from "./context";
import { addDays, fmtDate, todayPL, weekdayLong } from "./time";
import { PLAN_SPORTS, PLAN_TO_INTERVALS, type PlanSport, sportGroup, sportName, ICON, PLAN_ICON } from "./sport";
import { createEvents, deleteEvent, intervalsConfigured } from "./intervals";
import { notify, COLOR } from "./discord";
import { e1rm, fmtKg } from "./strength";

const SYSTEM = `Jesteś osobistym trenerem Macieja — doświadczonym trenerem biegania, przygotowania motorycznego i siłowania na rękę (armwrestlingu). Odpowiadasz zawsze po polsku, konkretnie i rzeczowo, bez lania wody i bez przesadnych pochwał. Jeśli coś idzie źle (za szybkie łatwe biegi, brak progresji, za mało snu, ryzyko przetrenowania, przeciążenie łokcia/nadgarstka), mówisz to wprost.

Cele Macieja:
1. Półmaraton w jak najlepszym czasie — to główny cel wytrzymałościowy.
2. Ogólna tężyzna fizyczna, a w niej najważniejsze: podciąganie (więcej powtórzeń, potem z obciążeniem) i siła do siłowania na rękę. Do tego nogi wspierające bieganie i całe ciało (FBW). Wyciskanie leżąc NIE jest celem — pchanie tylko jako uzupełnienie FBW.

Jak wygląda trening siłowy Macieja (zawsze tak planuj):
- Każda wizyta na siłowni = najpierw ok. 30 min biegu na bieżni, potem trening siłowy FBW (ok. 45–60 min).
- Bieg na bieżni przed siłownią to zwykle spokojny bieg w strefie 1–2; czasem krótkie przyspieszenia albo lekki akcent, ale nigdy ciężkie interwały przed ciężkimi nogami.
- Kolejność w części siłowej: 1) podciąganie (główne ćwiczenie, gdy jest najświeższy), 2) blok armwrestlingowy, 3) nogi pod bieganie, 4) pchanie i core — krótko.
- Podciąganie: 2–3× w tygodniu, różne bodźce (ciężej: mniej powtórzeń/z obciążeniem; objętościowo: serie submaksymalne, łączna liczba powtórzeń; technika: negatywy, różne chwyty). Progresja: dokładaj powtórzenia, a gdy serie po 8–10 są pewne — obciążenie.
- Armwrestling: pronacja, supinacja, rising (odwodzenie promieniowe), cupping/zginanie nadgarstka, side pressure i back pressure na wyciągu, uginania młotkowe, chwyt (gruby gryf, farmer, griper). Ścięgna adaptują się wolniej niż mięśnie — progresja ostrożna, 2–3 akcenty tygodniowo, częściej średnio-ciężko (np. 3–4×8–15, RPE 7–8) niż do upadku; przy bólu łokcia/nadgarstka natychmiast lżej.
- Nogi pod bieganie: jednonóż (przysiad bułgarski, step-up, martwy ciąg na jednej nodze), tylna taśma (RDL, hip thrust, nordic curl), łydki i stopa, core antyrotacyjny. Siła, nie zmęczenie — umiarkowana objętość, bez zakwaszania przed ważnym biegiem.

Bieganie:
- Ok. 80% objętości spokojnie (strefa 1–2, swobodna rozmowa). 30-minutowe biegi przed siłownią wliczaj do tygodniowej objętości.
- 1–2 akcenty tygodniowo (tempo/próg, interwały, odcinki w tempie półmaratonu) — w dni bez siłowni albo jako osobna sesja, długie wybieganie raz w tygodniu (w dniu z ustawień).
- Objętość zwiększasz ostrożnie (~10%/tydz.), co 3–4 tygodnie lżejszy tydzień.
- Nie stawiaj ciężkich nóg dzień przed akcentem biegowym ani przed długim wybieganiem.

Inne:
- Basen i rower jako uzupełnienie tlenowe o niskim obciążeniu stawów.
- Patrzysz na regenerację: krótki sen, podwyższone tętno spoczynkowe lub wysokie obciążenie poprzednich dni = lżej.
- Nie wymyślasz danych. Jeśli czegoś nie ma w danych, mówisz o tym. Nie jesteś lekarzem — przy bólu lub urazie odsyłasz do specjalisty.`;

const INTERVALS_SYNTAX = `Składnia kroków intervals.icu (pole kroki_intervals) — trafia na zegarek, musi być DOKŁADNIE taka:
- Każdy krok to linia zaczynająca się od "- ", potem czas (np. 10m, 90s, 1h) LUB dystans (np. 1km, 400mtr), potem cel tempa absolutnego w formacie "mm:ss/km Pace" albo zakres "5:40-5:20/km Pace". Na początku kroku można dać krótki tekst, np. "- Rozgrzewka 15m 6:00-5:30/km Pace".
- Powtórzenia: osobna linia "5x" przed krokami serii, a po serii pusta linia. Nie zagnieżdżaj powtórzeń.
- Basen: dystans w mtr i tempo "/100m Pace", np. "- 200mtr 2:10/100m Pace". Rower: cele w strefach tętna, np. "- 20m Z2 HR".
Przykład biegu:
- Rozgrzewka 15m 6:00-5:30/km Pace

5x
- 1km 4:05-4:00/km Pace
- 2m 6:30-6:00/km Pace

- Schłodzenie 10m 6:15-5:45/km Pace`;

// ---------------------------------------------------------------- analiza aktywności
export async function analyzeActivity(id: string, { notifyDiscord = true } = {}) {
  const a = await prisma.activity.findUnique({ where: { id } });
  if (!a) throw new Error("Nie ma takiej aktywności");
  const ctx = await buildContext({ days: 21 });
  const planned = await prisma.plannedWorkout.findMany({ where: { date: a.date } });
  const laps = a.laps ? `\nOdcinki/okrążenia (JSON): ${a.laps}` : "";
  const zones = a.hrZones ? `\nCzas w strefach tętna [s]: ${a.hrZones}` : "";
  const plan = planned.length
    ? `\nZaplanowane na ten dzień: ${planned.map((p) => `${p.sport} — ${p.title}: ${p.description}${p.intervalsText ? `\nKroki:\n${p.intervalsText}` : ""}`).join("\n")}`
    : "\nNa ten dzień nie było nic zaplanowanego w appce.";

  const { text } = await askClaude({
    system: SYSTEM + "\n\n# Dane Macieja\n" + ctx,
    maxTokens: 2500,
    messages: [
      {
        role: "user",
        content: `Przeanalizuj ten trening z zegarka:\n${await lastActivityLine(id)}${laps}${zones}${plan}

Odpowiedz w markdownie, maksymalnie ~170 słów, w sekcjach:
**Ocena** (1–2 zdania, czy realizuje cel/plan),
**Dobrze** (1–3 punkty),
**Do poprawy** (1–3 punkty, konkretnie: tempo, tętno, rozkład),
**Na kolejne dni** (czy i jak zmienić najbliższe treningi).`,
      },
    ],
  });
  await prisma.activity.update({ where: { id }, data: { analysis: text, analyzedAt: new Date() } });
  if (notifyDiscord) {
    const g = sportGroup(a.type);
    await notify({ title: `${ICON[g]} ${sportName(a.type)} ${fmtDate(a.date)}${a.name ? ` — ${a.name}` : ""}`, description: text, color: COLOR.info, path: `/aktywnosci/${id}` });
  }
  return text;
}

// ---------------------------------------------------------------- analiza siłowni + rekordy
export async function strengthRecords(sessionId: number) {
  const s = await prisma.strengthSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: { exercises: { include: { exercise: true, sets: true } } },
  });
  const rekordy: string[] = [];
  const bezCiezaru = (w: number | null) => w == null || w <= 0;
  for (const e of s.exercises) {
    const robocze = e.sets.filter((x) => x.done && !x.warmup);
    if (!robocze.length) continue;
    const wczesniej = await prisma.strengthSet.findMany({
      where: { done: true, warmup: false, item: { exerciseId: e.exerciseId, sessionId: { not: sessionId } } },
    });
    if (!wczesniej.length) continue;
    // ćwiczenia z ciężarem: szacowane 1RM
    const teraz = Math.max(0, ...robocze.map((x) => e1rm(x.weight, x.reps) ?? 0));
    const best = Math.max(0, ...wczesniej.map((x) => e1rm(x.weight, x.reps) ?? 0));
    if (teraz > best && best > 0) rekordy.push(`${e.exercise.name}: szac. 1RM ${fmtKg(teraz)} (było ${fmtKg(best)})`);
    // z masą ciała (np. podciąganie): najwięcej powtórzeń w serii
    const powt = Math.max(0, ...robocze.filter((x) => bezCiezaru(x.weight)).map((x) => x.reps ?? 0));
    const powtBest = Math.max(0, ...wczesniej.filter((x) => bezCiezaru(x.weight)).map((x) => x.reps ?? 0));
    if (powt > powtBest && powtBest > 0) rekordy.push(`${e.exercise.name}: ${powt} powt. w serii (było ${powtBest})`);
  }
  return rekordy;
}

export async function analyzeStrength(sessionId: number, { notifyDiscord = true } = {}) {
  const s = await prisma.strengthSession.findUniqueOrThrow({ where: { id: sessionId } });
  const ctx = await buildContext({ days: 21 });
  const rekordy = await strengthRecords(sessionId);
  const plan = s.plannedId ? await prisma.plannedWorkout.findUnique({ where: { id: s.plannedId } }) : null;
  const { text } = await askClaude({
    system: SYSTEM + "\n\n# Dane Macieja\n" + ctx,
    maxTokens: 2500,
    messages: [
      {
        role: "user",
        content: `Przeanalizuj właśnie zakończony trening siłowy:\n${await strengthSummary(sessionId)}
${plan ? `\nPlan na ten trening: ${plan.title} — ${plan.description}\n${plan.strength ?? ""}` : ""}
${rekordy.length ? `\nNowe rekordy (szacowane 1RM): ${rekordy.join("; ")}` : ""}

Odpowiedz w markdownie, maks. ~170 słów, sekcje: **Ocena**, **Dobrze**, **Do poprawy**, **Następnym razem** (konkretne ciężary/powtórzenia dla kluczowych ćwiczeń, zwłaszcza podciągania i bloku armwrestlingowego).`,
      },
    ],
  });
  await prisma.strengthSession.update({ where: { id: sessionId }, data: { analysis: text } });
  if (notifyDiscord) {
    await notify({
      title: `🏋️ Siłownia ${fmtDate(s.date)} — ${s.name}`,
      description: (rekordy.length ? `🏆 ${rekordy.join("\n🏆 ")}\n\n` : "") + text,
      color: rekordy.length ? COLOR.ok : COLOR.info,
      path: `/silownia/${sessionId}`,
    });
  }
  return text;
}

// ---------------------------------------------------------------- plan tygodniowy
const PLAN_TOOL: Tool = {
  name: "zapisz_plan",
  description: "Zapisuje plan treningowy na wskazane dni. Jeden wpis = jedna sesja (w jednym dniu może być kilka sesji).",
  input_schema: {
    type: "object",
    required: ["podsumowanie", "sesje"],
    properties: {
      podsumowanie: { type: "string", description: "2–4 zdania: cel i akcent tygodnia, progresja względem poprzedniego" },
      sesje: {
        type: "array",
        items: {
          type: "object",
          required: ["data", "sport", "tytul", "opis", "czas_min"],
          properties: {
            data: { type: "string", description: "YYYY-MM-DD" },
            sport: { type: "string", enum: [...PLAN_SPORTS] },
            tytul: { type: "string", description: "Krótko, np. 'Interwały 5×1 km' albo 'Klatka — dzień ciężki'" },
            opis: { type: "string", description: "Instrukcja w 1–3 zdaniach: cel sesji, na co uważać" },
            czas_min: { type: "integer" },
            kroki_intervals: { type: "string", description: "WYMAGANE dla Bieg/Rower/Basen: kroki w składni intervals.icu" },
            cwiczenia: {
              type: "array",
              description: "WYMAGANE dla Siłownia",
              items: {
                type: "object",
                required: ["nazwa", "serie", "powtorzenia"],
                properties: {
                  nazwa: { type: "string" },
                  serie: { type: "integer" },
                  powtorzenia: { type: "string", description: "np. '5' albo '8-10'" },
                  ciezar_kg: { type: ["number", "null"] },
                  rpe: { type: ["number", "null"] },
                  przerwa_s: { type: ["integer", "null"] },
                  uwagi: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

interface PlanInput {
  podsumowanie: string;
  sesje: {
    data: string;
    sport: string;
    tytul: string;
    opis: string;
    czas_min: number;
    kroki_intervals?: string;
    cwiczenia?: { nazwa: string; serie: number; powtorzenia: string; ciezar_kg?: number | null; rpe?: number | null; przerwa_s?: number | null; uwagi?: string }[];
  }[];
}

export interface StrengthItem {
  nazwa: string;
  serie: number;
  powtorzenia: string;
  ciezar_kg?: number | null;
  rpe?: number | null;
  przerwa_s?: number | null;
  uwagi?: string;
}

/** Generuje plan na tydzień zaczynający się w `ws` (poniedziałek). Dla bieżącego tygodnia planuje od dziś. */
export async function generatePlan(ws: string, uwagi = "", { notifyDiscord = true } = {}) {
  const today = todayPL();
  const we = addDays(ws, 6);
  if (we < today) throw new Error("Ten tydzień już minął");
  const from = ws > today ? ws : today;
  const s = await getSettings();
  const ctx = await buildContext({ days: 35 });

  const existing = await prisma.plan.findUnique({ where: { weekStart: ws }, include: { workouts: true } });
  const keep = existing?.workouts.filter((w) => w.date < from) ?? [];

  const dni = [];
  for (let d = from; d <= we; d = addDays(d, 1)) dni.push(`${d} (${weekdayLong(d)})`);

  const res = await askClaude({
    system: SYSTEM + "\n\n" + INTERVALS_SYNTAX + "\n\n# Dane Macieja\n" + ctx,
    maxTokens: 16000,
    tool: PLAN_TOOL,
    messages: [
      {
        role: "user",
        content: `Ułóż plan treningowy na dni: ${dni.join(", ")}.
Liczba sesji w pełnym tygodniu — trzymaj się DOKŁADNIE, niczego nie dokładaj: siłownia ${s.gymPerWeek}× (każda = "Bieżnia" + "Siłownia" tego samego dnia), basen ${s.swimPerWeek}×, osobne biegi ${s.runPerWeek}× (w tym długie wybieganie w dzień: ${s.longRunDay}). Jeśli planujesz tylko część tygodnia (od dziś), zaplanuj proporcjonalnie mniej i uwzględnij to, co już było zaplanowane.
Dostępne dni treningowe: ${s.trainingDays}. Siłownie rozłóż z co najmniej jednym dniem przerwy między nimi.
${keep.length ? `Wcześniej w tym tygodniu było zaplanowane: ${keep.map((k) => `${k.date} ${k.sport} ${k.title}`).join("; ")}.` : ""}
${uwagi ? `Uwagi Macieja do tego planu: ${uwagi}` : ""}
Zasady zapisu:
- Każdy dzień siłowni zapisz jako DWIE sesje tego samego dnia, w tej kolejności: najpierw "Bieg" z tytułem zaczynającym się od "Bieżnia" (ok. 30 min, z kroki_intervals), potem "Siłownia" (FBW wg zasad: podciąganie → armwrestling → nogi pod bieganie → pchanie/core).
- Dla siłowni podaj konkretne ciężary w kg wyliczone z dotychczasowych wyników (jeśli brak danych — RPE i ciężar null). Ćwiczenia z masą ciała (podciąganie, pompki, dipy): ciezar_kg = null, a przy podciąganiu z obciążeniem — tylko ciężar DODATKOWY w kg. Używaj nazw ćwiczeń z katalogu w danych (np. "Podciąganie nachwytem", "Pronacja z młotkiem / hantlem z jednej strony"), żeby historia się łączyła.
- Dla biegów podaj tempa absolutne dopasowane do aktualnej formy z danych.
- Dni bez treningu pomiń albo wpisz jako "Odpoczynek".`,
      },
    ],
  });
  const input = res.toolInput as PlanInput;
  const sesje = (input?.sesje ?? []).filter((x) => x.data >= from && x.data <= we && (PLAN_SPORTS as readonly string[]).includes(x.sport));
  if (!sesje.length) throw new Error("AI nie zwróciło żadnej sesji w zadanym zakresie dat");

  // usuń z kalendarza intervals.icu stare wydarzenia z nadpisywanych dni
  if (existing && intervalsConfigured()) {
    for (const w of existing.workouts) {
      if (w.date >= from && w.intervalsEventId) await deleteEvent(w.intervalsEventId).catch((e) => console.error("[plan] usuwanie eventu", e));
    }
  }

  const plan = await prisma.$transaction(async (tx) => {
    if (existing) await tx.plan.delete({ where: { id: existing.id } });
    return tx.plan.create({
      data: {
        weekStart: ws,
        summary: input.podsumowanie ?? "",
        raw: JSON.stringify(input),
        workouts: {
          create: [
            ...keep.map((k) => ({
              date: k.date,
              sport: k.sport,
              title: k.title,
              description: k.description,
              durationMin: k.durationMin,
              intervalsText: k.intervalsText,
              strength: k.strength,
              intervalsEventId: k.intervalsEventId,
            })),
            ...sesje
              .sort((a, b) => a.data.localeCompare(b.data))
              .map((x) => ({
                date: x.data,
                sport: x.sport,
                title: x.tytul,
                description: x.opis,
                durationMin: x.czas_min || null,
                intervalsText: x.kroki_intervals?.trim() || null,
                strength: x.cwiczenia?.length ? JSON.stringify(x.cwiczenia) : null,
              })),
          ],
        },
      },
      include: { workouts: { orderBy: { date: "asc" } } },
    });
  });

  // sesje siłowe podpięte pod przeniesione (minione) pozycje planu — przepnij na nowe id
  for (const k of keep) {
    const nowa = plan.workouts.find((w) => w.date === k.date && w.title === k.title && w.sport === k.sport);
    if (nowa) await prisma.strengthSession.updateMany({ where: { plannedId: k.id }, data: { plannedId: nowa.id } });
  }

  const pushInfo = await pushPlan(plan.id, from).catch((e) => {
    console.error("[plan] wysyłka do intervals.icu", e);
    return `⚠️ Nie udało się wysłać do intervals.icu: ${String(e.message ?? e).slice(0, 150)}`;
  });

  if (notifyDiscord) {
    const lines = plan.workouts
      .filter((w) => w.date >= from && w.sport !== "Odpoczynek")
      .map((w) => `${PLAN_ICON[w.sport] ?? "•"} **${fmtDate(w.date)}** ${w.title}${w.durationMin ? ` (${w.durationMin} min)` : ""}`);
    await notify(
      { title: `📋 Plan na tydzień od ${fmtDate(ws)}`, description: `${plan.summary}\n\n${lines.join("\n")}${pushInfo ? `\n\n${pushInfo}` : ""}`, color: COLOR.plan, path: "/plan" },
      true,
    );
  }
  return plan;
}

/** Wysyła sesje wytrzymałościowe (z krokami) do kalendarza intervals.icu -> Huawei Health -> zegarek */
async function pushPlan(planId: number, from: string): Promise<string> {
  const s = await getSettings();
  if (s.pushToIntervals === "none" || !intervalsConfigured()) return "";
  const allowed: PlanSport[] = s.pushToIntervals === "endurance" ? ["Bieg", "Rower", "Basen"] : ["Bieg"];
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId }, include: { workouts: true } });
  const todo = plan.workouts.filter((w) => w.date >= from && !w.intervalsEventId && allowed.includes(w.sport as PlanSport));
  if (!todo.length) return "";
  const events = todo.map((w) => ({
    uid: `trener-${w.id}`,
    date: w.date,
    type: PLAN_TO_INTERVALS[w.sport as PlanSport] ?? "Workout",
    name: w.title,
    description: [w.description, w.intervalsText ?? ""].filter(Boolean).join("\n\n"),
    movingTimeSec: w.durationMin ? w.durationMin * 60 : undefined,
  }));
  const created = await createEvents(events);
  for (let i = 0; i < todo.length; i++) {
    const ev = created.find((c) => c.uid === events[i].uid) ?? created[i];
    if (ev?.id != null) await prisma.plannedWorkout.update({ where: { id: todo[i].id }, data: { intervalsEventId: String(ev.id) } });
  }
  return `📲 ${todo.length} ${todo.length === 1 ? "trening wysłany" : "treningi wysłane"} do intervals.icu (zegarek: Trening → Bieg na zewnątrz → Kursy → Własne kursy).`;
}

// ---------------------------------------------------------------- czat
export async function chat(userText: string) {
  const historia = await prisma.chatMessage.findMany({ orderBy: { id: "desc" }, take: 20 });
  const msgs: Msg[] = historia.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  // API wymaga naprzemienności zaczynając od user — przytnij ewentualny początek od assistant
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  msgs.push({ role: "user", content: userText });
  await prisma.chatMessage.create({ data: { role: "user", content: userText } });

  const ctx = await buildContext({ days: 28 });
  try {
    const { text } = await askClaude({
      system:
        SYSTEM +
        "\n\nRozmawiasz z Maciejem w czacie appki treningowej. Odpowiadaj zwięźle (zwykle do 200 słów), w markdownie. Jeśli prosi o zmianę planu, opisz zmianę i przypomnij, że może kliknąć „Przebuduj plan” z uwagami w zakładce Plan." +
        "\n\n# Dane Macieja\n" +
        ctx,
      maxTokens: 4000,
      messages: msgs,
    });
    await prisma.chatMessage.create({ data: { role: "assistant", content: text } });
    return text;
  } catch (e) {
    // nie zostawiaj w historii pytania bez odpowiedzi (psułoby naprzemienność ról)
    const last = await prisma.chatMessage.findFirst({ orderBy: { id: "desc" } });
    if (last?.role === "user") await prisma.chatMessage.delete({ where: { id: last.id } });
    throw e;
  }
}

/** Ćwiczenia sesji siłowej z planu (dla przycisku „Rozpocznij z planu”) */
export function parseStrength(json: string | null): StrengthItem[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

