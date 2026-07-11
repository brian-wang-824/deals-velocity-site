self.addEventListener("push", function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_err) { payload = {}; }
  var title = payload.title || "Deal velocity alert";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || "A deal reached one of your selected stamps.",
    icon: payload.icon || "/icons/app-icon-192.png",
    badge: "/icons/notification-badge.png",
    tag: payload.tag || "deal-velocity-alert",
    renotify: false,
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/";
  event.waitUntil(clients.openWindow(url));
});
