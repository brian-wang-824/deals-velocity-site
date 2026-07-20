import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { enteredHigherHeat, normalizeThresholds, PUSH_DELIVERY_OPTIONS } from "./logic.mjs";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function thresholds(value: unknown): string[] {
  return normalizeThresholds(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authenticate(installationId: string, managementSecret: string) {
  if (!installationId || !managementSecret) return null;
  const { data, error } = await supabase.from("push_subscriptions").select("*")
    .eq("installation_id", installationId).maybeSingle();
  if (error) throw error;
  if (!data || data.management_secret_hash !== await sha256(managementSecret)) return null;
  return data;
}

async function installationExists(installationId: string): Promise<boolean> {
  if (!installationId) return false;
  const { data, error } = await supabase.from("push_subscriptions").select("id")
    .eq("installation_id", installationId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function subscribe(req: Request, body: any) {
  const selected = thresholds(body.thresholds);
  if (!selected.length) return response({ error: "Select at least one threshold." }, 400);
  const subscription = body.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return response({ error: "Invalid push subscription." }, 400);
  }

  let installationId = body.installationId as string | null;
  let managementSecret = body.managementSecret as string | null;
  let existing = installationId && managementSecret
    ? await authenticate(installationId, managementSecret) : null;
  if (installationId && !existing) {
    const stale = !await installationExists(installationId);
    return response({
      error: stale ? "This notification installation is no longer registered." : "Invalid installation credentials.",
      code: stale ? "stale_installation" : "invalid_installation_credentials",
    }, 401);
  }
  let newSecret: string | null = null;
  if (!existing) {
    installationId = crypto.randomUUID();
    managementSecret = randomSecret();
    newSecret = managementSecret;
  }

  const record = {
    installation_id: installationId,
    management_secret_hash: await sha256(managementSecret!),
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    expiration_time: subscription.expirationTime,
    thresholds: selected,
    enabled: true,
    user_agent: req.headers.get("user-agent"),
    updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };
  const query = existing
    ? supabase.from("push_subscriptions").update(record).eq("id", existing.id)
    : supabase.from("push_subscriptions").upsert(record, { onConflict: "endpoint" });
  const { error } = await query;
  if (error) {
    console.error("Could not save push subscription", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return response({ error: "Could not save subscription." }, 500);
  }
  return response({ installationId, managementSecret: newSecret });
}

async function disable(body: any) {
  const existing = await authenticate(body.installationId, body.managementSecret);
  if (!existing) {
    if (body.installationId && !await installationExists(body.installationId)) {
      return response({ ok: true, alreadyDisabled: true });
    }
    return response({ error: "Invalid installation credentials.", code: "invalid_installation_credentials" }, 401);
  }
  const { error } = await supabase.from("push_subscriptions").delete().eq("id", existing.id);
  if (error) {
    console.error("Could not disable push subscription", {
      code: error.code, message: error.message, details: error.details, hint: error.hint,
    });
    return response({ error: "Could not disable subscription." }, 500);
  }
  return response({ ok: true });
}

function notificationBody(deal: any): string {
  const details = [deal.store, deal.price].filter(Boolean).join(" · ");
  return details || "Tap to view this deal.";
}

async function markDelivery(subscriptionId: string, deal: any, values: Record<string, unknown>) {
  await supabase.from("notification_deliveries").update({ ...values, updated_at: new Date().toISOString() })
    .eq("subscription_id", subscriptionId).eq("thread_id", String(deal.thread_id))
    .eq("velocity_label", deal.velocity_label);
}

async function sendDelivery(subscription: any, deal: any): Promise<boolean> {
  try {
    await webpush.sendNotification({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    }, JSON.stringify({
      title: `${String(deal.velocity_label).toUpperCase()}: ${deal.title || "Deal alert"}`,
      body: notificationBody(deal), url: deal.url || "/",
      tag: `${deal.thread_id}:${deal.velocity_label}`,
      icon: deal.image_url || "/icons/app-icon-192.png",
    }), PUSH_DELIVERY_OPTIONS);
    await markDelivery(subscription.id, deal, {
      status: "delivered", delivered_at: new Date().toISOString(), error_message: null,
    });
    return true;
  } catch (error: any) {
    const permanent = error?.statusCode === 404 || error?.statusCode === 410;
    await markDelivery(subscription.id, deal, {
      status: permanent ? "failed_permanent" : "failed_transient",
      error_message: String(error?.message || error).slice(0, 1000),
    });
    if (permanent) await supabase.from("push_subscriptions").delete().eq("id", subscription.id);
    return false;
  }
}

async function processSnapshot(req: Request, body: any) {
  if (req.headers.get("x-scrape-secret") !== Deno.env.get("SCRAPE_DISPATCH_SECRET")) {
    return response({ error: "Unauthorized." }, 401);
  }
  if (!Array.isArray(body.deals) || !body.scraped_at) return response({ error: "Invalid snapshot." }, 400);
  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com",
    Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!,
  );

  let sent = 0;
  let failed = 0;
  const dealByDeliveryKey = new Map(body.deals.map((deal: any) => [
    `${String(deal.thread_id)}:${String(deal.velocity_label)}`, deal,
  ]));
  const { data: retries } = await supabase.from("notification_deliveries")
    .select("subscription_id,thread_id,velocity_label,push_subscriptions(*)")
    .eq("status", "failed_transient").limit(100);
  for (const retry of retries || []) {
    const deal = dealByDeliveryKey.get(`${retry.thread_id}:${retry.velocity_label}`);
    const subscription = Array.isArray(retry.push_subscriptions)
      ? retry.push_subscriptions[0] : retry.push_subscriptions;
    if (!deal || !subscription?.enabled) continue;
    const { data: claimed } = await supabase.rpc("claim_notification_delivery", {
      target_subscription_id: retry.subscription_id,
      target_thread_id: retry.thread_id,
      target_velocity_label: retry.velocity_label,
    });
    if (!claimed) continue;
    if (await sendDelivery(subscription, deal)) sent += 1;
    else failed += 1;
  }

  const currentDeals = body.deals.filter((deal: any) => String(deal.thread_id || ""));
  if (!currentDeals.length) return response({ ok: true, sent, failed });
  const threadIds = currentDeals.map((deal: any) => String(deal.thread_id));
  const { data: priorRows, error: priorError } = await supabase.from("deal_heat_state")
    .select("thread_id,velocity_label").in("thread_id", threadIds);
  if (priorError) throw priorError;
  const priorByThread = new Map((priorRows || []).map((row) => [row.thread_id, row.velocity_label]));
  const now = new Date().toISOString();
  const { error: stateError } = await supabase.from("deal_heat_state").upsert(
    currentDeals.map((deal: any) => ({
      thread_id: String(deal.thread_id),
      velocity_label: String(deal.velocity_label || ""),
      observed_at: body.scraped_at,
      updated_at: now,
    })),
    { onConflict: "thread_id" },
  );
  if (stateError) throw stateError;

  const transitions = currentDeals.filter((deal: any) => {
    const priorLabel = priorByThread.get(String(deal.thread_id));
    return enteredHigherHeat(priorLabel, String(deal.velocity_label || ""));
  });
  const { data: activeSubscriptions, error: subscriptionsError } = transitions.length
    ? await supabase.from("push_subscriptions").select("*").eq("enabled", true)
    : { data: [], error: null };
  if (subscriptionsError) throw subscriptionsError;

  for (const deal of transitions) {
    const label = String(deal.velocity_label);
    const threadId = String(deal.thread_id);
    const matchingSubscriptions = (activeSubscriptions || []).filter((subscription) =>
      Array.isArray(subscription.thresholds) && subscription.thresholds.includes(label)
    );
    for (const subscription of matchingSubscriptions) {
      const { data: claimed } = await supabase.rpc("claim_notification_delivery", {
        target_subscription_id: subscription.id,
        target_thread_id: threadId,
        target_velocity_label: label,
      });
      if (!claimed) continue;
      if (await sendDelivery(subscription, deal)) sent += 1;
      else failed += 1;
    }
  }
  return response({ ok: true, sent, failed });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return response({ error: "Method not allowed." }, 405);
  try {
    const path = new URL(req.url).pathname.replace(/\/$/, "");
    const body = await req.json();
    if (path.endsWith("/subscribe")) return await subscribe(req, body);
    if (path.endsWith("/disable")) return await disable(body);
    if (path.endsWith("/process")) return await processSnapshot(req, body);
    return response({ error: "Not found." }, 404);
  } catch (error) {
    console.error(error);
    return response({ error: "Unexpected notification service error." }, 500);
  }
});
