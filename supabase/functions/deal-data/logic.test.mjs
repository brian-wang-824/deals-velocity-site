import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  MAX_STATE_SNAPSHOTS,
  PublicationValidationError,
  RETENTION_BATCH_SIZE,
  buildObjectPaths,
  canonicalJson,
  compactStateMatchesScrapedAt,
  expiredPublications,
  isIsoUtc,
  publicationMatches,
  resolveAdminKey,
  sha256Hex,
  utf8Bytes,
  validateCompactState,
  validatePublicationBody,
} from "./logic.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function deal(threadId, votes) {
  return {
    thread_id: threadId,
    title: `Deal ${threadId}`,
    url: `https://slickdeals.net/f/${threadId}`,
    store: "Example",
    price: "$10",
    original_price: null,
    discount_percentage: null,
    votes,
    comments: 2,
    views: 100,
    posted_label: "Today 12:00 PM",
    posted_time: "2026-07-18T12:00:00Z",
    posted_time_source: "card",
    found_by: null,
    is_new: false,
    image_url: null,
    recent_velocity: 12.5,
    lifetime_velocity: 8,
    vote_delta: 2,
    velocity_label: "hot",
  };
}

function validBody() {
  return {
    parent_version: null,
    snapshot: {
      scraped_at: "2026-07-18T12:13:16.858412Z",
      count: 2,
      deals: [deal("101", 12), deal("202", -1)],
    },
    state: {
      schema_version: 1,
      snapshots: [
        { scraped_at: "2026-07-18T12:03:16.000000Z", votes: { "101": 10 } },
        { scraped_at: "2026-07-18T12:13:16.858412Z", votes: { "101": 12, "202": -1 } },
      ],
    },
  };
}

assert.equal(isIsoUtc("2026-07-18T12:13:16.858412Z"), true);
assert.equal(isIsoUtc("2026-07-18T12:13:16+00:00"), false);
assert.equal(isIsoUtc("not-a-date"), false);

const validated = validatePublicationBody(validBody());
assert.equal(validated.parentVersion, null);
assert.equal(validated.snapshot.count, 2);
assert.equal(validated.state.snapshots.length, 2);

const duplicate = validBody();
duplicate.snapshot.deals[1].thread_id = "101";
assert.throws(() => validatePublicationBody(duplicate), PublicationValidationError);

const countMismatch = validBody();
countMismatch.snapshot.count = 1;
assert.throws(() => validatePublicationBody(countMismatch), /snapshot.count must equal/);

const extraBodyField = validBody();
extraBodyField.debug = true;
assert.throws(() => validatePublicationBody(extraBodyField), /request body has unexpected or missing fields/);

const invalidParent = validBody();
invalidParent.parent_version = "not-a-hash";
assert.throws(() => validatePublicationBody(invalidParent), /parent_version must be null or/);

const childPublication = validBody();
childPublication.parent_version = "a".repeat(64);
assert.equal(validatePublicationBody(childPublication).parentVersion, "a".repeat(64));

const extraSnapshotField = validBody();
extraSnapshotField.snapshot.schema_version = 1;
assert.throws(() => validatePublicationBody(extraSnapshotField), /snapshot has unexpected or missing fields/);

const missingDisplayField = validBody();
delete missingDisplayField.snapshot.deals[0].title;
assert.throws(() => validatePublicationBody(missingDisplayField), /unexpected or missing fields/);

const invalidDisplayType = validBody();
invalidDisplayType.snapshot.deals[0].posted_time = "yesterday";
assert.throws(() => validatePublicationBody(invalidDisplayType), /posted_time must be/);

const invalidVelocityLabel = validBody();
invalidVelocityLabel.snapshot.deals[0].velocity_label = "melting";
assert.throws(() => validatePublicationBody(invalidVelocityLabel), /velocity_label is invalid/);

const extraStateRootField = validBody();
extraStateRootField.state.current = 1;
assert.throws(() => validatePublicationBody(extraStateRootField), /state has unexpected or missing fields/);

const extraStateField = validBody();
extraStateField.state.snapshots[0].titles = {};
assert.throws(() => validatePublicationBody(extraStateField), /unexpected or missing fields/);

