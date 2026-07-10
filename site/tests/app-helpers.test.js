const assert = require("assert");

const {
  filterDealsByPostedWindow,
  formatDelta,
  formatDiscount,
  formatPostTime,
  getPostTimeMs,
  renderTallyDelta,
  renderVelocityStamp,
  sortDealsByNewest,
} = require("../public/app.js");

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

const nowMs = Date.parse("2026-07-06T12:00:00Z");
const dealsByAge = [
  { thread_id: "fresh", posted_time: "2026-07-06T11:30:00Z" },
  { thread_id: "four-hours", posted_time: "2026-07-06T08:00:00Z" },
  { thread_id: "eight-hours", posted_time: "2026-07-06T04:00:00Z" },
  { thread_id: "eleven-hours", posted_time: "2026-07-06T01:00:00Z" },
  { thread_id: "one-day", posted_time: "2026-07-05T13:00:00Z" },
  { thread_id: "two-days", posted_time: "2026-07-04T12:00:00Z" },
  { thread_id: "eight-days", posted_time: "2026-06-28T12:00:00Z" },
  { thread_id: "future", posted_time: "2026-07-06T13:00:00Z" },
  { thread_id: "invalid", posted_time: "not-a-date" },
  { thread_id: "missing" },
];

assert.deepStrictEqual(
  filterDealsByPostedWindow(dealsByAge, "3h", nowMs).map((deal) => deal.thread_id),
  ["fresh"],
);

assert.deepStrictEqual(
  filterDealsByPostedWindow(dealsByAge, "6h", nowMs).map((deal) => deal.thread_id),
  ["fresh", "four-hours"],
);

assert.deepStrictEqual(
  filterDealsByPostedWindow(dealsByAge, "9h", nowMs).map((deal) => deal.thread_id),
  ["fresh", "four-hours", "eight-hours"],
);

assert.deepStrictEqual(
  filterDealsByPostedWindow(dealsByAge, "12h", nowMs).map((deal) => deal.thread_id),
  ["fresh", "four-hours", "eight-hours", "eleven-hours"],
);

assert.deepStrictEqual(
  filterDealsByPostedWindow(dealsByAge, "24h", nowMs).map((deal) => deal.thread_id),
  ["fresh", "four-hours", "eight-hours", "eleven-hours", "one-day"],
);

assert.deepStrictEqual(
  filterDealsByPostedWindow(dealsByAge, "unknown-window", nowMs).map((deal) => deal.thread_id),
  ["fresh", "four-hours", "eight-hours", "eleven-hours"],
);

assert.deepStrictEqual(
  filterDealsByPostedWindow(dealsByAge, undefined, nowMs).map((deal) => deal.thread_id),
  ["fresh", "four-hours", "eight-hours", "eleven-hours"],
);

assert.strictEqual(formatDiscount(49.4), "-49%");
assert.strictEqual(formatDiscount(null), "");
assert.strictEqual(formatDelta(2), "+2");
assert.strictEqual(formatDelta(-1), "-1");
assert.strictEqual(
  renderVelocityStamp("surging"),
  '<span class="badge-stamp badge-surging">SURGING</span>',
);
assert.strictEqual(
  renderVelocityStamp("hot"),
  '<span class="badge-stamp badge-hot">HOT</span>',
);
assert.strictEqual(renderVelocityStamp("warming"), "");
assert.strictEqual(renderVelocityStamp("needs second scrape"), "");

assert.ok(renderTallyDelta({ vote_delta: 2 }).includes("+2 tallies since last count"));
assert.ok(renderTallyDelta({ vote_delta: 2, recent_velocity: 12.06 }).includes("/hr") === false);
assert.ok(renderTallyDelta({ vote_delta: null }).includes("pending next count"));

console.log("app helper tests passed");
