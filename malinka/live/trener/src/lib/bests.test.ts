import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNum, fmtNum } from "./numfmt.ts";
import { bestOf, describeBest, recordsBroken } from "./bests.ts";
import { fmtSet, fmtPlanTarget, hasResult } from "./kinds.ts";

test("pole liczbowe: przecinek i czas", () => {
  assert.equal(parseNum("7,5", "decimal"), 7.5);
  assert.equal(parseNum("7,", "decimal"), 7); // w trakcie pisania — tekst zostaje „7,”
  assert.equal(parseNum("12.25", "decimal"), 12.25);
  assert.equal(parseNum("", "decimal"), null);
  assert.equal(parseNum("abc", "decimal"), undefined);
  assert.equal(parseNum("8", "int"), 8);
  assert.equal(parseNum("13,5", "int"), undefined); // powtórzenia tylko całe
  assert.equal(parseNum("10,", "int"), 10);
  assert.equal(parseNum("1:30", "time"), 90);
  assert.equal(parseNum("45", "time"), 45);
  assert.equal(parseNum("1:", "time"), undefined);
  assert.equal(fmtNum(7.5, "decimal"), "7,5");
  assert.equal(fmtNum(90, "time"), "1:30");
  assert.equal(fmtNum(45, "time"), "45");
});

test("formatowanie serii wg typu", () => {
  assert.equal(fmtSet("weight_reps", { weight: 7.5, reps: 12 }), "7,5 kg × 12");
  assert.equal(fmtSet("bodyweight", { weight: null, reps: 10 }), "10 powt.");
  assert.equal(fmtSet("bodyweight", { weight: 10, reps: 5 }), "+10 kg × 5");
  assert.equal(fmtSet("time", { weight: null, reps: null, seconds: 75 }), "1:15");
  assert.equal(fmtSet("time", { weight: null, reps: null, seconds: 45 }), "45 s");
  assert.equal(fmtSet("distance", { weight: 32, reps: null, meters: 40 }), "32 kg · 40 m");
  assert.ok(hasResult("time", { weight: null, reps: null, seconds: 30 }));
  assert.ok(!hasResult("time", { weight: null, reps: 10 }));
  assert.equal(fmtPlanTarget({ serie: 3, czas_s: 45 }), "3×45 s");
  assert.equal(fmtPlanTarget({ serie: 3, dystans_m: 40, ciezar_kg: 32 }), "3×40 m @ 32 kg");
  assert.equal(fmtPlanTarget({ serie: 4, powtorzenia: "6", ciezar_kg: 7.5, rpe: 8 }), "4×6 @ 7,5 kg RPE 8");
});

test("rekordy wg typu", () => {
  const plankPrzed = bestOf("time", [{ weight: null, reps: null, seconds: 60 }]);
  const plankTeraz = bestOf("time", [{ weight: null, reps: null, seconds: 75 }, { weight: null, reps: null, seconds: 300, warmup: true }]);
  assert.equal(plankTeraz.seconds, 75); // rozgrzewka się nie liczy
  assert.deepEqual(recordsBroken("Plank", plankTeraz, plankPrzed), ["Plank: 1:15 (było 1:00)"]);
  const pull = bestOf("bodyweight", [{ weight: null, reps: 11 }, { weight: 5, reps: 6 }]);
  assert.equal(describeBest(pull), "11 powt.; +5 kg × 6");
  const sztanga = bestOf("weight_reps", [{ weight: 80, reps: 5 }]);
  assert.equal(describeBest(sztanga), "szac. 1RM 93,3 kg (80 kg × 5)");
  assert.deepEqual(recordsBroken("X", sztanga, bestOf("weight_reps", [])), []); // brak historii = brak „rekordu”
});
