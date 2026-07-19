export const STATE_SCHEMA_VERSION = 1;
export const MAX_STATE_SNAPSHOTS = 48;
export const MAX_DEALS = 1000;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const RETAIN_PUBLICATIONS = 48;
export const RETENTION_BATCH_SIZE = 3;

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEAL_FIELDS = [
  "comments",
  "discount_percentage",
  "found_by",
  "image_url",
  "is_new",
  "lifetime_velocity",
  "original_price",
  "posted_label",
  "posted_time",
  "posted_time_source",
  "price",
  "recent_velocity",
  "store",
  "thread_id",
  "title",
  "url",
  "velocity_label",
  "views",
  "vote_delta",
  "votes",
];
const VELOCITY_LABELS = new Set(["warming", "hot", "surging", "blazing", "on fire", "inferno"]);

export class PublicationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicationValidationError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new PublicationValidationError(message);
}

function hasOnlyKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNullableFiniteNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validateDeal(deal, index) {
  assert(isRecord(deal), `snapshot.deals[${index}] must be an object.`);
  assert(hasOnlyKeys(deal, DEAL_FIELDS), `snapshot.deals[${index}] has unexpected or missing fields.`);
  assert(
    typeof deal.thread_id === "string" && deal.thread_id.length > 0 && deal.thread_id.length <= 128,
    `snapshot.deals[${index}].thread_id must be a non-empty string.`,
  );
  for (const field of ["title", "url", "store"]) {
    assert(typeof deal[field] === "string", `snapshot.deals[${index}].${field} must be a string.`);
  }
  for (const field of [
    "price",
    "original_price",
    "posted_label",
    "posted_time_source",
    "found_by",
    "image_url",
  ]) {
    assert(isNullableString(deal[field]), `snapshot.deals[${index}].${field} must be a string or null.`);
  }
  assert(
    deal.posted_time === null || isIsoUtc(deal.posted_time),
    `snapshot.deals[${index}].posted_time must be a UTC ISO timestamp or null.`,
  );
  assert(Number.isSafeInteger(deal.votes), `snapshot.deals[${index}].votes must be an integer.`);
  assert(
    Number.isSafeInteger(deal.comments) && deal.comments >= 0,
    `snapshot.deals[${index}].comments must be a nonnegative integer.`,
  );
  assert(
    Number.isSafeInteger(deal.views) && deal.views >= 0,
    `snapshot.deals[${index}].views must be a nonnegative integer.`,
  );
  assert(typeof deal.is_new === "boolean", `snapshot.deals[${index}].is_new must be a boolean.`);
  for (const field of ["discount_percentage", "recent_velocity", "lifetime_velocity"]) {
    assert(
      isNullableFiniteNumber(deal[field]),
      `snapshot.deals[${index}].${field} must be a finite number or null.`,
    );
  }
  assert(
    deal.vote_delta === null || Number.isSafeInteger(deal.vote_delta),
    `snapshot.deals[${index}].vote_delta must be an integer or null.`,
  );
  assert(
    deal.velocity_label === null || VELOCITY_LABELS.has(deal.velocity_label),
    `snapshot.deals[${index}].velocity_label is invalid.`,
  );
}

export function isIsoUtc(value) {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

export function validateCompactState(state, expectedSnapshot) {
  assert(isRecord(state), "state must be an object.");
  assert(hasOnlyKeys(state, ["schema_version", "snapshots"]), "state has unexpected or missing fields.");
  assert(state.schema_version === STATE_SCHEMA_VERSION, "state.schema_version must be 1.");
  assert(Array.isArray(state.snapshots), "state.snapshots must be an array.");
  assert(state.snapshots.length >= 1, "state.snapshots must contain the current observation.");
  assert(
    state.snapshots.length <= MAX_STATE_SNAPSHOTS,
    `state.snapshots cannot exceed ${MAX_STATE_SNAPSHOTS} observations.`,
  );

  let previousTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < state.snapshots.length; index += 1) {
    const observation = state.snapshots[index];
    assert(isRecord(observation), `state.snapshots[${index}] must be an object.`);
    assert(
      hasOnlyKeys(observation, ["scraped_at", "votes"]),
      `state.snapshots[${index}] has unexpected or missing fields.`,
    );
    assert(isIsoUtc(observation.scraped_at), `state.snapshots[${index}].scraped_at must be a UTC ISO timestamp.`);
    const timestamp = Date.parse(observation.scraped_at);
    assert(timestamp > previousTime, "state snapshots must be strictly chronological.");
    previousTime = timestamp;

    assert(isRecord(observation.votes), `state.snapshots[${index}].votes must be an object.`);
    const entries = Object.entries(observation.votes);
    assert(entries.length <= MAX_DEALS, `state.snapshots[${index}].votes has too many deals.`);
    for (const [threadId, votes] of entries) {
      assert(threadId.length > 0 && threadId.length <= 128, "state vote thread IDs must be non-empty strings.");
      assert(Number.isSafeInteger(votes), `state vote count for ${threadId} must be an integer.`);
    }
  }

  if (expectedSnapshot !== undefined) {
    const latest = state.snapshots[state.snapshots.length - 1];
    assert(
      latest.scraped_at === expectedSnapshot.scraped_at,
      "the latest state observation must match snapshot.scraped_at.",
    );
    const latestEntries = Object.entries(latest.votes);
    assert(
      latestEntries.length === expectedSnapshot.deals.length,
      "the latest state observation must contain exactly the snapshot deals.",
    );
    for (const deal of expectedSnapshot.deals) {
      assert(
        Object.prototype.hasOwnProperty.call(latest.votes, deal.thread_id),
        `the latest state observation is missing deal ${deal.thread_id}.`,
      );
      assert(
        latest.votes[deal.thread_id] === deal.votes,
        `the latest state vote count does not match deal ${deal.thread_id}.`,
      );
    }
  }

  return state;
}

