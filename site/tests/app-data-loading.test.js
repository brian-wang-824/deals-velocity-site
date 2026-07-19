const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const {
  buildSnapshotUrl,
  createPublishedDealsLoader,
  normalizeDataConfig,
  normalizePublication,
  normalizeSnapshot,
} = require("../public/app.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function queueFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (!responses.length) throw new Error(`Unexpected request to ${url}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

function publication(version, snapshotPath, scrapedAt, dealCount) {
  return [{
    version,
    snapshot_path: snapshotPath,
    scraped_at: scrapedAt,
    deal_count: dealCount,
  }];
}

const VERSION_ONE = "a".repeat(64);
const VERSION_TWO = "b".repeat(64);
const VERSION_THREE = "c".repeat(64);
const VERSION_FOUR = "d".repeat(64);
const STALE_VERSION = "e".repeat(64);
const BROWSER_VERSION_ONE = "f".repeat(64);
const BROWSER_VERSION_TWO = "1".repeat(64);
const snapshotPath = (version) => `v1/2026/07/18/${version}.json`;

const config = {
  publicationUrl: "https://project.supabase.co/rest/v1/deal_data_publications?select=version%2Csnapshot_path%2Cscraped_at%2Cdeal_count&order=scraped_at.desc&limit=1",
  snapshotBaseUrl: "https://project.supabase.co/storage/v1/object/public/deal-snapshots/",
  publishableKey: "sb_publishable_test",
};

async function testPublicationLifecycle() {
  const firstTime = "2026-07-18T18:20:00Z";
  const secondTime = "2026-07-18T18:30:00Z";
  const firstPath = snapshotPath(VERSION_ONE);
  const secondPath = snapshotPath(VERSION_TWO);
  const requests = queueFetch([
    jsonResponse(publication(VERSION_ONE, firstPath, "2026-07-18T18:20:00+00:00", 1)),
    jsonResponse({ scraped_at: firstTime, deals: [{ thread_id: "1", vote_delta: 1 }], count: 1 }),
    jsonResponse(publication(VERSION_ONE, firstPath, firstTime, 1)),
    jsonResponse(publication(VERSION_TWO, secondPath, secondTime, 1)),
    jsonResponse({ scraped_at: secondTime, deals: [{ thread_id: "1", vote_delta: 5 }], count: 1 }),
    jsonResponse(publication(STALE_VERSION, snapshotPath(STALE_VERSION), firstTime, 1)),
  ]);
  const applied = [];
  const loader = createPublishedDealsLoader({
    config,
    fetchImpl: requests.fetchImpl,
    onSnapshot: (snapshot) => applied.push(snapshot),
  });

  const firstResult = await loader.load();
  assert.deepStrictEqual(firstResult, { updated: true, version: VERSION_ONE });
  assert.strictEqual(loader.getCurrentVersion(), VERSION_ONE);
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].deals[0].vote_delta, 1);
  assert.strictEqual(requests.calls[0].url, config.publicationUrl);
  assert.strictEqual(requests.calls[0].options.cache, "no-store");
  assert.strictEqual(requests.calls[0].options.headers.apikey, config.publishableKey);
  assert.strictEqual(
    requests.calls[1].url,
    `https://project.supabase.co/storage/v1/object/public/deal-snapshots/v1/2026/07/18/${VERSION_ONE}.json`,
  );
  assert.strictEqual(requests.calls[1].options.cache, "force-cache");

  const unchangedResult = await loader.load();
  assert.deepStrictEqual(unchangedResult, { updated: false, version: VERSION_ONE });
  assert.strictEqual(requests.calls.length, 3, "unchanged versions must not fetch a snapshot");
  assert.strictEqual(applied.length, 1, "unchanged versions must not rerender");

  const refreshedResult = await loader.load();
  assert.deepStrictEqual(refreshedResult, { updated: true, version: VERSION_TWO });
  assert.strictEqual(applied.length, 2);
  assert.strictEqual(applied[1].deals[0].vote_delta, 5);
  assert.strictEqual(loader.getCurrentVersion(), VERSION_TWO);

  const staleResult = await loader.load();
  assert.deepStrictEqual(staleResult, { updated: false, version: VERSION_TWO, superseded: true });
  assert.strictEqual(requests.calls.length, 6, "an older pointer must not fetch or replace data");
  assert.strictEqual(applied.length, 2);
}

async function testInvalidSnapshotRetriesSameVersion() {
  const scrapedAt = "2026-07-18T18:40:00Z";
  const pointer = publication(VERSION_THREE, snapshotPath(VERSION_THREE), scrapedAt, 1);
  const requests = queueFetch([
    jsonResponse(pointer),
    jsonResponse({ scraped_at: scrapedAt, deals: "not-an-array", count: 1 }),
    jsonResponse(pointer),
    jsonResponse({ scraped_at: scrapedAt, deals: [{ thread_id: "3" }], count: 1 }),
  ]);
  const applied = [];
  const loader = createPublishedDealsLoader({
    config,
    fetchImpl: requests.fetchImpl,
    onSnapshot: (snapshot) => applied.push(snapshot),
  });

  await assert.rejects(loader.load(), /snapshot is invalid/);
  assert.strictEqual(loader.getCurrentVersion(), null, "failed snapshots must not advance the version");
  assert.strictEqual(applied.length, 0);

  const result = await loader.load();
  assert.deepStrictEqual(result, { updated: true, version: VERSION_THREE });
  assert.strictEqual(applied.length, 1, "the same pointer must be retryable after failure");
}

