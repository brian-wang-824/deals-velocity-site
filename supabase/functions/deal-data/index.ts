import { createClient } from "npm:@supabase/supabase-js@2";
import {
  MAX_JSON_BYTES,
  PublicationValidationError,
  RETAIN_PUBLICATIONS,
  RETENTION_BATCH_SIZE,
  buildObjectPaths,
  canonicalJson,
  compactStateMatchesScrapedAt,
  expiredPublications,
  publicationMatches,
  resolveAdminKey,
  sha256Hex,
  utf8Bytes,
  validateCompactState,
  validatePublicationBody,
} from "./logic.mjs";

const PUBLIC_BUCKET = "deal-snapshots";
const STATE_BUCKET = "deal-state";
const PUBLICATION_TABLE = "deal_data_publications";
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;

const supabaseUrl = String(Deno.env.get("SUPABASE_URL") || "").trim();
if (!supabaseUrl) throw new Error("Deal-data requires SUPABASE_URL.");
const supabase = createClient(
  supabaseUrl,
  resolveAdminKey((name: string) => Deno.env.get(name)),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type PublicationMetadata = {
  version: string;
  parentVersion: string | null;
  scrapedAt: string;
  snapshotPath: string;
  statePath: string;
  snapshotSha256: string;
  stateSha256: string;
  dealCount: number;
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function secretsMatch(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (!provided || !expected) return false;
  const [providedHash, expectedHash] = await Promise.all([sha256Hex(provided), sha256Hex(expected)]);
  let mismatch = 0;
  for (let index = 0; index < expectedHash.length; index += 1) {
    mismatch |= providedHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return mismatch === 0;
}

async function transformBytes(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const input = new Blob([bytes]).stream();
  const output = input.pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return transformBytes(bytes, new CompressionStream("gzip"));
}

function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return transformBytes(bytes, new DecompressionStream("gzip"));
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function isAlreadyExists(error: any): boolean {
  const status = String(error?.statusCode || error?.status || "");
  const message = String(error?.message || error || "").toLowerCase();
  return status === "409" || message.includes("already exists") || message.includes("duplicate");
}

async function downloadObject(bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Could not download an existing ${bucket} object.`);
  return await blobBytes(data);
}

async function uploadImmutable(
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
  cacheControl: string,
  verifyExisting: (existing: Uint8Array) => Promise<boolean>,
): Promise<boolean> {
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, {
    contentType,
    cacheControl,
    upsert: false,
  });
  if (!error) return true;
  if (!isAlreadyExists(error)) throw new Error(`Could not upload the ${bucket} object.`);

  const existing = await downloadObject(bucket, path);
  if (!await verifyExisting(existing)) {
    throw new HttpError(409, "An immutable object path already contains different data.");
  }
  return false;
}

async function removeObjectQuietly(bucket: string, path: string): Promise<boolean> {
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) {
    console.error("Deal-data retention could not remove an object", {
      bucket,
      path,
      code: error.name,
      message: error.message,
    });
    return false;
  }
  return true;
}

async function findPublication(version: string): Promise<any | null> {
  const { data, error } = await supabase.from(PUBLICATION_TABLE).select("*")
    .eq("version", version).maybeSingle();
  if (error) throw error;
  return data;
}

async function cleanupCreatedObjects(
  metadata: PublicationMetadata,
  snapshotCreated: boolean,
  stateCreated: boolean,
): Promise<void> {
  try {
    if (snapshotCreated) await removeObjectQuietly(PUBLIC_BUCKET, metadata.snapshotPath);
    if (stateCreated) await removeObjectQuietly(STATE_BUCKET, metadata.statePath);
  } catch (error) {
    console.error("Could not clean up an unregistered deal-data upload", {
      version: metadata.version,
      error: String(error),
    });
  }
}

async function cleanupExpiredPublications(): Promise<void> {
  try {
    const { data, error } = await supabase.from(PUBLICATION_TABLE)
      .select("version,scraped_at,snapshot_path,state_path")
      .order("scraped_at", { ascending: false })
      .limit(RETAIN_PUBLICATIONS + RETENTION_BATCH_SIZE);
    if (error) {
      console.error("Deal-data retention could not list publications", { code: error.code, message: error.message });
      return;
    }

    for (const publication of expiredPublications(data || []).slice(0, RETENTION_BATCH_SIZE)) {
      try {
        const snapshotRemoved = await removeObjectQuietly(PUBLIC_BUCKET, publication.snapshot_path);
        const stateRemoved = await removeObjectQuietly(STATE_BUCKET, publication.state_path);
        if (!snapshotRemoved || !stateRemoved) continue;

        const { error: deleteError } = await supabase.from(PUBLICATION_TABLE).delete()
          .eq("version", publication.version);
        if (deleteError) {
          console.error("Deal-data retention could not delete publication metadata", {
            version: publication.version,
            code: deleteError.code,
            message: deleteError.message,
          });
        }
      } catch (error) {
        console.error("Unexpected deal-data retention row error", {
          version: publication.version,
          error: String(error),
        });
      }
    }
  } catch (error) {
    console.error("Unexpected deal-data retention error", error);
  }
}

function scheduleRetentionCleanup(): void {
  const edgeRuntime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  }).EdgeRuntime;
  if (!edgeRuntime) {
    // Hosted Supabase Edge Functions provide this global. Keeping the guard
    // makes local parsing/test runtimes fail harmlessly instead of affecting
    // an already durable publication.
    console.error("EdgeRuntime.waitUntil is unavailable; retention was not scheduled.");
    return;
  }
  const task = cleanupExpiredPublications().catch((error) => {
    console.error("Unhandled deal-data retention error", error);
  });
  try {
    edgeRuntime.waitUntil(task);
  } catch (error) {
    // Registration is already durable. A runtime scheduling failure must not
    // turn a successful publish into an error or remove referenced objects.
    console.error("Could not schedule deal-data retention", error);
  }
}

async function getState(): Promise<Response> {
  const { data: publications, error } = await supabase.from(PUBLICATION_TABLE)
    .select("version,scraped_at,state_path,state_sha256")
    .order("scraped_at", { ascending: false })
    .limit(RETAIN_PUBLICATIONS);
  if (error) throw error;
  if (!publications?.length) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  const parentVersion = publications[0].version;
  for (const publication of publications) {
    try {
      const compressed = await downloadObject(STATE_BUCKET, publication.state_path);
      const stateBytes = await gunzip(compressed);
      if (await sha256Hex(stateBytes) !== publication.state_sha256) {
        throw new Error("State integrity check failed.");
      }
      const state = JSON.parse(new TextDecoder().decode(stateBytes));
      validateCompactState(state);
      if (!compactStateMatchesScrapedAt(state, publication.scraped_at)) {
        throw new Error("State lineage timestamp does not match its publication.");
      }
      return jsonResponse({
        parent_version: parentVersion,
        state_version: publication.version,
        state,
      });
    } catch (error) {
      console.error("Skipping invalid retained deal state", {
        version: publication.version,
        error: String(error),
      });
    }
  }
  throw new Error("No valid retained deal state is available.");
}

async function publish(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "Content-Type must be application/json.");
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Publication request is too large.");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (_error) {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  const { parentVersion, snapshot, state } = validatePublicationBody(body);
  const snapshotBytes = utf8Bytes(canonicalJson(snapshot));
  const stateBytes = utf8Bytes(canonicalJson(state));
  if (snapshotBytes.byteLength > MAX_JSON_BYTES || stateBytes.byteLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "Snapshot or state exceeds the storage size limit.");
  }
  if (snapshotBytes.byteLength + stateBytes.byteLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Combined snapshot and state are too large.");
  }

  const [snapshotSha256, stateSha256] = await Promise.all([
    sha256Hex(snapshotBytes),
    sha256Hex(stateBytes),
  ]);
  const { snapshotPath, statePath } = buildObjectPaths(snapshot.scraped_at, snapshotSha256, stateSha256);
  const metadata: PublicationMetadata = {
    version: snapshotSha256,
    parentVersion,
    scrapedAt: snapshot.scraped_at,
    snapshotPath,
    statePath,
    snapshotSha256,
    stateSha256,
    dealCount: snapshot.count,
  };

  const prior = await findPublication(metadata.version);
  if (prior && !publicationMatches(prior, metadata)) {
    throw new HttpError(409, "Publication version conflicts with existing metadata.");
  }

  const compressedState = await gzip(stateBytes);
  if (compressedState.byteLength > MAX_JSON_BYTES) throw new HttpError(413, "Compressed state exceeds the storage size limit.");

  let snapshotCreated = false;
  let stateCreated = false;
  let registered = false;
  try {
    snapshotCreated = await uploadImmutable(
      PUBLIC_BUCKET,
      metadata.snapshotPath,
      snapshotBytes,
      "application/json",
      "31536000",
      async (existing) => await sha256Hex(existing) === metadata.snapshotSha256,
    );
    stateCreated = await uploadImmutable(
      STATE_BUCKET,
      metadata.statePath,
      compressedState,
      "application/gzip",
      "3600",
      async (existing) => {
        try {
          return await sha256Hex(await gunzip(existing)) === metadata.stateSha256;
        } catch (_error) {
          return false;
        }
      },
    );

    const { data: inserted, error: registrationError } = await supabase.rpc(
      "register_deal_data_publication",
      {
        target_version: metadata.version,
        target_parent_version: metadata.parentVersion,
        target_scraped_at: metadata.scrapedAt,
        target_snapshot_path: metadata.snapshotPath,
        target_state_path: metadata.statePath,
        target_snapshot_sha256: metadata.snapshotSha256,
        target_state_sha256: metadata.stateSha256,
        target_deal_count: metadata.dealCount,
      },
    );
    if (registrationError) {
      const concurrent = await findPublication(metadata.version);
      if (concurrent && publicationMatches(concurrent, metadata)) {
        scheduleRetentionCleanup();
        return jsonResponse({
          ok: true,
          published: false,
          version: metadata.version,
          snapshot_path: metadata.snapshotPath,
          scraped_at: metadata.scrapedAt,
        });
      }
      console.error("Deal-data publication registration failed", {
        code: registrationError.code,
        message: registrationError.message,
      });
      throw new HttpError(409, "Publication is stale or conflicts with the current version.");
    }
    registered = true;

    scheduleRetentionCleanup();
    return jsonResponse({
      ok: true,
      published: Boolean(inserted),
      version: metadata.version,
      snapshot_path: metadata.snapshotPath,
      scraped_at: metadata.scrapedAt,
    });
  } catch (error) {
    if (!registered) await cleanupCreatedObjects(metadata, snapshotCreated, stateCreated);
    throw error;
  }
}

Deno.serve(async (req) => {
  if (!await secretsMatch(req.headers.get("x-deal-data-secret"), Deno.env.get("DEAL_DATA_PUBLISH_SECRET"))) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  try {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (req.method === "GET" && path.endsWith("/state")) return await getState();
    if (req.method === "POST" && path.endsWith("/publish")) return await publish(req);
    return jsonResponse({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof PublicationValidationError) return jsonResponse({ error: error.message }, 400);
    if (error instanceof HttpError) return jsonResponse({ error: error.message }, error.status);
    console.error("Unexpected deal-data function error", error);
    return jsonResponse({ error: "Unexpected deal-data service error." }, 500);
  }
});