export function validatePublicationBody(body) {
  assert(isRecord(body), "request body must be an object.");
  assert(
    hasOnlyKeys(body, ["parent_version", "snapshot", "state"]),
    "request body has unexpected or missing fields.",
  );
  assert(
    body.parent_version === null || SHA256_PATTERN.test(body.parent_version),
    "parent_version must be null or a lowercase SHA-256 hash.",
  );
  const snapshot = body.snapshot;
  assert(isRecord(snapshot), "snapshot must be an object.");
  assert(
    hasOnlyKeys(snapshot, ["count", "deals", "scraped_at"]),
    "snapshot has unexpected or missing fields.",
  );
  assert(isIsoUtc(snapshot.scraped_at), "snapshot.scraped_at must be a UTC ISO timestamp.");
  assert(Array.isArray(snapshot.deals), "snapshot.deals must be an array.");
  assert(snapshot.deals.length <= MAX_DEALS, `snapshot.deals cannot exceed ${MAX_DEALS} entries.`);
  assert(Number.isSafeInteger(snapshot.count) && snapshot.count >= 0, "snapshot.count must be a nonnegative integer.");
  assert(snapshot.count === snapshot.deals.length, "snapshot.count must equal snapshot.deals.length.");

  const threadIds = new Set();
  for (let index = 0; index < snapshot.deals.length; index += 1) {
    const deal = snapshot.deals[index];
    validateDeal(deal, index);
    assert(!threadIds.has(deal.thread_id), `snapshot contains duplicate thread_id ${deal.thread_id}.`);
    threadIds.add(deal.thread_id);
  }

  validateCompactState(body.state, snapshot);
  return { parentVersion: body.parent_version, snapshot, state: body.state };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? utf8Bytes(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildObjectPaths(scrapedAt, snapshotSha256, stateSha256) {
  assert(isIsoUtc(scrapedAt), "cannot build paths for an invalid scraped_at timestamp.");
  assert(SHA256_PATTERN.test(snapshotSha256), "snapshot SHA-256 must be lowercase hexadecimal.");
  assert(SHA256_PATTERN.test(stateSha256), "state SHA-256 must be lowercase hexadecimal.");
  const date = new Date(scrapedAt);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const prefix = `v1/${year}/${month}/${day}`;
  return {
    snapshotPath: `${prefix}/${snapshotSha256}.json`,
    statePath: `${prefix}/${stateSha256}.json.gz`,
  };
}

export function publicationMatches(row, metadata) {
  return Boolean(row)
    && row.version === metadata.version
    && row.parent_version === metadata.parentVersion
    && Date.parse(row.scraped_at) === Date.parse(metadata.scrapedAt)
    && row.snapshot_path === metadata.snapshotPath
    && row.state_path === metadata.statePath
    && row.snapshot_sha256 === metadata.snapshotSha256
    && row.state_sha256 === metadata.stateSha256
    && row.deal_count === metadata.dealCount;
}

export function expiredPublications(rows, keep = RETAIN_PUBLICATIONS) {
  if (!Array.isArray(rows)) return [];
  return [...rows]
    .sort((left, right) => Date.parse(right.scraped_at) - Date.parse(left.scraped_at))
    .slice(keep);
}

export function compactStateMatchesScrapedAt(state, scrapedAt) {
  if (
    !isRecord(state)
    || !Array.isArray(state.snapshots)
    || !state.snapshots.length
    || typeof scrapedAt !== "string"
    || !Number.isFinite(Date.parse(scrapedAt))
  ) {
    return false;
  }
  const latest = state.snapshots[state.snapshots.length - 1];
  return isRecord(latest)
    && isIsoUtc(latest.scraped_at)
    && Date.parse(latest.scraped_at) === Date.parse(scrapedAt);
}

export function resolveAdminKey(getValue) {
  const legacy = String(getValue("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (legacy) return legacy;

  const encodedKeys = String(getValue("SUPABASE_SECRET_KEYS") || "").trim();
  if (encodedKeys) {
    let keys;
    try {
      keys = JSON.parse(encodedKeys);
    } catch (_error) {
      throw new Error("SUPABASE_SECRET_KEYS must be valid JSON.");
    }
    const current = isRecord(keys) ? String(keys.default || "").trim() : "";
    if (current) return current;
  }
  throw new Error("Deal-data requires SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEYS.default.");
}
