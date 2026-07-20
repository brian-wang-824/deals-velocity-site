import assert from "node:assert/strict";
import {
  ALLOWED_THRESHOLDS,
  enteredHigherHeat,
  normalizeThresholds,
  PUSH_DELIVERY_OPTIONS,
} from "../../supabase/functions/notifications/logic.mjs";

assert.deepEqual(ALLOWED_THRESHOLDS, ["warming", "hot", "surging", "blazing", "on fire", "inferno"]);
assert.deepEqual(
  PUSH_DELIVERY_OPTIONS,
  { TTL: 24 * 60 * 60, urgency: "high" },
  "Android delivery requests immediate delivery and one-day retention for Doze",
);
assert.deepEqual(normalizeThresholds(["inferno", "bogus", "warming", "inferno"]), ["warming", "inferno"]);
assert.deepEqual(normalizeThresholds(null), []);

for (const threshold of ALLOWED_THRESHOLDS) {
  assert.equal(enteredHigherHeat(undefined, threshold), true, `first observation at ${threshold} notifies`);
}
assert.equal(enteredHigherHeat(undefined, null), false, "first observation without heat is silent");
assert.equal(enteredHigherHeat(null, "warming"), true);
assert.equal(enteredHigherHeat("warming", "hot"), true);
assert.equal(enteredHigherHeat("warming", "inferno"), true, "skips notify only the observed heat");
assert.equal(enteredHigherHeat("hot", "hot"), false);
assert.equal(enteredHigherHeat("inferno", "hot"), false, "downward movement does not notify");
assert.equal(enteredHigherHeat("hot", null), false);

console.log("notification logic tests passed");
