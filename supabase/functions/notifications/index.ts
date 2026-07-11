import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { ALLOWED_THRESHOLDS as ALLOWED, enteredHigherStamp, normalizeThresholds } from "./logic.mjs";

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
  const { data } = await supabase.from("push_subscriptions").select("*")
    .eq("installation_id", installationId).maybeSingle();
  if (!data || data.management_secret_hash !== await sha256(managementSecret)) return null;
  return data;
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
  if (installationId && !existing) return response({ error: "Invalid installation credentials." }, 401);
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
  if (error) return response({ error: "Could not save subscription." }, 500);
  return response({ installationId, managementSecret: newSecret });
}

async function disable(body: any) {
  const existing = await authenticate(body.installationId, body.managementSecret);
  if (!existing) return response({ error: "Invalid installation credentials." }, 401);
  const { error } = await supabase.from("push_subscriptions").delete().eq("id", existing.id);
  return error ? response({ error: "Could not disable subscription." }, 500) : response({ ok: true });
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
    }), { TTL: 3600, urgency: "normal" });
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

  for (const deal of body.deals) {
    const label = String(deal.velocity_label || "");
    const threadId = String(deal.thread_id || "");
    if (!threadId) continue;
    const { data: prior } = await supabase.from("deal_stamp_state").select("velocity_label")
      .eq("thread_id", threadId).maybeSingle();
    await supabase.from("deal_stamp_state").upsert({
      thread_id: threadId, velocity_label: label, observed_at: body.scraped_at, updated_at: new Date().toISOString(),
    });
    if (!prior || !enteredHigherStamp(prior.velocity_label, label)) continue;

    const { data: subscriptions } = await supabase.from("push_subscriptions").select("*")
      .eq("enabled", true).contains("thresholds", [label]);
    for (const subscription of subscriptions || []) {
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
