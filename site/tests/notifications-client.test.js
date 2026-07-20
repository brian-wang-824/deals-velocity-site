const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../public/notifications.js"), "utf8");
const thresholdValues = ["warming", "hot", "surging", "blazing", "on fire", "inferno"];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function element(properties = {}) {
  const listeners = {};
  return Object.assign({
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    addEventListener(type, listener) {
      (listeners[type] || (listeners[type] = [])).push(listener);
    },
    async emit(type, event = {}) {
      const payload = Object.assign({ target: this }, event);
      for (const listener of listeners[type] || []) await listener(payload);
    },
    close() {},
    setAttribute() {},
    showModal() {},
  }, properties);
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function createLockManager() {
  const tails = new Map();
  return {
    request(name, _options, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const result = previous.catch(() => {}).then(callback);
      tails.set(name, result.catch(() => {}));
      return result;
    },
  };
}

function assertSavedInstallation(storage, expected) {
  const actual = JSON.parse(storage.get("deal-alert-installation-v1"));
  assert.equal(Number.isFinite(actual.validatedAt), true);
  const comparable = Object.assign({}, actual);
  delete comparable.validatedAt;
  delete comparable.intentToken;
  assert.deepEqual(comparable, expected);
}

function createHarness(options = {}) {
  const storage = options.storage || new Map();
  const calls = [];
  const counters = { subscribe: 0, unsubscribe: 0 };
  const subscriptionState = options.subscriptionState || {};
  const originalEndpoint = options.subscriptionEndpoint || "https://push.test/original";
  if (options.installation) {
    storage.set("deal-alert-installation-v1", JSON.stringify(Object.assign({
      endpoint: originalEndpoint,
    }, options.installation)));
  }

  function makeSubscription(endpoint) {
    return {
      endpoint,
      toJSON() {
        return {
          endpoint,
          expirationTime: null,
          keys: { p256dh: "p256dh", auth: "auth" },
        };
      },
      async unsubscribe() {
        counters.unsubscribe += 1;
        if (options.unsubscribe) {
          return await options.unsubscribe(() => {
            subscriptionState.current = null;
            return true;
          });
        }
        subscriptionState.current = null;
        return true;
      },
    };
  }

  if (!Object.prototype.hasOwnProperty.call(subscriptionState, "current")) {
    subscriptionState.current = options.hasSubscription === false
      ? null : makeSubscription(originalEndpoint);
  }
  const pushManager = {
    async getSubscription() {
      if (options.getSubscription) return await options.getSubscription(() => subscriptionState.current);
      return subscriptionState.current;
    },
    async subscribe() {
      counters.subscribe += 1;
      subscriptionState.current = makeSubscription("https://push.test/replacement-" + counters.subscribe);
      return subscriptionState.current;
    },
  };
  const registration = { pushManager };
  const serviceWorker = {
    ready: Promise.resolve(registration),
    async getRegistration() { return registration; },
    async register() { return registration; },
  };

  const inputs = thresholdValues.map((value) => element({ value }));
  const elements = {
    "notification-settings": element(),
    "notification-settings-button": element(),
    "notification-enable": element(),
    "notification-disable": element({ hidden: true }),
    "notification-status": element(),
    "notification-platform-note": element({ hidden: true }),
  };
  const notification = {
    permission: options.permission || "granted",
    async requestPermission() { return this.permission; },
  };
  const navigator = {
    maxTouchPoints: 0,
    platform: "test",
    serviceWorker,
    userAgent: "test browser",
  };
  if (options.locks) navigator.locks = options.locks;
  const windowListeners = {};
  const window = {
    NOTIFICATION_CONFIG: {
      edgeFunctionUrl: "https://api.test/notifications",
      vapidPublicKey: "AQIDBA",
      apiTimeoutMs: options.apiTimeoutMs,
    },
    Notification: notification,
    PushManager: function PushManager() {},
    atob(value) { return Buffer.from(value, "base64").toString("binary"); },
    addEventListener(type, listener) {
      (windowListeners[type] || (windowListeners[type] = [])).push(listener);
    },
    async emit(type, event = {}) {
      for (const listener of windowListeners[type] || []) await listener(event);
    },
    matchMedia() { return { matches: false }; },
    navigator,
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    removeItem(key) { storage.delete(key); },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const fetch = async (url, request) => {
    const call = { url, body: JSON.parse(request.body), signal: request.signal };
    calls.push(call);
    return options.fetch ? await options.fetch(call, calls.length) : response(200, {
      installationId: call.body.installationId || "new-installation",
      managementSecret: call.body.installationId ? null : "new-secret",
    });
  };

  vm.runInNewContext(source, {
    AbortController,
    Buffer,
    Error,
    Notification: notification,
    Promise,
    clearTimeout,
    setTimeout,
    Uint8Array,
    document: {
      getElementById(id) { return elements[id]; },
      querySelectorAll() { return inputs; },
    },
    fetch,
    localStorage,
    navigator,
    window,
  }, { filename: "notifications.js" });

  return {
    calls,
    counters,
    elements,
    inputs,
    storage,
    currentSubscription: () => subscriptionState.current,
    input(value) { return inputs.find((candidate) => candidate.value === value); },
    window,
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function testStaleInstallationRecovers() {
  const harness = createHarness({
    installation: {
      installationId: "old-installation",
      managementSecret: "old-secret",
      thresholds: ["warming"],
    },
    async fetch(_call, number) {
      if (number === 1) {
        return response(401, { error: "This notification installation is no longer registered.", code: "stale_installation" });
      }
      return response(200, { installationId: "new-installation", managementSecret: "new-secret" });
    },
  });

  await harness.elements["notification-settings-button"].emit("click");
  await flush();
  assert.equal(harness.input("warming").checked, true);

  harness.input("warming").checked = false;
  harness.input("hot").checked = true;
  await harness.input("hot").emit("change");
  await harness.elements["notification-enable"].emit("click");
  await flush();

  assert.equal(harness.calls.length, 3);
  assert.equal(harness.calls[0].body.installationId, "old-installation");
  assert.equal(harness.calls[1].body.installationId, null);
  assert.deepEqual(harness.calls[1].body.thresholds, ["warming"]);
  assert.equal(harness.calls[2].body.installationId, "new-installation");
  assert.deepEqual(harness.calls[2].body.thresholds, ["hot"]);
  assert.equal(harness.counters.unsubscribe, 1);
  assert.equal(harness.counters.subscribe, 1);
  assertSavedInstallation(harness.storage, {
    installationId: "new-installation",
    managementSecret: "new-secret",
    thresholds: ["hot"],
    endpoint: "https://push.test/replacement-1",
  });
  assert.equal(harness.elements["notification-status"].textContent, "Notifications enabled for 1 heat level.");
}

async function testDisableAlwaysCleansUpLocally() {
  const harness = createHarness({
    installation: {
      installationId: "stale-installation",
      managementSecret: "stale-secret",
      thresholds: ["inferno"],
    },
    async fetch(call) {
      return call.url.endsWith("/disable")
        ? response(401, { error: "Invalid installation credentials." })
        : response(200, { installationId: "stale-installation", managementSecret: null });
    },
  });

  await harness.elements["notification-settings-button"].emit("click");
  await flush();
  assert.equal(harness.elements["notification-disable"].hidden, false);
  await harness.elements["notification-disable"].emit("click");
  await flush();

  assert.equal(harness.counters.unsubscribe, 1);
  assert.equal(harness.currentSubscription(), null);
  assert.equal(harness.storage.has("deal-alert-installation-v1"), false);
  assert.equal(harness.inputs.every((input) => !input.checked), true);
  assert.equal(harness.elements["notification-status"].textContent, "Notifications are off.");
  assert.equal(harness.elements["notification-disable"].hidden, true);
}

async function testGenericAuthErrorDoesNotReplaceSubscription() {
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    async fetch(call) {
      return call.body.thresholds && call.body.thresholds.includes("hot")
        ? response(401, { error: "Invalid JWT." })
        : response(200, { installationId: "installation", managementSecret: null });
    },
  });

  await harness.elements["notification-settings-button"].emit("click");
  await flush();
  harness.input("warming").checked = false;
  harness.input("hot").checked = true;
  await harness.input("hot").emit("change");
  await harness.elements["notification-enable"].emit("click");
  await flush();

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.counters.unsubscribe, 0);
  assert.equal(harness.counters.subscribe, 0);
  assert.equal(harness.input("hot").checked, true, "failed save keeps the user's pending edit");
  assert.equal(harness.elements["notification-status"].textContent, "Invalid JWT.");
}

async function testSlowRemoteDisableDoesNotBlockLocalCleanup() {
  const pendingDisable = deferred();
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["hot"],
    },
    fetch() { return pendingDisable.promise; },
  });

  await harness.elements["notification-settings-button"].emit("click");
  await flush();
  await Promise.race([
    harness.elements["notification-disable"].emit("click"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("local disable waited for the remote API")), 100)),
  ]);

  assert.equal(harness.currentSubscription(), null);
  assert.equal(harness.storage.has("deal-alert-installation-v1"), false);
  assert.equal(harness.elements["notification-status"].textContent, "Notifications are off.");
  pendingDisable.resolve(response(401, {
    error: "This notification installation is no longer registered.",
    code: "stale_installation",
  }));
  await flush();
  assert.equal(harness.currentSubscription(), null, "late reconciliation must not recreate the subscription");
  assert.equal(harness.storage.has("deal-alert-installation-v1"), false, "late reconciliation must not restore local credentials");
  assert.equal(harness.counters.subscribe, 0);
}

