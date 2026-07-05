const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const copies = [
  ["src/index.html", "dist/index.html"],
  ["public/app.js", "dist/app.js"],
  ["public/data/deals.json", "dist/data/deals.json"],
];

for (const [from, to] of copies) {
  const source = path.join(root, from);
  const target = path.join(root, to);

  if (!fs.existsSync(source)) continue;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
