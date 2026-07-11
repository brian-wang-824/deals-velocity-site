const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const copies = [
  ["src/index.html", "dist/index.html"],
  ["public/app.js", "dist/app.js"],
  ["public/notifications.js", "dist/notifications.js"],
  ["public/service-worker.js", "dist/service-worker.js"],
  ["public/favicon.svg", "dist/favicon.svg"],
  ["public/favicon.ico", "dist/favicon.ico"],
  ["public/apple-touch-icon.png", "dist/apple-touch-icon.png"],
  ["public/manifest.webmanifest", "dist/manifest.webmanifest"],
  ["public/icons/app-icon-192.png", "dist/icons/app-icon-192.png"],
  ["public/icons/app-icon-512.png", "dist/icons/app-icon-512.png"],
  ["public/icons/app-icon-maskable-192.png", "dist/icons/app-icon-maskable-192.png"],
  ["public/icons/app-icon-maskable-512.png", "dist/icons/app-icon-maskable-512.png"],
  ["public/icons/app-icon-maskable.svg", "dist/icons/app-icon-maskable.svg"],
  ["public/assets/logo-mark.svg", "dist/assets/logo-mark.svg"],
  ["public/data/deals.json", "dist/data/deals.json"],
];

// Tailwind writes style.css before this script runs. Remove every other stale
// build artifact so deleted source assets cannot linger in dist.
if (fs.existsSync(dist)) {
  for (const entry of fs.readdirSync(dist)) {
    if (entry !== "style.css") {
      fs.rmSync(path.join(dist, entry), { recursive: true, force: true });
    }
  }
}

for (const [from, to] of copies) {
  const source = path.join(root, from);
  const target = path.join(root, to);

  if (!fs.existsSync(source)) {
    throw new Error(`Missing required build asset: ${from}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

const notificationConfig = {
  edgeFunctionUrl: process.env.SUPABASE_NOTIFICATION_FUNCTION_URL || "",
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
};
fs.writeFileSync(
  path.join(dist, "notification-config.js"),
  `window.NOTIFICATION_CONFIG = ${JSON.stringify(notificationConfig)};\n`,
);