async function testSlowRefreshDoesNotOverwriteEdits() {
  const pendingSubscription = deferred();
  let firstLookup = true;
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    getSubscription(current) {
      if (firstLookup) {
        firstLookup = false;
        return pendingSubscription.promise;
      }
      return current();
    },
  });

  await harness.elements["notification-settings-button"].emit("click");
  assert.equal(harness.input("warming").checked, true, "stored state hydrates before the slow lookup");
  harness.input("warming").checked = false;
  harness.input("surging").checked = true;
  await harness.input("surging").emit("change");
  pendingSubscription.resolve(harness.currentSubscription());
  await flush();

  assert.equal(harness.input("warming").checked, false);
  assert.equal(harness.input("surging").checked, true);
}

async function testOrphanedInstallationCanBeDisabled() {
  const harness = createHarness({
    hasSubscription: false,
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["blazing"],
    },
  });
  await harness.elements["notification-settings-button"].emit("click");
  assert.equal(harness.elements["notification-disable"].hidden, false);
  await flush();
  assert.equal(harness.elements["notification-status"].textContent, "Alert settings need to be re-enabled on this device.");
}

async function runTest(name, callback) {
  let timer;
  try {
    await Promise.race([
      callback(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(name + " timed out")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function testRotatedEndpointReconcilesOnLoad() {
  const harness = createHarness({
    subscriptionEndpoint: "https://push.test/rotated",
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["hot"],
      endpoint: "https://push.test/original",
    },
    async fetch() {
      return response(200, { installationId: "installation", managementSecret: null });
    },
  });

  await flush();

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].body.installationId, "installation");
  assert.equal(harness.calls[0].body.subscription.endpoint, "https://push.test/rotated");
  assert.deepEqual(harness.calls[0].body.thresholds, ["hot"]);
  assertSavedInstallation(harness.storage, {
    installationId: "installation",
    managementSecret: "secret",
    thresholds: ["hot"],
    endpoint: "https://push.test/rotated",
  });
  assert.equal(harness.elements["notification-status"].textContent, "Notifications are on for this device.");
}

async function testMissingServerRowWithSameEndpointRecoversOnLoad() {
  const harness = createHarness({
    installation: {
      installationId: "deleted-installation",
      managementSecret: "deleted-secret",
      thresholds: ["surging"],
    },
    async fetch(_call, number) {
      if (number === 1) {
        return response(401, {
          error: "This notification installation is no longer registered.",
          code: "stale_installation",
        });
      }
      return response(200, { installationId: "replacement-installation", managementSecret: "replacement-secret" });
    },
  });

  await flush();

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0].body.subscription.endpoint, "https://push.test/original");
  assert.equal(harness.calls[1].body.installationId, null);
  assert.equal(harness.counters.unsubscribe, 1);
  assert.equal(harness.counters.subscribe, 1);
  assertSavedInstallation(harness.storage, {
    installationId: "replacement-installation",
    managementSecret: "replacement-secret",
    thresholds: ["surging"],
    endpoint: "https://push.test/replacement-1",
  });
  assert.equal(harness.elements["notification-status"].textContent, "Notifications are on for this device.");
}

