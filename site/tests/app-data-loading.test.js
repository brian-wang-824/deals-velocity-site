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

function publishedDeal(overrides = {}) {
  return Object.assign({
    thread_id: "1",
    title: "Example deal",
    url: "https://slickdeals.net/f/1",
    store: "Example store",
    price: "$10",
    original_price: "$20",
    discount_percentage: 50,
    comments: 2,
    views: 100,
    posted_time: "2026-07-18T18:00:00Z",
    posted_time_source: "card",
    posted_label: "1 hour ago",
    found_by: "Example user",
    is_new: false,
    image_url: null,
    recent_velocity: 6,
    lifetime_velocity: 3,
    vote_delta: 1,
    velocity_label: "warming",
    votes: 10,
  }, overrides);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function manualTimers() {
  const timers = [];
  return {
    activeCount() {
      return timers.filter((timer) => timer.active).length;
    },
    setTimeout(callback, delay) {
      const timer = { active: true, callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.active = false;
    },
    fireNext() {
      const activeTimers = timers.filter((timer) => timer.active);
      assert.strictEqual(
        activeTimers.length,
        1,
        "exactly one active request timeout must be scheduled",
      );
      const [timer] = activeTimers;
      timer.active = false;
      timer.callback();
    },
  };
}

function testManualTimersRejectAmbiguousTimeouts() {
  const timers = manualTimers();
  const staleTimer = timers.setTimeout(() => {}, 1000);
  timers.setTimeout(() => {}, 1000);

  assert.strictEqual(timers.activeCount(), 2);
  assert.throws(() => timers.fireNext(), /exactly one active request timeout/);

  timers.clearTimeout(staleTimer);
  assert.strictEqual(timers.activeCount(), 1);
  timers.fireNext();
  assert.strictEqual(timers.activeCount(), 0);
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function testPublicationLifecycle() {
  const firstTime = "2026-07-18T18:20:00Z";
  const secondTime = "2026-07-18T18:30:00Z";
  const firstPath = snapshotPath(VERSION_ONE);
  const secondPath = snapshotPath(VERSION_TWO);
  const requests = queueFetch([
    jsonResponse(publication(VERSION_ONE, firstPath, "2026-07-18T18:20:00+00:00", 1)),
    jsonResponse({ scraped_at: firstTime, deals: [publishedDeal({ vote_delta: 1 })], count: 1 }),
    jsonResponse(publication(VERSION_ONE, firstPath, firstTime, 1)),
    jsonResponse(publication(VERSION_TWO, secondPath, secondTime, 1)),
    jsonResponse({ scraped_at: secondTime, deals: [publishedDeal({ vote_delta: 5 })], count: 1 }),
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
    jsonResponse({ scraped_at: scrapedAt, deals: [publishedDeal({ thread_id: "3" })], count: 1 }),
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

async function testPublicationTimeoutReleasesRequest() {
  const scrapedAt = "2026-07-18T19:00:00Z";
  const timers = manualTimers();
  const requests = queueFetch([
    new Promise(() => {}),
    jsonResponse(publication(VERSION_ONE, snapshotPath(VERSION_ONE), scrapedAt, 1)),
    jsonResponse({ scraped_at: scrapedAt, deals: [publishedDeal()], count: 1 }),
  ]);
  const applied = [];
  const loader = createPublishedDealsLoader({
    config,
    fetchImpl: requests.fetchImpl,
    onSnapshot: (snapshot) => applied.push(snapshot),
    requestTimeoutMs: 1000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  const timedOut = loader.load();
  assert.strictEqual(requests.calls.length, 1);
  assert.strictEqual(timers.activeCount(), 1, "the pending publication must have one timeout");
  timers.fireNext();
  assert.strictEqual(timers.activeCount(), 0);
  await assert.rejects(timedOut, /Deal publication request timed out/);
  assert.strictEqual(loader.getCurrentVersion(), null);
  assert.strictEqual(timers.activeCount(), 0, "the publication timeout must be cleaned up");

  const retried = await loader.load();
  assert.deepStrictEqual(retried, { updated: true, version: VERSION_ONE });
  assert.strictEqual(requests.calls.length, 3, "a timeout must release the request for retry");
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(timers.activeCount(), 0, "successful retry timers must be cleaned up");
}

async function testSnapshotTimeoutPreservesLastSnapshot() {
  const firstTime = "2026-07-18T19:10:00Z";
  const secondTime = "2026-07-18T19:20:00Z";
  const timers = manualTimers();
  const requests = queueFetch([
    jsonResponse(publication(VERSION_ONE, snapshotPath(VERSION_ONE), firstTime, 1)),
    jsonResponse({ scraped_at: firstTime, deals: [publishedDeal({ vote_delta: 1 })], count: 1 }),
    jsonResponse(publication(VERSION_TWO, snapshotPath(VERSION_TWO), secondTime, 1)),
    new Promise(() => {}),
    jsonResponse(publication(VERSION_TWO, snapshotPath(VERSION_TWO), secondTime, 1)),
    jsonResponse({ scraped_at: secondTime, deals: [publishedDeal({ vote_delta: 2 })], count: 1 }),
  ]);
  const applied = [];
  const loader = createPublishedDealsLoader({
    config,
    fetchImpl: requests.fetchImpl,
    onSnapshot: (snapshot) => applied.push(snapshot),
    requestTimeoutMs: 1000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  await loader.load();
  assert.strictEqual(timers.activeCount(), 0, "successful initial-load timers must be cleaned up");
  const timedOut = loader.load();
  await flush();
  assert.strictEqual(requests.calls.length, 4, "the refresh must reach the snapshot request");
  assert.strictEqual(timers.activeCount(), 1, "only the pending snapshot timeout may remain active");
  timers.fireNext();
  assert.strictEqual(timers.activeCount(), 0);
  await assert.rejects(timedOut, /Deal snapshot request timed out/);
  assert.strictEqual(loader.getCurrentVersion(), VERSION_ONE);
  assert.strictEqual(applied.length, 1, "a timed-out refresh must retain the last valid snapshot");
  assert.strictEqual(timers.activeCount(), 0, "the snapshot timeout must be cleaned up");

  const retried = await loader.load();
  assert.deepStrictEqual(retried, { updated: true, version: VERSION_TWO });
  assert.strictEqual(requests.calls.length, 6, "snapshot timeout must release the request for retry");
  assert.strictEqual(applied.length, 2);
  assert.strictEqual(timers.activeCount(), 0, "successful refresh timers must be cleaned up");
}

async function testMalformedRefreshPreservesLastSnapshot() {
  const firstTime = "2026-07-18T19:30:00Z";
  const secondTime = "2026-07-18T19:40:00Z";
  const requests = queueFetch([
    jsonResponse(publication(VERSION_ONE, snapshotPath(VERSION_ONE), firstTime, 1)),
    jsonResponse({ scraped_at: firstTime, deals: [publishedDeal()], count: 1 }),
    jsonResponse(publication(VERSION_TWO, snapshotPath(VERSION_TWO), secondTime, 1)),
    jsonResponse({ scraped_at: secondTime, deals: [null], count: 1 }),
  ]);
  const applied = [];
  const loader = createPublishedDealsLoader({
    config,
    fetchImpl: requests.fetchImpl,
    onSnapshot: (snapshot) => applied.push(snapshot),
  });

  await loader.load();
  await assert.rejects(loader.load(), /invalid deal/);
  assert.strictEqual(loader.getCurrentVersion(), VERSION_ONE);
  assert.strictEqual(applied.length, 1, "a malformed refresh must retain the last valid snapshot");
}

function browserElement(id, initialValue, focusState) {
  const listeners = {};
  let html = "";
  const element = {
    id,
    value: initialValue || "",
    textContent: "",
    attributes: {},
    buttons: [],
    focusCount: 0,
    retryButton: null,
    addEventListener: (event, listener) => {
      listeners[event] = listener;
    },
    emit: (event) => listeners[event] && listeners[event](),
    setAttribute: (name, value) => {
      element.attributes[name] = value;
    },
    contains: (candidate) => (
      candidate === element ||
      element.buttons.includes(candidate) ||
      candidate === element.retryButton
    ),
    focus: () => {
      element.focusCount += 1;
      focusState.activeElement = element;
    },
    querySelector: (selector) => {
      if (selector === ".retry-button") return element.retryButton;
      return null;
    },
    querySelectorAll: () => element.buttons.filter((button) => !button.disabled),
  };

  Object.defineProperty(element, "innerHTML", {
    get: () => html,
    set: (value) => {
      const removedFocusedChild = (
        element.buttons.includes(focusState.activeElement) ||
        focusState.activeElement === element.retryButton
      );
      html = value;
      element.buttons = [];
      element.retryButton = null;
      if (removedFocusedChild) focusState.activeElement = null;
      if (id === "deals-list" && /class="retry-button"/.test(value)) {
        const retryListeners = {};
        const retryButton = {
          addEventListener: (event, listener) => {
            retryListeners[event] = listener;
          },
          emit: (event) => {
            if (event === "click") retryButton.focus();
            return retryListeners[event] && retryListeners[event]();
          },
          focus: () => {
            focusState.activeElement = retryButton;
          },
        };
        element.retryButton = retryButton;
      }
      if (id !== "pagination") return;

      const buttonPattern = /<button\s+([^>]*)>/g;
      let match;
      while ((match = buttonPattern.exec(value))) {
        const attributes = match[1];
        const pageMatch = attributes.match(/data-page="([^"]+)"/);
        const labelMatch = attributes.match(/aria-label="([^"]+)"/);
        if (!pageMatch) continue;
        const buttonListeners = {};
        const button = {
          dataset: { page: pageMatch[1] },
          disabled: /\bdisabled\b/.test(attributes),
          ariaLabel: labelMatch ? labelMatch[1] : null,
          ariaCurrent: /\baria-current="page"/.test(attributes) ? "page" : null,
          addEventListener: (event, listener) => {
            buttonListeners[event] = listener;
          },
          emit: (event) => {
            if (event === "click") button.focus();
            return buttonListeners[event] && buttonListeners[event]();
          },
          focus: () => {
            focusState.activeElement = button;
          },
          getAttribute: (name) => {
            if (name === "aria-label") return button.ariaLabel;
            if (name === "aria-current") return button.ariaCurrent;
            return null;
          },
        };
        element.buttons.push(button);
      }
    },
  });
  return element;
}

function browserDeal(index, postedAt, velocityLabel, voteDelta) {
  return publishedDeal({
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
  });
}

function createBrowserApp(browserResponses, options = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const requests = queueFetch(browserResponses);
  const focusState = { activeElement: null };
  const elements = {
    search: browserElement("search", "", focusState),
    sort: browserElement("sort", "velocity", focusState),
    "posted-window": browserElement("posted-window", "12h", focusState),
    "deals-list": browserElement("deals-list", "", focusState),
    pagination: browserElement("pagination", "", focusState),
    "results-meta": browserElement("results-meta", "", focusState),
    "last-updated": browserElement("last-updated", "", focusState),
    "next-refresh": browserElement("next-refresh", "", focusState),
  };
  const intervalTimers = [];
  const document = {
    get activeElement() {
      return focusState.activeElement;
    },
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
  const requestTimers = options.requestTimers;
  elements["deals-list"].setAttribute("aria-busy", "true");
  elements["deals-list"].innerHTML = '<p class="ticket-state" role="status">Counting the latest tickets...</p>';
  const context = {
    AbortController,
    console: { error: () => {} },
    Date,
    document,
    fetch: requests.fetchImpl,
    Intl,
    module: { exports: {} },
    setInterval: (callback, delay) => {
      const timer = { callback, delay };
      intervalTimers.push(timer);
      return timer;
    },
    clearInterval: () => {},
    setTimeout: requestTimers ? requestTimers.setTimeout : setTimeout,
    clearTimeout: requestTimers ? requestTimers.clearTimeout : clearTimeout,
    window: {
      DATA_CONFIG: config,
      matchMedia: () => ({ matches: true }),
      scrollTo: () => {},
    },
  };

  vm.runInNewContext(source, context, { filename: "app.js" });
  return { document, elements, intervalTimers, requests };
}

async function testBrowserRefreshPreservesControlsAndPage() {
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
  const requestTimers = manualTimers();
  const { document, elements, intervalTimers, requests } = createBrowserApp(
    browserResponses,
    { requestTimers },
  );
  await flush();
  assert.strictEqual(requestTimers.activeCount(), 0, "initial success timers must be cleaned up");

  elements.search.value = "Alpha";
  elements.search.emit("input");
  elements["posted-window"].value = "24h";
  elements["posted-window"].emit("change");
  const pageTwo = elements.pagination.buttons.find((button) => button.dataset.page === "2");
  assert.ok(pageTwo, "the initial filtered result must have a second page");
  pageTwo.emit("click");
  assert.strictEqual(elements["results-meta"].textContent, "Showing 26-30 of 30 tickets");
  assert.strictEqual(
    elements["results-meta"].focusCount,
    1,
    "pagination should focus the results summary before scrolling to the new page",
  );
  assert.strictEqual(document.activeElement, elements["results-meta"]);

  const focusedBeforeRefresh = elements.pagination.buttons.find(
    (button) => button.ariaLabel === "Page 2",
  );
  assert.ok(focusedBeforeRefresh);
  focusedBeforeRefresh.focus();

  const pollTimer = intervalTimers.find((timer) => timer.delay === 60000);
  assert.ok(pollTimer, "the browser must poll the publication pointer every minute");
  await pollTimer.callback();
  assert.strictEqual(requestTimers.activeCount(), 0, "successful poll timers must be cleaned up");

  const focusedAfterRefresh = elements.pagination.buttons.find(
    (button) => button.ariaLabel === "Page 2",
  );
  assert.ok(focusedAfterRefresh);
  assert.notStrictEqual(focusedAfterRefresh, focusedBeforeRefresh);
  assert.strictEqual(
    document.activeElement,
    focusedAfterRefresh,
    "a background refresh should focus the equivalent rebuilt pagination control",
  );

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
  assert.strictEqual(requestTimers.activeCount(), 0, "failed poll timers must be cleaned up");
  assert.strictEqual(
    elements["deals-list"].innerHTML,
    renderedAfterRefresh,
    "a silent pointer failure must retain the last valid cards",
  );

  browserResponses.push(new Promise(() => {}));
  const timedOutPoll = pollTimer.callback();
  assert.strictEqual(requestTimers.activeCount(), 1, "the pending poll must have one timeout");
  requestTimers.fireNext();
  assert.strictEqual(requestTimers.activeCount(), 0);
  await timedOutPoll;
  assert.strictEqual(requestTimers.activeCount(), 0, "timed-out poll timers must be cleaned up");
  assert.strictEqual(
    elements["deals-list"].innerHTML,
    renderedAfterRefresh,
    "a silent pointer timeout must retain the last valid cards",
  );

  const callsBeforeRetry = requests.calls.length;
  browserResponses.push(jsonResponse(publication(
    BROWSER_VERSION_TWO,
    snapshotPath(BROWSER_VERSION_TWO),
    secondTime,
    secondDeals.length,
  )));
  await pollTimer.callback();
  assert.strictEqual(requestTimers.activeCount(), 0, "retry poll timers must be cleaned up");
  assert.strictEqual(
    requests.calls.length,
    callsBeforeRetry + 1,
    "a silent timeout must release the request so the next poll can retry",
  );
}

async function testBrowserTimeoutAndRetryPendingState() {
  const requestTimers = manualTimers();
  const retryResponse = deferred();
  const browserResponses = [new Promise(() => {}), retryResponse.promise];
  const { elements, requests } = createBrowserApp(browserResponses, { requestTimers });

  assert.strictEqual(elements["deals-list"].attributes["aria-busy"], "true");
  assert.strictEqual(
    elements["deals-list"].focusCount,
    0,
    "the automatic initial load must not steal focus",
  );
  assert.strictEqual(requestTimers.activeCount(), 1, "the pending initial load must have one timeout");
  requestTimers.fireNext();
  assert.strictEqual(requestTimers.activeCount(), 0);
  await flush();
  assert.strictEqual(requestTimers.activeCount(), 0, "initial timeout cleanup must complete");

  assert.strictEqual(elements["results-meta"].textContent, "Counter unavailable");
  assert.strictEqual(elements["deals-list"].attributes["aria-busy"], "false");
  assert.ok(elements["deals-list"].retryButton, "an initial timeout must expose Retry");
  assert.strictEqual(elements["deals-list"].focusCount, 0);

  const retryButton = elements["deals-list"].retryButton;
  const retryRequest = retryButton.emit("click");
  assert.strictEqual(elements["deals-list"].attributes["aria-busy"], "true");
  assert.ok(elements["deals-list"].innerHTML.includes("Counting the latest tickets"));
  assert.strictEqual(elements["deals-list"].retryButton, null, "Retry must not remain actionable while pending");
  assert.strictEqual(
    elements["deals-list"].focusCount,
    1,
    "Retry loading should move focus to the stable deals container",
  );
  assert.strictEqual(requests.calls.length, 2);
  assert.strictEqual(requestTimers.activeCount(), 1, "the pending Retry must have one timeout");

  retryResponse.resolve(jsonResponse({ error: "temporary outage" }, 503));
  await retryRequest;
  assert.strictEqual(requestTimers.activeCount(), 0, "failed Retry timers must be cleaned up");
  assert.strictEqual(elements["deals-list"].attributes["aria-busy"], "false");
  assert.ok(elements["deals-list"].retryButton, "the error action must return when Retry fails");
}

async function testBrowserSnapshotTimeoutShowsSafeError() {
  const scrapedAt = new Date(Date.now() - 60 * 1000).toISOString();
  const requestTimers = manualTimers();
  const browserResponses = [
    jsonResponse(publication(VERSION_ONE, snapshotPath(VERSION_ONE), scrapedAt, 1)),
    new Promise(() => {}),
  ];
  const { elements, requests } = createBrowserApp(browserResponses, { requestTimers });

  await flush();
  assert.strictEqual(requests.calls.length, 2, "the initial load must reach the snapshot request");
  assert.strictEqual(requestTimers.activeCount(), 1, "only the pending snapshot timeout may remain active");
  requestTimers.fireNext();
  assert.strictEqual(requestTimers.activeCount(), 0);
  await flush();
  assert.strictEqual(requestTimers.activeCount(), 0, "snapshot timeout cleanup must complete");

  assert.strictEqual(elements["results-meta"].textContent, "Counter unavailable");
  assert.strictEqual(elements["deals-list"].attributes["aria-busy"], "false");
  assert.ok(elements["deals-list"].retryButton, "an initial snapshot timeout must expose Retry");
}

async function testBrowserMalformedSnapshotShowsSafeError() {
  const scrapedAt = new Date(Date.now() - 60 * 1000).toISOString();
  const browserResponses = [
    jsonResponse(publication(VERSION_ONE, snapshotPath(VERSION_ONE), scrapedAt, 1)),
    jsonResponse({ scraped_at: scrapedAt, deals: [null], count: 1 }),
  ];
  const { elements } = createBrowserApp(browserResponses);

  await flush();
  assert.strictEqual(elements["results-meta"].textContent, "Counter unavailable");
  assert.strictEqual(elements["deals-list"].attributes["aria-busy"], "false");
  assert.ok(elements["deals-list"].retryButton, "a malformed initial snapshot must fail safely");
}

function testValidationHelpers() {
  const htmlSource = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
  assert.match(htmlSource, /id="results-meta"[^>]*tabindex="-1"/);
  assert.match(htmlSource, /id="deals-list"[^>]*tabindex="-1"/);
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
  const validDeal = publishedDeal();
  assert.strictEqual(
    normalizeSnapshot(
      { scraped_at: "2026-07-18T18:00:00Z", deals: [validDeal], count: 1 },
      validPublication,
    ).deals[0],
    validDeal,
  );
  const additiveDeal = publishedDeal({ future_publisher_field: "safe to ignore" });
  assert.strictEqual(
    normalizeSnapshot(
      { scraped_at: "2026-07-18T18:00:00Z", deals: [additiveDeal], count: 1 },
      validPublication,
    ).deals[0],
    additiveDeal,
    "additive publisher fields must remain compatible with long-lived clients",
  );
  const missingTitle = publishedDeal();
  delete missingTitle.title;
  for (const invalidDeal of [null, "not-an-object", missingTitle, publishedDeal({ votes: "10" })]) {
    assert.throws(
      () => normalizeSnapshot(
        { scraped_at: "2026-07-18T18:00:00Z", deals: [invalidDeal], count: 1 },
        validPublication,
      ),
      /invalid deal/,
    );
  }
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
  testManualTimersRejectAmbiguousTimeouts();
  await testPublicationLifecycle();
  await testInvalidSnapshotRetriesSameVersion();
  await testConcurrentLoadsShareRequest();
  await testPublicationTimeoutReleasesRequest();
  await testSnapshotTimeoutPreservesLastSnapshot();
  await testMalformedRefreshPreservesLastSnapshot();
  await testBrowserRefreshPreservesControlsAndPage();
  await testBrowserTimeoutAndRetryPendingState();
  await testBrowserSnapshotTimeoutShowsSafeError();
  await testBrowserMalformedSnapshotShowsSafeError();
  testValidationHelpers();
  console.log("app data loading tests passed");
}

const testWatchdog = setTimeout(() => {
  console.error(new Error("app data loading tests exceeded the 10-second watchdog"));
  process.exitCode = 1;
}, 10000);

main().then(
  () => clearTimeout(testWatchdog),
  (error) => {
    clearTimeout(testWatchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