async function testConcurrentLoadsShareRequest() {
  const scrapedAt = "2026-07-18T18:50:00Z";
  let releasePublication;
  const publicationResponse = new Promise((resolve) => {
    releasePublication = resolve;
  });
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return publicationResponse;
    return Promise.resolve(jsonResponse({ scraped_at: scrapedAt, deals: [], count: 0 }));
  };
  const loader = createPublishedDealsLoader({
    config,
    fetchImpl,
    onSnapshot: () => {},
  });

  const first = loader.load();
  const second = loader.load();
  assert.strictEqual(first, second, "overlapping polls must share one in-flight load");
  assert.strictEqual(calls.length, 1);

  releasePublication(jsonResponse(publication(
    VERSION_FOUR,
    snapshotPath(VERSION_FOUR),
    scrapedAt,
    0,
  )));
  await first;
  assert.strictEqual(calls.length, 2);
}

function browserElement(id, initialValue) {
  const listeners = {};
  let html = "";
  const element = {
    id,
    value: initialValue || "",
    textContent: "",
    attributes: {},
    buttons: [],
    addEventListener: (event, listener) => {
      listeners[event] = listener;
    },
    emit: (event) => listeners[event] && listeners[event](),
    setAttribute: (name, value) => {
      element.attributes[name] = value;
    },
    querySelector: () => null,
    querySelectorAll: () => element.buttons.filter((button) => !button.disabled),
  };

  Object.defineProperty(element, "innerHTML", {
    get: () => html,
    set: (value) => {
      html = value;
      element.buttons = [];
      if (id !== "pagination") return;

      const buttonPattern = /<button\s+([^>]*)>/g;
      let match;
      while ((match = buttonPattern.exec(value))) {
        const attributes = match[1];
        const pageMatch = attributes.match(/data-page="([^"]+)"/);
        if (!pageMatch) continue;
        const buttonListeners = {};
        element.buttons.push({
          dataset: { page: pageMatch[1] },
          disabled: /\bdisabled\b/.test(attributes),
          addEventListener: (event, listener) => {
            buttonListeners[event] = listener;
          },
          emit: (event) => buttonListeners[event] && buttonListeners[event](),
        });
      }
    },
  });
  return element;
}

function browserDeal(index, postedAt, velocityLabel, voteDelta) {
  return {
    thread_id: String(index),
    title: `Alpha deal ${index}`,
    store: "Example store",
    url: `https://example.test/deal/${index}`,
    image_url: "https://example.test/image.png",
    price: "$10",
    original_price: "$20",
    discount_percentage: 50,
    posted_time: postedAt,
    votes: 100 - index,
    vote_delta: voteDelta,
    velocity_label: velocityLabel,
  };
}