async function testLateReconciliationDoesNotOverwriteSavedThresholds() {
  const pendingReconciliation = deferred();
  let serverThresholds = null;
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    async fetch(call, number) {
      if (number === 1) await pendingReconciliation.promise;
      serverThresholds = call.body.thresholds;
      return response(200, { installationId: "installation", managementSecret: null });
    },
  });

  await flush();
  harness.input("warming").checked = false;
  harness.input("hot").checked = true;
  await harness.input("hot").emit("change");
  const save = harness.elements["notification-enable"].emit("click");
  await flush();

  assert.equal(harness.calls.length, 1, "Save waits for the older server mutation to settle");

  pendingReconciliation.resolve();
  await save;
  await flush();

  assert.equal(harness.calls.length, 2);
  assert.deepEqual(serverThresholds, ["hot"], "the explicit Save is the final server mutation");
  assert.deepEqual(
    JSON.parse(harness.storage.get("deal-alert-installation-v1")).thresholds,
    ["hot"],
    "a late background sync must not overwrite a newer explicit save",
  );
}

async function testStaleRefreshDoesNotOverwriteSaveFailure() {
  const pendingLookup = deferred();
  let firstLookup = true;
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    getSubscription(current) {
      if (firstLookup) {
        firstLookup = false;
        return pendingLookup.promise;
      }
      return current();
    },
    async fetch() { return response(500, { error: "Save failed." }); },
  });

  harness.input("warming").checked = false;
  harness.input("hot").checked = true;
  await harness.input("hot").emit("change");
  await harness.elements["notification-enable"].emit("click");
  assert.equal(harness.elements["notification-status"].textContent, "Save failed.");

  pendingLookup.resolve(harness.currentSubscription());
  await flush();

  assert.equal(
    harness.elements["notification-status"].textContent,
    "Save failed.",
    "a pre-Save refresh must not overwrite the user action's result",
  );
}