const latestVotesMismatch = validBody();
latestVotesMismatch.state.snapshots[1].votes["101"] = 11;
assert.throws(() => validatePublicationBody(latestVotesMismatch), /vote count does not match/);

const outOfOrder = validBody().state;
outOfOrder.snapshots.reverse();
assert.throws(() => validateCompactState(outOfOrder), /strictly chronological/);

const tooMuchState = validBody().state;
tooMuchState.snapshots = Array.from({ length: MAX_STATE_SNAPSHOTS + 1 }, (_, index) => ({
  scraped_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  votes: {},
}));
assert.throws(() => validateCompactState(tooMuchState), /cannot exceed/);

assert.equal(
  canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] }),
  '{"a":[{"c":3,"d":4}],"nested":{"a":1,"b":2},"z":1}',
);

const snapshotHash = await sha256Hex(utf8Bytes(canonicalJson(validBody().snapshot)));
const stateHash = await sha256Hex(utf8Bytes(canonicalJson(validBody().state)));
assert.match(snapshotHash, /^[0-9a-f]{64}$/);
assert.match(stateHash, /^[0-9a-f]{64}$/);
const paths = buildObjectPaths(validBody().snapshot.scraped_at, snapshotHash, stateHash);
assert.equal(paths.snapshotPath, `v1/2026/07/18/${snapshotHash}.json`);
assert.equal(paths.statePath, `v1/2026/07/18/${stateHash}.json.gz`);

const metadata = {
  version: snapshotHash,
  parentVersion: null,
  scrapedAt: "2026-07-18T12:13:16.858412Z",
  snapshotPath: paths.snapshotPath,
  statePath: paths.statePath,
  snapshotSha256: snapshotHash,
  stateSha256: stateHash,
  dealCount: 2,
};
assert.equal(publicationMatches({
  version: snapshotHash,
  parent_version: null,
  scraped_at: "2026-07-18T12:13:16.858412+00:00",
  snapshot_path: paths.snapshotPath,
  state_path: paths.statePath,
  snapshot_sha256: snapshotHash,
  state_sha256: stateHash,
  deal_count: 2,
}, metadata), true);
assert.equal(publicationMatches({
  version: snapshotHash,
  parent_version: "b".repeat(64),
  scraped_at: "2026-07-18T12:13:16.858412+00:00",
  snapshot_path: paths.snapshotPath,
  state_path: paths.statePath,
  snapshot_sha256: snapshotHash,
  state_sha256: stateHash,
  deal_count: 2,
}, metadata), false);
assert.equal(publicationMatches({ ...metadata, scraped_at: metadata.scrapedAt }, metadata), false);

const publications = Array.from({ length: 52 }, (_, index) => ({
  version: String(index),
  scraped_at: new Date(Date.UTC(2026, 6, 18, 0, index)).toISOString(),
})).reverse();
assert.deepEqual(expiredPublications(publications).map((row) => row.version), ["3", "2", "1", "0"]);
assert.deepEqual(
  expiredPublications(publications).slice(0, RETENTION_BATCH_SIZE).map((row) => row.version),
  ["3", "2", "1"],
);
assert.deepEqual(expiredPublications(null), []);

assert.equal(compactStateMatchesScrapedAt(validBody().state, "2026-07-18T12:13:16.858412+00:00"), true);
assert.equal(compactStateMatchesScrapedAt(validBody().state, "2026-07-18T12:03:16Z"), false);

assert.equal(resolveAdminKey((name) => ({
  SUPABASE_SERVICE_ROLE_KEY: " legacy-key ",
  SUPABASE_SECRET_KEYS: '{"default":"new-key"}',
})[name]), "legacy-key");
assert.equal(resolveAdminKey((name) => ({
  SUPABASE_SECRET_KEYS: '{"default":"new-key"}',
})[name]), "new-key");
assert.throws(() => resolveAdminKey(() => ""), /requires SUPABASE_SERVICE_ROLE_KEY/);
assert.throws(
  () => resolveAdminKey((name) => name === "SUPABASE_SECRET_KEYS" ? "not-json" : ""),
  /must be valid JSON/,
);

console.log("deal-data logic tests passed");
