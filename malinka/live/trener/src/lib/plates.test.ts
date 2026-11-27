import { test } from "node:test";
import assert from "node:assert/strict";
import { platesFor } from "./plates.ts";
import { parseMuscles } from "./muscles.ts";

test("talerze: 100 kg na gryfie 20", () => {
  assert.deepEqual(platesFor(100).plates, [25, 15]);
});
test("talerze: 62,5 kg", () => {
  const r = platesFor(62.5);
  assert.deepEqual(r.plates, [20, 1.25]);
  assert.equal(r.rest, 0);
  assert.equal(r.real, 62.5);
});
test("talerze: ciężar niemożliwy do złożenia", () => {
  const r = platesFor(21);
  assert.deepEqual(r.plates, []);
  assert.equal(r.rest, 0.5);
});
test("talerze: lżej niż gryf", () => {
  assert.deepEqual(platesFor(15).plates, []);
});
test("mięśnie: główne i pomocnicze, kategoria jako zapas", () => {
  assert.deepEqual(parseMuscles("najszersze, (biceps), (środek pleców)"), [["najszersze", 1], ["biceps", 0.5], ["środek pleców", 0.5]]);
  assert.deepEqual(parseMuscles("", "Armwrestling"), [["przedramiona", 1], ["biceps", 0.5]]);
  assert.deepEqual(parseMuscles("", "Inne"), []);
});