async function testCrossContextReconciliationUsesOneFreshEnrollment() {
  const storage = new Map();
  const subscriptionState = {};
  const locks = createLockManager();
  const pendingStaleCheck = deferred();
  const first = createHarness({
    storage,
    subscriptionState,
    locks,
    installation: {
      installationId: "deleted-installation",
      managementSecret: "deleted-secret",
      thresholds: ["warming"],
    },
    async fetch(_call, number) {
      if (number === 1) return await pendingStaleCheck.promise;
      return response(200, { installationId: "fresh-installation", managementSecret: "fresh-secret" });
    },
  });

  await flush();
  const second = createHarness({
    storage,
    subscriptionState,
    locks,
    async fetch() {
      throw new Error("the second context should reuse the shared validation result");
    },
  });
  await flush();
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);

  pendingStaleCheck.resolve(response(401, {
    error: "This notification installation is no longer registered.",
    code: "stale_installation",
  }));
  await flush();
  await flush();

  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 0);
  assertSavedInstallation(storage, {
    installationId: "fresh-installation",
    managementSecret: "fresh-secret",
    thresholds: ["warming"],
    endpoint: "https://push.test/replacement-1",
  });
}

async function testCrossContextSaveIsFinalServerMutation() {
  const storage = new Map();
  const subscriptionState = {};
  const locks = createLockManager();
  const pendingReconciliation = deferred();
  let serverThresholds = null;
  const first = createHarness({
    storage,
    subscriptionState,
    locks,
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    async fetch(call) {
      await pendingReconciliation.promise;
      serverThresholds = call.body.thresholds;
      return response(200, { installationId: "installation", managementSecret: null });
    },
  });

  await flush();
  const second = createHarness({
    storage,
    subscriptionState,
    locks,
    async fetch(call) {
      serverThresholds = call.body.thresholds;
      return response(200, { installationId: "installation", managementSecret: null });
    },
  });
  second.input("warming").checked = false;
  second.input("hot").checked = true;
  await second.input("hot").emit("change");
  const save = second.elements["notification-enable"].emit("click");
  await flush();

  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
  pendingReconciliation.resolve();
  await save;
  await flush();

  assert.deepEqual(serverThresholds, ["hot"]);
  assert.deepEqual(JSON.parse(storage.get("deal-alert-installation-v1")).thresholds, ["hot"]);
  assert.equal(storage.has("deal-alert-installation-provisional-v1"), false);
}

