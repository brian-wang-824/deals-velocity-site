const fs = require("fs");
const path = require("path");

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
  ["public/icons/notification-badge.png", "dist/icons/notification-badge.png"],
  ["public/assets/logo-mark.svg", "dist/assets/logo-mark.svg"],
];

const dataEnvironmentFields = [
  ["SUPABASE_DATA_PUBLICATION_URL", "publicationUrl"],
  ["SUPABASE_DATA_SNAPSHOT_BASE_URL", "snapshotBaseUrl"],
  ["SUPABASE_PUBLISHABLE_KEY", "publishableKey"],
];

function readDataConfig(env = process.env) {
  const dataConfig = Object.fromEntries(dataEnvironmentFields.map(([environmentName, configName]) => (
    [configName, String(env[environmentName] || "").trim()]
  )));
  const missing = dataEnvironmentFields
    .filter(([_environmentName, configName]) => !dataConfig[configName])
    .map(([environmentName]) => environmentName);

  if (env.RENDER === "true" && missing.length) {
    throw new Error(`Missing required Render deal-data environment variables: ${missing.join(", ")}`);
  }

  return dataConfig;
}

function buildAssets(options = {}) {
  const root = options.root || path.resolve(__dirname, "..");
  const env = options.env || process.env;

  // Validate required production configuration before touching dist. Local
  // builds intentionally retain empty values so tests and static previews do
  // not need live Supabase credentials.
  const dataConfig = readDataConfig(env);
  const dist = path.join(root, "dist");

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
    edgeFunctionUrl: env.SUPABASE_NOTIFICATION_FUNCTION_URL || "",
    vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
  };
  fs.writeFileSync(
    path.join(dist, "notification-config.js"),
    `window.NOTIFICATION_CONFIG = ${JSON.stringify(notificationConfig)};\n`,
  );

  fs.writeFileSync(
    path.join(dist, "data-config.js"),
    `window.DATA_CONFIG = ${JSON.stringify(dataConfig)};\n`,
  );
}

if (require.main === module) buildAssets();

module.exports = { buildAssets, readDataConfig };
