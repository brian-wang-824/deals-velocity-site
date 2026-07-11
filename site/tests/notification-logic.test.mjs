import assert from "node:assert/strict";
import {
  ALLOWED_THRESHOLDS,
  enteredHigherStamp,
  normalizeThresholds,
} from "../../supabase/functions/notifications/logic.mjs";

assert.deepEqual(ALLOWED_THRESHOLDS, ["warming", "hot", "surging", "blazing", "on fire", "inferno"]);
assert.deepEqual(normalizeThresholds(["inferno", "bogus", "warming", "inferno"]), ["warming", "inferno"]);
assert.deepEqual(normalizeThresholds(null), []);

assert.equal(enteredHigherStamp(undefined, "warming"), false, "first observation is not retroactive");
assert.equal(enteredHigherStamp("slow", "warming"), true);
assert.equal(enteredHigherStamp("warming", "hot"), true);
assert.equal(enteredHigherStamp("warming", "inferno"), true, "skips notify only the observed stamp");
assert.equal(enteredHigherStamp("hot", "hot"), false);
assert.equal(enteredHigherStamp("inferno", "hot"), false, "downward movement does not notify");
assert.equal(enteredHigherStamp("hot", "flat"), false);

console.log("notification logic tests passed");