async function testCrossContextFreshEnrollmentCompensatesDisable() {
  const storage = new Map();
  const subscriptionState = {};
  const locks = createLockManager();
  const pendingFreshEnrollment = deferred();
  const compensated = [];
  const first = createHarness({
    storage,
    subscriptionState,
    locks,
    installation: {
      installationId: "deleted-installation",
      managementSecret: "deleted-secret",
      thresholds: ["surging"],
    },
    async fetch(call, number) {
      if (call.url.endsWith("/disable")) {
        compensated.push(call.body);
        return response(200, { ok: true });
      }
      if (number === 1) {
        return response(401, {
          error: "This notification installation is no longer registered.",
          code: "stale_installation",
        });
      }
      return await pendingFreshEnrollment.promise;
    },
  });

  await flush();
  assert.equal(first.calls.length, 2);
  const second = createHarness({
    storage,
    subscriptionState,
    locks,
    async fetch() { return response(200, { ok: true }); },
  });
  await second.elements["notification-disable"].emit("click");
  assert.equal(storage.has("deal-alert-installation-v1"), false);
  assert.equal(second.currentSubscription(), null);

  pendingFreshEnrollment.resolve(response(200, {
    installationId: "fresh-installation",
    managementSecret: "fresh-secret",
  }));
  await flush();
  await flush();

  assert.equal(compensated.some((candidate) =>
    candidate.installationId === "fresh-installation" && candidate.managementSecret === "fresh-secret"
  ), true);
  assert.equal(storage.has("deal-alert-installation-v1"), false);
  assert.equal(storage.has("deal-alert-installation-provisional-v1"), false);
  assert.equal(second.currentSubscription(), null);
}

async function testRefreshStartedDuringSaveDoesNotOverwriteFailure() {
  const pendingSave = deferred();
  const pendingFocusLookup = deferred();
  let lookup = 0;
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    getSubscription(current) {
      lookup += 1;
      if (lookup === 4) return pendingFocusLookup.promise;
      return current();
    },
    async fetch(_call, number) {
      if (number === 1) return response(200, { installationId: "installation", managementSecret: null });
      return await pendingSave.promise;
    },
  });

  await flush();
  harness.input("warming").checked = false;
  harness.input("hot").checked = true;
  await harness.input("hot").emit("change");
  const save = harness.elements["notification-enable"].emit("click");
  await flush();
  await harness.window.emit("focus");

  pendingSave.resolve(response(500, { error: "Save failed." }));
  await save;
  assert.equal(harness.elements["notification-status"].textContent, "Save failed.");

  pendingFocusLookup.resolve(harness.currentSubscription());
  await flush();
  assert.equal(harness.elements["notification-status"].textContent, "Save failed.");
}

async function testSlowDisableCleanupPrecedesNewerCrossContextSave() {
  const storage = new Map();
  const subscriptionState = {};
  const locks = createLockManager();
  const pendingUnsubscribe = deferred();
  const first = createHarness({
    storage,
    subscriptionState,
    locks,
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
      validatedAt: Date.now(),
    },
    async unsubscribe(remove) {
      await pendingUnsubscribe.promise;
      return remove();
    },
    async fetch() { return response(200, { ok: true }); },
  });

  await flush();
  const disable = first.elements["notification-disable"].emit("click");
  await flush();

  const second = createHarness({
    storage,
    subscriptionState,
    locks,
    async fetch() {
      return response(200, { installationId: "new-installation", managementSecret: "new-secret" });
    },
  });
  second.input("hot").checked = true;
  await second.input("hot").emit("change");
  const save = second.elements["notification-enable"].emit("click");
  await flush();

  assert.equal(second.calls.length, 0, "the newer Save waits for local unsubscribe to settle");
  pendingUnsubscribe.resolve();
  await disable;
  await save;
  await flush();

  assert.notEqual(second.currentSubscription(), null);
  const saved = JSON.parse(storage.get("deal-alert-installation-v1"));
  assert.equal(saved.endpoint, second.currentSubscription().endpoint);
  assert.deepEqual(saved.thresholds, ["hot"]);
  assert.equal(first.calls.length, 0, "the superseded Disable does not delete the newer enrollment");
}

