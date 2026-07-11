const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  classifyPrice,
  filterDealsByPostedWindow,
  formatDelta,
  formatDiscount,
  formatPostTime,
  getPostTimeMs,
  getDealCondition,
  renderDealStamp,
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
assert.deepStrictEqual(classifyPrice("$56"), { kind: "price", label: "Price", value: "$56" });
assert.deepStrictEqual(classifyPrice("from $10.20"), {
  kind: "price",
  label: "Price",
  value: "from $10.20",
});
assert.deepStrictEqual(classifyPrice("5 for $15"), {
  kind: "price",
  label: "Price",
  value: "5 for $15",
});
assert.deepStrictEqual(classifyPrice("Extra 10% Off"), {
  kind: "offer",
  label: "Offer",
  value: "Extra 10% Off",
});
assert.deepStrictEqual(classifyPrice("Free w/ $30+ Purchase"), {
  kind: "offer",
  label: "Offer",
  value: "Free w/ $30+ Purchase",
});
assert.deepStrictEqual(classifyPrice(""), {
  kind: "missing",
  label: "Price",
  value: "See deal",
});
assert.strictEqual(
  getDealCondition({ title: "Prime Members: Wireless Mouse", price: "$28" }),
  "Prime Members",
);
assert.strictEqual(
  getDealCondition({
    title: "Harbor Freight 3-Days In-Stores Only: Bucket Offer",
    price: "Free w/ $30+ Purchase",
  }),
  "Harbor Freight 3-Days In-Stores Only; Requires $30+ purchase",
);
assert.strictEqual(
  getDealCondition({ title: "Wireless Mouse w/ Light", price: "$28" }),
  "",
);
assert.strictEqual(
  getDealCondition({ title: "Select Home Depot Stores: 52-Pc Tool Kit", price: "$11" }),
  "Select Home Depot Stores",
);
assert.strictEqual(
  renderVelocityStamp("inferno"),
  '<span class="badge-stamp badge-inferno" aria-label="Inferno velocity">&#x1F525;&#x1F525; INFERNO</span>',
);
assert.strictEqual(
  renderVelocityStamp("on fire"),
  '<span class="badge-stamp badge-on-fire" aria-label="On fire velocity">&#x1F525; ON FIRE</span>',
);
assert.strictEqual(
  renderVelocityStamp("blazing"),
  '<span class="badge-stamp badge-blazing">BLAZING</span>',
);
assert.strictEqual(
  renderVelocityStamp("surging"),
  '<span class="badge-stamp badge-surging">SURGING</span>',
);
assert.strictEqual(
  renderVelocityStamp("hot"),
  '<span class="badge-stamp badge-hot">HOT</span>',
);
assert.strictEqual(
  renderVelocityStamp("warming"),
  '<span class="badge-stamp badge-warming">WARMING</span>',
);
assert.strictEqual(renderVelocityStamp("needs second scrape"), "");
assert.strictEqual(
  renderDealStamp({ vote_delta: 5, velocity_label: "inferno" }),
  '<span class="badge-stamp badge-inferno" aria-label="Inferno velocity">&#x1F525;&#x1F525; INFERNO</span>',
);
assert.strictEqual(
  renderDealStamp({ vote_delta: 4, velocity_label: "surging" }),
  '<span class="badge-stamp badge-surging">SURGING</span>',
);
assert.strictEqual(
  renderDealStamp({ vote_delta: null, velocity_label: "warming" }),
  '<span class="badge-stamp badge-warming">WARMING</span>',
);

assert.ok(renderTallyDelta({ vote_delta: 2 }).includes("+2 tallies since last count"));
assert.ok(renderTallyDelta({ vote_delta: 2 }).includes("+2 since last count"));
assert.ok(renderTallyDelta({ vote_delta: 2 }).includes('aria-label="+2 tallies since last count"'));
assert.ok(renderTallyDelta({ vote_delta: 2, recent_velocity: 12.06 }).includes("/hr") === false);
assert.ok(renderTallyDelta({ vote_delta: null }).includes("pending next count"));

const browserSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
assert.ok(!browserSource.includes("?."), "TV browser bundle must not use optional chaining");
assert.ok(!browserSource.includes("??"), "TV browser bundle must not use nullish coalescing");
assert.ok(!/\d_\d/.test(browserSource), "TV browser bundle must not use numeric separators");

const workerSource = fs.readFileSync(path.join(__dirname, "../public/service-worker.js"), "utf8");
assert.ok(workerSource.includes('self.addEventListener("push"'));
assert.ok(workerSource.includes('self.addEventListener("notificationclick"'));
assert.ok(workerSource.includes("clients.openWindow(url)"));

const notificationsSource = fs.readFileSync(path.join(__dirname, "../public/notifications.js"), "utf8");
assert.ok(notificationsSource.includes("Notification.requestPermission()"));
assert.ok(notificationsSource.includes("applicationServerKey"));
assert.ok(notificationsSource.includes("Select at least one stamp first."));

console.log("app helper tests passed");