async function testBrowserRefreshPreservesControlsAndPage() {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const firstTime = new Date(Date.now() - 60 * 1000).toISOString();
  const secondTime = new Date(Date.parse(firstTime) + 10 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const firstDeals = Array.from({ length: 30 }, (_value, index) => (
    browserDeal(index + 1, postedAt, "warming", 1)
  ));
  const secondDeals = Array.from({ length: 26 }, (_value, index) => (
    browserDeal(
      index + 1,
      postedAt,
      index === 25 ? "inferno" : "warming",
      index === 25 ? 9 : 1,
    )
  ));
  const browserResponses = [
    jsonResponse(publication(
      BROWSER_VERSION_ONE,
      snapshotPath(BROWSER_VERSION_ONE),
      firstTime,
      firstDeals.length,
    )),
    jsonResponse({ scraped_at: firstTime, deals: firstDeals, count: firstDeals.length }),
    jsonResponse(publication(
      BROWSER_VERSION_TWO,
      snapshotPath(BROWSER_VERSION_TWO),
      secondTime,
      secondDeals.length,
    )),
    jsonResponse({ scraped_at: secondTime, deals: secondDeals, count: secondDeals.length }),
  ];
  const requests = queueFetch(browserResponses);
  const elements = {
    search: browserElement("search"),
    sort: browserElement("sort", "velocity"),
    "posted-window": browserElement("posted-window", "12h"),
    "deals-list": browserElement("deals-list"),
    pagination: browserElement("pagination"),
    "results-meta": browserElement("results-meta"),
    "last-updated": browserElement("last-updated"),
    "next-refresh": browserElement("next-refresh"),
  };
  const timers = [];
  const document = {
    getElementById: (id) => elements[id],
    createElement: () => {
      const value = { innerHTML: "" };
      Object.defineProperty(value, "textContent", {
        set: (text) => {
          value.innerHTML = String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        },
      });
      return value;
    },
  };
  const context = {
    console: { error: () => {} },
    Date,
    document,
    fetch: requests.fetchImpl,
    Intl,
    module: { exports: {} },
    setInterval: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearInterval: () => {},
    window: {
      DATA_CONFIG: config,
      matchMedia: () => ({ matches: true }),
      scrollTo: () => {},
    },
  };

  vm.runInNewContext(source, context, { filename: "app.js" });
  await new Promise((resolve) => setImmediate(resolve));

  elements.search.value = "Alpha";
  elements.search.emit("input");
  elements["posted-window"].value = "24h";
  elements["posted-window"].emit("change");
  const pageTwo = elements.pagination.buttons.find((button) => button.dataset.page === "2");
  assert.ok(pageTwo, "the initial filtered result must have a second page");
  pageTwo.emit("click");
  assert.strictEqual(elements["results-meta"].textContent, "Showing 26-30 of 30 tickets");

  const pollTimer = timers.find((timer) => timer.delay === 60000);
  assert.ok(pollTimer, "the browser must poll the publication pointer every minute");
  await pollTimer.callback();

  assert.strictEqual(elements.search.value, "Alpha");
  assert.strictEqual(elements.sort.value, "velocity");
  assert.strictEqual(elements["posted-window"].value, "24h");
  assert.strictEqual(
    elements["results-meta"].textContent,
    "Showing 26-26 of 26 tickets",
    "a refresh should retain page two while clamping it to the refreshed result set",
  );
  assert.ok(elements["deals-list"].innerHTML.includes("INFERNO"));
  assert.ok(elements["deals-list"].innerHTML.includes("+9 tallies since last count"));

  const renderedAfterRefresh = elements["deals-list"].innerHTML;
  browserResponses.push(jsonResponse({ error: "temporary outage" }, 503));
  await pollTimer.callback();
  assert.strictEqual(
    elements["deals-list"].innerHTML,
    renderedAfterRefresh,
    "a silent pointer failure must retain the last valid cards",
  );
}

function testValidationHelpers() {
  assert.deepStrictEqual(normalizeDataConfig(config), config);
  assert.throws(() => normalizeDataConfig({}), /not configured/);
  assert.throws(() => normalizePublication([]), /unavailable/);
  assert.throws(
    () => normalizePublication(publication(
      VERSION_ONE.toUpperCase(),
      snapshotPath(VERSION_ONE),
      "2026-07-18T18:00:00Z",
      0,
    )),
    /publication is invalid/,
  );
  assert.throws(
    () => normalizePublication(publication(
      VERSION_ONE,
      snapshotPath(VERSION_TWO),
      "2026-07-18T18:00:00Z",
      0,
    )),
    /publication is invalid/,
  );
  assert.throws(
    () => normalizePublication(publication(
      VERSION_ONE,
      `snapshots/${VERSION_ONE}.json`,
      "2026-07-18T18:00:00Z",
      0,
    )),
    /publication is invalid/,
  );
  assert.throws(
    () => normalizePublication(publication(
      VERSION_ONE,
      snapshotPath(VERSION_ONE),
      "2026-07-18T18:00:00Z",
      -1,
    )),
    /publication is invalid/,
  );
  const validPublication = normalizePublication(publication(
    VERSION_ONE,
    snapshotPath(VERSION_ONE),
    "2026-07-18T18:00:00Z",
    1,
  ));
  assert.throws(
    () => normalizeSnapshot(
      { scraped_at: "2026-07-18T18:01:00Z", deals: [], count: 0 },
      validPublication,
    ),
    /does not match/,
  );
  assert.throws(
    () => normalizeSnapshot(
      { scraped_at: "2026-07-18T18:00:00Z", deals: [{}], count: 0 },
      validPublication,
    ),
    /does not match/,
  );
  assert.throws(
    () => normalizeSnapshot(
      { scraped_at: "2026-07-18T18:00:00Z", deals: [{}], count: 2 },
      validPublication,
    ),
    /does not match/,
  );
  assert.throws(
    () => normalizeSnapshot(
      { scraped_at: "2026-07-18T18:00:00Z", deals: [{}], count: 1.5 },
      validPublication,
    ),
    /snapshot is invalid/,
  );
  assert.strictEqual(
    buildSnapshotUrl("https://storage.test/root/", "snapshots/a b.json"),
    "https://storage.test/root/snapshots/a%20b.json",
  );
  assert.throws(
    () => buildSnapshotUrl("https://storage.test/root", "../private/history.json"),
    /path is invalid/,
  );
}

async function main() {
  testValidationHelpers();
  await testPublicationLifecycle();
  await testInvalidSnapshotRetriesSameVersion();
  await testConcurrentLoadsShareRequest();
  await testBrowserRefreshPreservesControlsAndPage();
  console.log("app data loading tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