async function testProvisionalEnrollmentRecoversAfterNewerSaveFailure() {
  const storage = new Map();
  const subscriptionState = {};
  const locks = createLockManager();
  const pendingInitialEnrollment = deferred();
  const first = createHarness({
    storage,
    subscriptionState,
    locks,
    async fetch() { return await pendingInitialEnrollment.promise; },
  });
  first.input("warming").checked = true;
  await first.input("warming").emit("change");
  const initialSave = first.elements["notification-enable"].emit("click");
  await flush();

  const second = createHarness({
    storage,
    subscriptionState,
    locks,
    async fetch(_call, number) {
      if (number === 1) return response(500, { error: "Newer save failed." });
      return response(200, { installationId: "fresh-installation", managementSecret: null });
    },
  });
  second.input("hot").checked = true;
  await second.input("hot").emit("change");
  const newerSave = second.elements["notification-enable"].emit("click");
  await flush();

  pendingInitialEnrollment.resolve(response(200, {
    installationId: "fresh-installation",
    managementSecret: "fresh-secret",
  }));
  await initialSave;
  await newerSave;
  await flush();

  assert.equal(storage.has("deal-alert-installation-v1"), false);
  assert.equal(storage.has("deal-alert-installation-provisional-v1"), true);
  assert.equal(second.elements["notification-status"].textContent, "Newer save failed.");

  await second.window.emit("focus");
  await flush();
  await flush();

  assert.equal(second.calls.length, 2);
  assert.deepEqual(second.calls[1].body.thresholds, ["hot"]);
  assert.deepEqual(JSON.parse(storage.get("deal-alert-installation-v1")).thresholds, ["hot"]);
  assert.equal(storage.has("deal-alert-installation-provisional-v1"), false);
}

async function testFailedDisableCleanupRetriesOnRefresh() {
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
      validatedAt: Date.now(),
    },
    async fetch(_call, number) {
      return number === 1
        ? response(500, { error: "Temporary cleanup failure." })
        : response(200, { ok: true });
    },
  });

  await flush();
  await harness.elements["notification-disable"].emit("click");
  await flush();
  await flush();

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls.every((call) => call.url.endsWith("/disable")), true);
  assert.equal(harness.storage.has("deal-alert-installation-v1"), false);
  const intent = JSON.parse(harness.storage.get("deal-alert-notification-intent-v1"));
  assert.equal(intent.kind, "disable");
  assert.deepEqual(intent.cleanupCredentials, []);
}

async function testTimedOutReconciliationReleasesNextSave() {
  const harness = createHarness({
    apiTimeoutMs: 25,
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    async fetch(call, number) {
      if (number === 1) {
        return await new Promise((_, reject) => {
          call.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return response(200, { installationId: "installation", managementSecret: null });
    },
  });

  await flush();
  harness.input("warming").checked = false;
  harness.input("hot").checked = true;
  await harness.input("hot").emit("change");
  await harness.elements["notification-enable"].emit("click");
  await flush();

  assert.equal(harness.calls.length, 2);
  assert.deepEqual(JSON.parse(harness.storage.get("deal-alert-installation-v1")).thresholds, ["hot"]);
  assert.equal(harness.elements["notification-status"].textContent, "Notifications enabled for 1 heat level.");
}

(async function run() {
  await runTest("stale installation recovery", testStaleInstallationRecovers);
  await runTest("local Disable cleanup", testDisableAlwaysCleansUpLocally);
  await runTest("generic auth error", testGenericAuthErrorDoesNotReplaceSubscription);
  await runTest("slow remote Disable", testSlowRemoteDisableDoesNotBlockLocalCleanup);
  await runTest("slow refresh edits", testSlowRefreshDoesNotOverwriteEdits);
  await runTest("orphaned installation", testOrphanedInstallationCanBeDisabled);
  await runTest("rotated endpoint", testRotatedEndpointReconcilesOnLoad);
  await runTest("same-endpoint server deletion", testMissingServerRowWithSameEndpointRecoversOnLoad);
  await runTest("late reconciliation Save ordering", testLateReconciliationDoesNotOverwriteSavedThresholds);
  await runTest("pre-Save stale refresh", testStaleRefreshDoesNotOverwriteSaveFailure);
  await runTest("cross-context enrollment", testCrossContextReconciliationUsesOneFreshEnrollment);
  await runTest("cross-context Save ordering", testCrossContextSaveIsFinalServerMutation);
  await runTest("cross-context Disable compensation", testCrossContextFreshEnrollmentCompensatesDisable);
  await runTest("during-Save stale refresh", testRefreshStartedDuringSaveDoesNotOverwriteFailure);
  await runTest("Disable cleanup before newer Save", testSlowDisableCleanupPrecedesNewerCrossContextSave);
  await runTest("provisional enrollment recovery", testProvisionalEnrollmentRecoversAfterNewerSaveFailure);
  await runTest("Disable cleanup retry", testFailedDisableCleanupRetriesOnRefresh);
  await runTest("API timeout releases lock", testTimedOutReconciliationReleasesNextSave);
  console.log("notification client tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
