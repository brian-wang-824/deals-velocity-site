const assert = require("assert");

const { formatPostTime, getPostTimeMs, sortDealsByNewest } = require("../public/app.js");

const newestSorted = sortDealsByNewest([
  { thread_id: "missing" },
  { thread_id: "older", posted_time: "2026-07-05T17:04:00Z" },
  { thread_id: "newest", posted_time: "2026-07-05T19:41:00Z" },
  { thread_id: "invalid", posted_time: "not-a-date" },
  { thread_id: "same-time", posted_time: "2026-07-05T17:04:00Z" },
]);

assert.deepStrictEqual(
  newestSorted.map((deal) => deal.thread_id),
  ["newest", "older", "same-time", "missing", "invalid"],
);

assert.strictEqual(getPostTimeMs(null), Number.NEGATIVE_INFINITY);
assert.strictEqual(getPostTimeMs("not-a-date"), Number.NEGATIVE_INFINITY);
assert.strictEqual(getPostTimeMs("2026-07-05T19:41:00Z"), Date.parse("2026-07-05T19:41:00Z"));

assert.strictEqual(formatPostTime(null), "unknown");
assert.notStrictEqual(formatPostTime("2026-07-05T19:41:00Z"), "unknown");

console.log("app helper tests passed");
