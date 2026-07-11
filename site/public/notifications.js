(function () {
  "use strict";

  var STORAGE_KEY = "deal-alert-installation-v1";
  var ALLOWED_THRESHOLDS = ["warming", "hot", "surging", "blazing", "on fire", "inferno"];
  var config = window.NOTIFICATION_CONFIG || {};
  var dialog = document.getElementById("notification-settings");
  var openButton = document.getElementById("notification-settings-button");
  var enableButton = document.getElementById("notification-enable");
  var disableButton = document.getElementById("notification-disable");
  var status = document.getElementById("notification-status");
  var platformNote = document.getElementById("notification-platform-note");
  var thresholdInputs = Array.prototype.slice.call(
    document.querySelectorAll("#notification-thresholds input[type=checkbox]"),
  );

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

  function readInstallation() {
    try {
      var value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return value && value.installationId && value.managementSecret ? value : null;
    } catch (_err) {
      return null;
    }
  }

  function writeInstallation(value) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
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
    var response = await fetch(config.edgeFunctionUrl.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(result.error || "Notification service request failed.");
    return result;
  }

  function setBusy(busy) {
    enableButton.disabled = busy;
    disableButton.disabled = busy;
    thresholdInputs.forEach(function (input) { input.disabled = busy; });
  }

  async function refreshState() {
    var installation = readInstallation();
    var registration = isSupported() ? await navigator.serviceWorker.getRegistration() : null;
    var subscription = registration ? await registration.pushManager.getSubscription() : null;
    var active = Boolean(installation && subscription && Notification.permission === "granted");
    enableButton.textContent = active ? "Save selections" : "Enable notifications";
    disableButton.hidden = !active;
    status.textContent = active
      ? "Notifications are on for this device."
      : Notification.permission === "denied"
        ? "Notifications are blocked in your browser settings."
        : "Notifications are off.";
    if (installation) {
      var thresholds = normalizeThresholds(installation.thresholds);
      thresholdInputs.forEach(function (input) { input.checked = thresholds.indexOf(input.value) !== -1; });
    }
  }

  async function enableNotifications() {
    var thresholds = selectedThresholds();
    if (!thresholds.length) {
      status.textContent = "Select at least one stamp first.";
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
    setBusy(true);
    try {
      var permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      var registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      var subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(config.vapidPublicKey),
        });
      }
      var installation = readInstallation();
      var result = await api("/subscribe", {
        installationId: installation ? installation.installationId : null,
        managementSecret: installation ? installation.managementSecret : null,
        subscription: subscriptionJson(subscription),
        thresholds: thresholds,
      });
      writeInstallation({
        installationId: result.installationId,
        managementSecret: result.managementSecret || installation.managementSecret,
        thresholds: thresholds,
      });
      status.textContent = "Notifications enabled for " + thresholds.length + " stamp" + (thresholds.length === 1 ? "." : "s.");
    } catch (error) {
      status.textContent = error.message || "Could not enable notifications.";
    } finally {
      setBusy(false);
      refreshState().catch(function () {});
    }
  }

  async function disableNotifications() {
    var installation = readInstallation();
    setBusy(true);
    try {
      if (installation) {
        await api("/disable", installation);
      }
      var registration = isSupported() ? await navigator.serviceWorker.getRegistration() : null;
      var subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (subscription) await subscription.unsubscribe();
      localStorage.removeItem(STORAGE_KEY);
      thresholdInputs.forEach(function (input) { input.checked = false; });
      status.textContent = "Notifications are off.";
    } catch (error) {
      status.textContent = error.message || "Could not disable notifications.";
    } finally {
      setBusy(false);
      refreshState().catch(function () {});
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
    refreshState().catch(function () {});
  });
  enableButton.addEventListener("click", enableNotifications);
  disableButton.addEventListener("click", disableNotifications);
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close();
  });

  if (typeof module !== "undefined") {
    module.exports = { normalizeThresholds: normalizeThresholds, base64UrlToUint8Array: base64UrlToUint8Array };
  }
})();
