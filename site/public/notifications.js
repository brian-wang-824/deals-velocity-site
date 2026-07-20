(function () {
  "use strict";

  var STORAGE_KEY = "deal-alert-installation-v1";
  var PROVISIONAL_STORAGE_KEY = "deal-alert-installation-provisional-v1";
  var INTENT_STORAGE_KEY = "deal-alert-notification-intent-v1";
  var ALLOWED_THRESHOLDS = ["warming", "hot", "surging", "blazing", "on fire", "inferno"];
  var config = window.NOTIFICATION_CONFIG || {};
  var API_TIMEOUT_MS = Number(config.apiTimeoutMs) > 0 ? Number(config.apiTimeoutMs) : 15000;
  var dialog = document.getElementById("notification-settings");
  var openButton = document.getElementById("notification-settings-button");
  var enableButton = document.getElementById("notification-enable");
  var disableButton = document.getElementById("notification-disable");
  var status = document.getElementById("notification-status");
  var platformNote = document.getElementById("notification-platform-note");
  var thresholdInputs = Array.prototype.slice.call(
    document.querySelectorAll("#notification-thresholds input[type=checkbox]"),
  );
  var selectionsDirty = false;
  var reconciliationPromise = null;
  var fallbackLockTail = Promise.resolve();
  var installationGeneration = 0;
  var userActionInProgress = false;
  var RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
  var ACTION_PENDING_MS = 5 * 60 * 1000;
  var NOTIFICATION_LOCK_NAME = "deal-alert-notification-sync-v1";

  function isSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function selectedThresholds() {
    return thresholdInputs.filter(function (input) { return input.checked; }).map(function (input) {
      return input.value;
    });
  }

  function normalizeThresholds(values) {
    if (!Array.isArray(values)) return [];
    return ALLOWED_THRESHOLDS.filter(function (value) { return values.indexOf(value) !== -1; });
  }

  function readStoredCredentials(key) {
    try {
      var value = JSON.parse(localStorage.getItem(key) || "null");
      return value && value.installationId && value.managementSecret ? value : null;
    } catch (_err) {
      return null;
    }
  }

  function readInstallation() {
    return readStoredCredentials(STORAGE_KEY);
  }

  function readProvisionalInstallation() {
    return readStoredCredentials(PROVISIONAL_STORAGE_KEY);
  }

  function writeInstallation(value) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  function readIntent() {
    try {
      var value = JSON.parse(localStorage.getItem(INTENT_STORAGE_KEY) || "null");
      return value && value.token && value.kind ? value : null;
    } catch (_error) {
      return null;
    }
  }

  function beginIntent(kind, thresholds, cleanupCredentials) {
    var intent = {
      token: Date.now().toString(36) + ":" + Math.random().toString(36).slice(2),
      kind: kind,
      state: "pending",
      createdAt: Date.now(),
      thresholds: normalizeThresholds(thresholds),
      cleanupCredentials: cleanupCredentials || [],
    };
    localStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));
    return intent;
  }

  function intentIsCurrent(intent) {
    var current = readIntent();
    return Boolean(intent && current && current.token === intent.token);
  }

  function intentTokenIsUnchanged(intent) {
    var current = readIntent();
    return intent ? Boolean(current && current.token === intent.token) : !current;
  }

  function intentIsPending(intent) {
    return Boolean(intent && intent.state === "pending" &&
      Date.now() - Number(intent.createdAt || 0) < ACTION_PENDING_MS);
  }

  function completeIntent(intent) {
    if (!intentIsCurrent(intent)) return;
    intent.state = "complete";
    localStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));
  }

  function candidateInstallation(subscription) {
    var provisional = readProvisionalInstallation();
    if (provisional && subscription && provisional.endpoint === subscription.endpoint) return provisional;
    return readInstallation();
  }

  function installationMatchesCurrentIntent(installation) {
    var intent = readIntent();
    if (!intent) return true;
    return Boolean(intent.kind === "enable" && installation &&
      installation.intentToken === intent.token);
  }

  async function withNotificationLock(callback) {
    if (navigator.locks && typeof navigator.locks.request === "function") {
      return await navigator.locks.request(
        NOTIFICATION_LOCK_NAME,
        { mode: "exclusive" },
        callback,
      );
    }
    var previous = fallbackLockTail;
    var release;
    fallbackLockTail = new Promise(function (resolve) { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  function base64UrlToUint8Array(value) {
    var padding = "=".repeat((4 - value.length % 4) % 4);
    var raw = window.atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, function (character) { return character.charCodeAt(0); });
  }

  function subscriptionJson(subscription) {
    var json = subscription.toJSON();
    return { endpoint: json.endpoint, expirationTime: json.expirationTime || null, keys: json.keys };
  }

  async function api(path, body) {
    if (!config.edgeFunctionUrl) throw new Error("Notification service is not configured.");
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timedOut = false;
    var timeout = controller ? setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, API_TIMEOUT_MS) : null;
    var response;
    try {
      response = await fetch(config.edgeFunctionUrl.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      if (timedOut) throw new Error("Notification service request timed out.");
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(result.error || "Notification service request failed.");
      error.status = response.status;
      error.code = result.code || "";
      throw error;
    }
    return result;
  }

  function setBusy(busy) {
    enableButton.disabled = busy;
    disableButton.disabled = busy;
    thresholdInputs.forEach(function (input) { input.disabled = busy; });
  }

  function applyThresholds(values) {
    var thresholds = normalizeThresholds(values);
    thresholdInputs.forEach(function (input) { input.checked = thresholds.indexOf(input.value) !== -1; });
  }

  async function refreshState(options) {
    var committedInstallation = readInstallation();
    var installation = committedInstallation || readProvisionalInstallation();
    var refreshIntent = readIntent();
    if (refreshIntent && refreshIntent.kind === "disable") installation = null;
    var subscription = null;
    var reconciliationError = null;
    var refreshGeneration = installationGeneration;
    var suppressDomWrite = userActionInProgress;

    // Hydrate before awaiting the service worker. Mobile browsers can take long
    // enough here for a user's first edit to otherwise be overwritten.
    if (installation) {
      disableButton.hidden = false;
      if (!selectionsDirty) {
        applyThresholds(
          refreshIntent && refreshIntent.kind === "enable"
            ? refreshIntent.thresholds : installation.thresholds,
        );
      }
    }
    try {
      if (refreshIntent && refreshIntent.kind === "disable" && !userActionInProgress) {
        await cleanupDisableIntent(refreshIntent, null);
      }
      var registration = isSupported() ? await navigator.serviceWorker.getRegistration() : null;
      subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (!(options && options.skipReconciliation) && registration && installation && subscription &&
          Notification.permission === "granted") {
        var reconciled = await reconcileInstallation(
          registration,
          subscription,
          installation,
          refreshGeneration,
        );
        installation = reconciled.installation;
        subscription = reconciled.subscription;
      }
    } catch (_error) {
      reconciliationError = _error;
    }

    if (suppressDomWrite || !reconciliationIsCurrent(refreshGeneration) || userActionInProgress ||
        !intentTokenIsUnchanged(refreshIntent)) return;

    committedInstallation = readInstallation();
    var active = Boolean(
      installation && committedInstallation && sameCredentials(installation, committedInstallation) &&
      subscription && Notification.permission === "granted" &&
      installation.endpoint === subscription.endpoint && installationMatchesCurrentIntent(installation) &&
      !reconciliationError
    );
    enableButton.textContent = active ? "Save selections" : "Enable notifications";
    disableButton.hidden = !(installation || subscription);
    if (!(options && options.preserveStatus)) {
      status.textContent = reconciliationError
        ? "Alert settings could not be synced. Open this panel while online to retry."
        : active
          ? "Notifications are on for this device."
          : Notification.permission === "denied"
          ? "Notifications are blocked in your browser settings."
          : installation
            ? "Alert settings need to be re-enabled on this device."
            : "Notifications are off.";
    }
  }

  async function createSubscription(registration) {
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(config.vapidPublicKey),
    });
  }

  async function replaceSubscription(registration, subscription) {
    if (subscription) {
      try { await subscription.unsubscribe(); } catch (_error) {}
    }
    var current = await registration.pushManager.getSubscription();
    return current || await createSubscription(registration);
  }

  function isStaleInstallationError(error) {
    return error.code === "stale_installation" ||
      (error.status === 401 && error.message === "Invalid installation credentials.");
  }

  function sameCredentials(left, right) {
    return Boolean(left && right && left.installationId === right.installationId &&
      left.managementSecret === right.managementSecret);
  }

  function addCleanupCredentials(intent, installation) {
    if (!intent || !installation) return;
    var cleanup = Array.isArray(intent.cleanupCredentials) ? intent.cleanupCredentials : [];
    if (!cleanup.some(function (candidate) { return sameCredentials(candidate, installation); })) {
      cleanup.push({
        installationId: installation.installationId,
        managementSecret: installation.managementSecret,
      });
    }
    intent.cleanupCredentials = cleanup;
    if (intentIsCurrent(intent)) {
      localStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));
    }
  }

  async function settleSupersededInstallation(registration, subscription, savedInstallation) {
    localStorage.setItem(PROVISIONAL_STORAGE_KEY, JSON.stringify(savedInstallation));
    var intent = readIntent();
    if (!intent || intent.kind !== "disable") {
      return { installation: readInstallation(), subscription: subscription };
    }

    addCleanupCredentials(intent, savedInstallation);
    try {
      await api("/disable", savedInstallation);
      localStorage.removeItem(PROVISIONAL_STORAGE_KEY);
    } catch (_error) {
      // The current Disable action will retry the retained credentials under
      // the same origin-wide lock, or a later Disable can retry them.
    }
    try {
      var current = await registration.pushManager.getSubscription();
      if (current) await current.unsubscribe();
    } catch (_error) {}
    localStorage.removeItem(STORAGE_KEY);
    return { installation: null, subscription: null };
  }

  async function cleanupDisableIntent(intent, localCleanupSettled) {
    return await withNotificationLock(async function () {
      if (localCleanupSettled) await localCleanupSettled;
      var currentIntent = readIntent();
      if (!currentIntent || currentIntent.token !== intent.token || currentIntent.kind !== "disable") {
        return { disabled: true, error: null, superseded: true };
      }

      var candidates = Array.isArray(currentIntent.cleanupCredentials)
        ? currentIntent.cleanupCredentials.slice() : [];
      [readInstallation(), readProvisionalInstallation()].forEach(function (candidate) {
        if (candidate && !candidates.some(function (existing) { return sameCredentials(existing, candidate); })) {
          candidates.push(candidate);
        }
      });
      var remoteError = null;
      var failedCleanup = [];
      for (var candidate of candidates) {
        try {
          await api("/disable", candidate);
        } catch (error) {
          if (!remoteError) remoteError = error;
          failedCleanup.push(candidate);
        }
      }
      if (!intentIsCurrent(currentIntent)) {
        return { disabled: true, error: null, superseded: true };
      }

      try {
        var currentRegistration = isSupported() ? await navigator.serviceWorker.getRegistration() : null;
        var currentSubscription = currentRegistration
          ? await currentRegistration.pushManager.getSubscription() : null;
        if (currentSubscription) await currentSubscription.unsubscribe();
      } catch (error) {
        if (!remoteError) remoteError = error;
      }
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PROVISIONAL_STORAGE_KEY);
      currentIntent.cleanupCredentials = failedCleanup;
      completeIntent(currentIntent);
      return { disabled: !remoteError, error: remoteError };
    });
  }

  function reconciliationIsCurrent(generation) {
    return generation === installationGeneration;
  }

  async function reconcileInstallation(registration, subscription, installation, refreshGeneration) {
    if (userActionInProgress || !reconciliationIsCurrent(refreshGeneration)) {
      return { installation: readInstallation(), subscription: subscription };
    }
    var visibleIntent = readIntent();
    if (visibleIntent && (visibleIntent.kind === "disable" || intentIsPending(visibleIntent))) {
      return { installation: visibleIntent.kind === "disable" ? null : readInstallation(), subscription: subscription };
    }
    installation = readInstallation() || installation;
    var endpointChanged = installation.endpoint !== subscription.endpoint;
    var visibleIntentMatches = !visibleIntent || installation.intentToken === visibleIntent.token;
    if (!endpointChanged && visibleIntentMatches &&
        Date.now() - Number(installation.validatedAt || 0) < RECONCILE_INTERVAL_MS) {
      return { installation: installation, subscription: subscription };
    }
    if (reconciliationPromise) return await reconciliationPromise;

    reconciliationPromise = withNotificationLock(async function () {
      var generation = refreshGeneration;
      var currentSubscription = await registration.pushManager.getSubscription();
      if (userActionInProgress || !reconciliationIsCurrent(generation)) {
        return { installation: readInstallation(), subscription: currentSubscription };
      }
      var operationIntent = readIntent();
      if (operationIntent && (operationIntent.kind === "disable" || intentIsPending(operationIntent))) {
        return {
          installation: operationIntent.kind === "disable" ? null : readInstallation(),
          subscription: currentSubscription,
        };
      }
      var currentInstallation = candidateInstallation(currentSubscription);
      if (!currentInstallation || !currentSubscription) {
        return { installation: currentInstallation, subscription: currentSubscription };
      }
      endpointChanged = currentInstallation.endpoint !== currentSubscription.endpoint;
      var operationIntentMatches = !operationIntent || currentInstallation.intentToken === operationIntent.token;
      if (!endpointChanged && operationIntentMatches &&
          Date.now() - Number(currentInstallation.validatedAt || 0) < RECONCILE_INTERVAL_MS) {
        return { installation: currentInstallation, subscription: currentSubscription };
      }

      var selected = normalizeThresholds(
        operationIntent && operationIntent.kind === "enable"
          ? operationIntent.thresholds : currentInstallation.thresholds,
      );
      if (!selected.length) throw new Error("Stored alert settings are incomplete.");
      var result;
      try {
        result = await api("/subscribe", {
          installationId: currentInstallation.installationId,
          managementSecret: currentInstallation.managementSecret,
          subscription: subscriptionJson(currentSubscription),
          thresholds: selected,
        });
      } catch (error) {
        if (!isStaleInstallationError(error)) throw error;
        if (userActionInProgress || !reconciliationIsCurrent(generation) ||
            !intentTokenIsUnchanged(operationIntent)) {
          return { installation: readInstallation(), subscription: currentSubscription };
        }
        currentSubscription = await replaceSubscription(registration, currentSubscription);
        if (!intentTokenIsUnchanged(operationIntent)) {
          var supersedingIntent = readIntent();
          if (supersedingIntent && supersedingIntent.kind === "disable") {
            try { await currentSubscription.unsubscribe(); } catch (_error) {}
            localStorage.removeItem(STORAGE_KEY);
          }
          return { installation: readInstallation(), subscription: null };
        }
        currentInstallation = null;
        result = await api("/subscribe", {
          installationId: null,
          managementSecret: null,
          subscription: subscriptionJson(currentSubscription),
          thresholds: selected,
        });
      }

      var managementSecret = result.managementSecret ||
        (currentInstallation ? currentInstallation.managementSecret : null);
      if (!result.installationId || !managementSecret) {
        throw new Error("Notification service returned incomplete installation credentials.");
      }
      var savedInstallation = {
        installationId: result.installationId,
        managementSecret: managementSecret,
        thresholds: selected,
        endpoint: currentSubscription.endpoint,
        validatedAt: Date.now(),
        intentToken: operationIntent ? operationIntent.token : null,
      };
      if (!intentTokenIsUnchanged(operationIntent)) {
        return await settleSupersededInstallation(registration, currentSubscription, savedInstallation);
      }
      writeInstallation(savedInstallation);
      localStorage.removeItem(PROVISIONAL_STORAGE_KEY);
      return { installation: savedInstallation, subscription: currentSubscription };
    });

    try {
      return await reconciliationPromise;
    } finally {
      reconciliationPromise = null;
    }
  }

  async function enableNotifications() {
    var thresholds = selectedThresholds();
    if (!thresholds.length) {
      status.textContent = "Select at least one heat level first.";
      return;
    }
    if (!isSupported()) {
      status.textContent = "This browser does not support Web Push notifications.";
      return;
    }
    if (!config.vapidPublicKey || !config.edgeFunctionUrl) {
      status.textContent = "Notification service is not configured yet.";
      return;
    }
    var intent = beginIntent("enable", thresholds, []);
    installationGeneration += 1;
    userActionInProgress = true;
    setBusy(true);
    try {
      var permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      var registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      var saved = await withNotificationLock(async function () {
        if (!intentIsCurrent(intent)) return false;
        var subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          subscription = await createSubscription(registration);
        }
        if (!intentIsCurrent(intent)) return false;
        var installation = candidateInstallation(subscription);
        var requestBody = {
          installationId: installation ? installation.installationId : null,
          managementSecret: installation ? installation.managementSecret : null,
          subscription: subscriptionJson(subscription),
          thresholds: thresholds,
        };
        var result;
        try {
          result = await api("/subscribe", requestBody);
        } catch (error) {
          // A 404/410 push response removes the server row, but mobile browsers
          // can retain both the dead PushSubscription and its local credentials.
          // Replace the endpoint and enroll it as a fresh installation.
          var staleInstallation = isStaleInstallationError(error);
          if (!installation || !staleInstallation) throw error;
          if (!intentIsCurrent(intent)) return false;
          subscription = await replaceSubscription(registration, subscription);
          if (!intentIsCurrent(intent)) return false;
          installation = null;
          result = await api("/subscribe", {
            installationId: null,
            managementSecret: null,
            subscription: subscriptionJson(subscription),
            thresholds: thresholds,
          });
        }
        var managementSecret = result.managementSecret || (installation ? installation.managementSecret : null);
        if (!result.installationId || !managementSecret) {
          throw new Error("Notification service returned incomplete installation credentials.");
        }
        var savedInstallation = {
          installationId: result.installationId,
          managementSecret: managementSecret,
          thresholds: thresholds,
          endpoint: subscription.endpoint,
          validatedAt: Date.now(),
          intentToken: intent.token,
        };
        if (!intentIsCurrent(intent)) {
          await settleSupersededInstallation(registration, subscription, savedInstallation);
          return false;
        }
        writeInstallation(savedInstallation);
        localStorage.removeItem(PROVISIONAL_STORAGE_KEY);
        return true;
      });
      if (!saved) {
        status.textContent = "Notification settings changed in another app window.";
        return;
      }
      selectionsDirty = false;
      status.textContent = "Notifications enabled for " + thresholds.length + " heat level" + (thresholds.length === 1 ? "." : "s.");
    } catch (error) {
      status.textContent = error.message || "Could not enable notifications.";
    } finally {
      completeIntent(intent);
      userActionInProgress = false;
      setBusy(false);
      refreshState({ preserveStatus: true, skipReconciliation: true }).catch(function () {});
    }
  }

  async function disableNotifications() {
    var installation = readInstallation();
    var provisionalInstallation = readProvisionalInstallation();
    var priorIntent = readIntent();
    var cleanupCredentials = priorIntent && Array.isArray(priorIntent.cleanupCredentials)
      ? priorIntent.cleanupCredentials.slice() : [];
    [installation, provisionalInstallation].forEach(function (candidate) {
      if (candidate && !cleanupCredentials.some(function (existing) { return sameCredentials(existing, candidate); })) {
        cleanupCredentials.push({
          installationId: candidate.installationId,
          managementSecret: candidate.managementSecret,
        });
      }
    });
    var intent = beginIntent("disable", [], cleanupCredentials);
    installationGeneration += 1;
    userActionInProgress = true;
    setBusy(true);
    var localDisabled = !isSupported();
    var firstError = null;
    var resolveLocalCleanup;
    var localCleanupSettled = new Promise(function (resolve) { resolveLocalCleanup = resolve; });
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROVISIONAL_STORAGE_KEY);
    applyThresholds([]);
    selectionsDirty = false;
    status.textContent = "Notifications are off.";

    // Keep local cleanup immediate. The origin-wide lock makes remote cleanup
    // run after any older repair and re-read credentials that repair produced.
    // A newer Enable action cannot inspect PushManager until this local
    // unsubscribe has settled because cleanup holds the shared mutation lock.
    var remoteRequest = cleanupDisableIntent(intent, localCleanupSettled);
    try {
      try {
        var registration = isSupported() ? await navigator.serviceWorker.getRegistration() : null;
        var subscription = registration ? await registration.pushManager.getSubscription() : null;
        if (subscription) {
          await subscription.unsubscribe();
          localDisabled = !(await registration.pushManager.getSubscription());
        } else {
          localDisabled = true;
        }
      } catch (error) {
        firstError = error;
      } finally {
        resolveLocalCleanup();
      }

      // Removing either side is sufficient to stop delivery. In particular,
      // a stale/missing server row must never prevent local cleanup.
      if (!localDisabled) {
        var remoteResult = await remoteRequest;
        if (!remoteResult.disabled) throw firstError || remoteResult.error || new Error("Could not disable notifications.");
      }
    } catch (error) {
      status.textContent = error.message || "Could not disable notifications.";
    } finally {
      userActionInProgress = false;
      setBusy(false);
      refreshState({ preserveStatus: true, skipReconciliation: true }).catch(function () {});
    }
  }

  if (isIos() && !isStandalone()) {
    platformNote.hidden = false;
    platformNote.textContent = "On iPhone and iPad, add this app to your Home Screen before enabling notifications.";
  } else if (!isSupported()) {
    platformNote.hidden = false;
    platformNote.textContent = "This browser does not support Web Push notifications.";
  }

  openButton.addEventListener("click", function () {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    selectionsDirty = false;
    refreshState().catch(function () {});
  });
  thresholdInputs.forEach(function (input) {
    input.addEventListener("change", function () { selectionsDirty = true; });
  });
  enableButton.addEventListener("click", enableNotifications);
  disableButton.addEventListener("click", disableNotifications);
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close();
  });
  window.addEventListener("focus", function () {
    refreshState().catch(function () {});
  });
  refreshState().catch(function () {});

  if (typeof module !== "undefined") {
    module.exports = { normalizeThresholds: normalizeThresholds, base64UrlToUint8Array: base64UrlToUint8Array };
  }
})();
