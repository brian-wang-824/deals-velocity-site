const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildAssets, readDataConfig } = require("../scripts/copy-assets.js");

function testMissingRenderConfigFailsBeforeDistMutation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deals-velocity-build-config-"));
  const dist = path.join(root, "dist");
  const sentinel = path.join(dist, "sentinel.txt");

  try {
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(sentinel, "untouched");

    assert.throws(
      () => buildAssets({
        root,
        env: {
          RENDER: "true",
          SUPABASE_DATA_PUBLICATION_URL: "   ",
          SUPABASE_DATA_SNAPSHOT_BASE_URL: "https://project.test/snapshots/",
        },
      }),
      (error) => (
        /SUPABASE_DATA_PUBLICATION_URL/.test(error.message) &&
        /SUPABASE_PUBLISHABLE_KEY/.test(error.message)
      ),
    );

    assert.strictEqual(fs.readFileSync(sentinel, "utf8"), "untouched");
    assert.deepStrictEqual(fs.readdirSync(dist), ["sentinel.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCompleteRenderConfigIsTrimmed() {
  assert.deepStrictEqual(
    readDataConfig({
      RENDER: "true",
      SUPABASE_DATA_PUBLICATION_URL: "  https://project.test/publication  ",
      SUPABASE_DATA_SNAPSHOT_BASE_URL: "  https://project.test/snapshots/  ",
      SUPABASE_PUBLISHABLE_KEY: "  sb_publishable_test  ",
    }),
    {
      publicationUrl: "https://project.test/publication",
      snapshotBaseUrl: "https://project.test/snapshots/",
      publishableKey: "sb_publishable_test",
    },
  );
}

function testLocalBuildAllowsEmptyConfig() {
  assert.deepStrictEqual(readDataConfig({}), {
    publicationUrl: "",
    snapshotBaseUrl: "",
    publishableKey: "",
  });
}

testMissingRenderConfigFailsBeforeDistMutation();
testCompleteRenderConfigIsTrimmed();
testLocalBuildAllowsEmptyConfig();
console.log("build config tests passed");
