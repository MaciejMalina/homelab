// Typy aktywności intervals.icu -> polskie nazwy i grupy

export type Group = "run" | "ride" | "swim" | "strength" | "other";

export function sportGroup(type: string): Group {
  const t = type.toLowerCase();
  if (t.includes("run")) return "run";
  if (t.includes("ride") || t.includes("cycl") || t.includes("bike")) return "ride";
  if (t.includes("swim")) return "swim";
  if (t.includes("weight") || t.includes("strength") || t === "crossfit") return "strength";
  return "other";
}

const NAZWY: Record<string, string> = {
  Run: "Bieg",
  TrailRun: "Bieg w terenie",
  VirtualRun: "Bieżnia",
  Ride: "Rower",
  VirtualRide: "Rower stacjonarny",
  MountainBikeRide: "Rower MTB",
  GravelRide: "Rower gravel",
  Swim: "Basen",
  OpenWaterSwim: "Wody otwarte",
  WeightTraining: "Siłownia",
  Walk: "Spacer",
  Hike: "Wędrówka",
  Workout: "Trening",
  Yoga: "Joga",
};

export const sportName = (type: string) => NAZWY[type] ?? type;

export const ICON: Record<Group, string> = {
  run: "🏃",
  ride: "🚴",
  swim: "🏊",
  strength: "🏋️",
  other: "⚡",
};

/** Sporty, które AI może wpisać do planu */
export const PLAN_SPORTS = ["Bieg", "Rower", "Basen", "Siłownia", "Mobilność", "Odpoczynek"] as const;
export type PlanSport = (typeof PLAN_SPORTS)[number];

/** Sport z planu -> typ eventu w intervals.icu */
export const PLAN_TO_INTERVALS: Partial<Record<PlanSport, string>> = {
  Bieg: "Run",
  Rower: "Ride",
  Basen: "Swim",
  Siłownia: "WeightTraining",
};

export const PLAN_ICON: Record<string, string> = {
  Bieg: "🏃",
  Rower: "🚴",
  Basen: "🏊",
  Siłownia: "🏋️",
  Mobilność: "🧘",
  Odpoczynek: "😴",
};
