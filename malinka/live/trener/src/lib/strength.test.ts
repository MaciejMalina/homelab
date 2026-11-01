import { test } from "node:test";
import assert from "node:assert/strict";
import { e1rm, riegel, bestHalfPrediction, HALF_M } from "./strength.ts";
import { addDays, weekStart, weekdayShort, fmtPace, fmtDuration, parseDuration, nowPL } from "./time.ts";

test("e1rm Epley", () => {
  assert.equal(e1rm(100, 1), 100);
  assert.equal(e1rm(80, 5), 93.3);
  assert.equal(e1rm(80, 13), null);
  assert.equal(e1rm(null, 5), null);
});

test("riegel: 10 km w 40:00 -> półmaraton ~1:28", () => {
  const s = riegel(2400, 10000, HALF_M);
  assert.ok(s > 5250 && s < 5350, String(s));
  const best = bestHalfPrediction([
    { id: "a", distance: 4000, movingTime: 900 },
    { id: "b", distance: 10000, movingTime: 2700 },
    { id: "c", distance: 10000, movingTime: 2400 },
  ]);
  assert.equal(best?.id, "c");
});

test("daty", () => {
  assert.equal(addDays("2026-10-25", 1), "2026-10-26");
  assert.equal(addDays("2026-03-28", 2), "2026-03-30"); // przez zmianę czasu
  assert.equal(weekStart("2026-10-25"), "2026-10-19"); // niedziela -> poniedziałek wcześniej
  assert.equal(weekStart("2026-10-26"), "2026-10-26");
  assert.equal(weekdayShort("2026-10-25"), "nd");
  assert.equal(fmtPace(256), "4:16/km");
  assert.equal(fmtDuration(5400), "1:30:00");
  assert.equal(parseDuration("1:29:59"), 5399);
  // 23:30 UTC 25.10 = 00:30 26.10 w Warszawie (CET)
  assert.equal(nowPL(new Date("2026-10-25T23:30:00Z")).date, "2026-10-26");
});
