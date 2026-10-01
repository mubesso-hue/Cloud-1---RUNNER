// MailPulse tracking backend (Supabase Edge Function, Deno).
//
// Public (no auth, hit by recipients' mail clients):
//   GET  /track/o/:id.gif        tracking pixel -> records an open
//   GET  /track/c/:id/:n         link redirect  -> records a click, 302 to the registered URL
// Private (header x-tracker-key: <TRACKER_SECRET>, called by the extension):
//   GET    /track/api/ping
//   GET    /track/api/emails?limit=500
//   POST   /track/api/emails
//   PATCH  /track/api/emails/:id
//   DELETE /track/api/emails/:id
//   POST   /track/api/self/:id    sender is viewing this message: ignore opens around now

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  classifyOpen,
  guessClient,
  isValidId,
  parseRoute,
  pickPatch,
  PIXEL,
  resolveLink,
  SELF_WINDOW_MS,
  summarize,
} from "./logic.js";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const SECRET = Deno.env.get("TRACKER_SECRET") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-tracker-key",
};

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function pixel() {
  return new Response(PIXEL, { headers: { ...NO_CACHE, "Content-Type": "image/gif" } });
}

function authorized(req: Request) {
  const key = req.headers.get("x-tracker-key") ?? "";
  if (!SECRET || key.length !== SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ SECRET.charCodeAt(i);
  return diff === 0;
}

async function recordOpen(req: Request, id: string) {
  if (!isValidId(id)) return;
  const { data: email } = await db.from("mp_emails").select("id, created_at, suppress_until").eq("id", id).maybeSingle();
  if (!email) return; // unknown id, or the pixel loaded in compose before registration finished

  const { data: last } = await db
    .from("mp_events")
    .select("created_at")
    .eq("email_id", id)
    .eq("kind", "open")
    .eq("counted", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const ua = req.headers.get("user-agent") ?? "";
  const { counted, reason } = classifyOpen(email, last?.created_at ?? null, Date.now());
  await db.from("mp_events").insert({ email_id: id, kind: "open", user_agent: ua, client: guessClient(ua), counted, reason });
}

async function handleClick(req: Request, id: string, n: number) {
  if (!isValidId(id)) return new Response("Not found", { status: 404 });
  const { data: email } = await db.from("mp_emails").select("id, links").eq("id", id).maybeSingle();
  const url = email ? resolveLink(email.links, n) : null;
  if (!url) return new Response("Link not found", { status: 404 });

  const ua = req.headers.get("user-agent") ?? "";
  await db.from("mp_events").insert({ email_id: id, kind: "click", link_index: n, url, user_agent: ua, client: guessClient(ua) });
  return new Response(null, { status: 302, headers: { ...NO_CACHE, Location: url } });
}

async function listEmails(req: Request) {
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit")) || 500, 1000);
  const { data: emails, error } = await db
    .from("mp_emails")
    .select("*")
    .neq("status", "archived")
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) return json({ error: error.message }, 500);
  if (!emails.length) return json({ emails: [] });

  const ids = emails.map((e) => e.id);
  const events: Record<string, unknown>[] = [];
  // Page through events; PostgREST caps a single response at 1000 rows by default.
  for (let from = 0; ; from += 1000) {
    const { data, error: evErr } = await db
      .from("mp_events")
      .select("email_id, kind, created_at, client, url, counted")
      .in("email_id", ids)
      .eq("counted", true)
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (evErr) return json({ error: evErr.message }, 500);
    events.push(...data);
    if (data.length < 1000) break;
  }
  return json({ emails: emails.map((e) => summarize(e, events)) });
}

async function createEmail(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !isValidId(body.id)) return json({ error: "invalid id" }, 400);
  const row = {
    id: body.id,
    account: typeof body.account === "string" ? body.account : null,
    subject: typeof body.subject === "string" ? body.subject.slice(0, 500) : "",
    recipients: Array.isArray(body.recipients) ? body.recipients.slice(0, 100) : [],
    links: Array.isArray(body.links) ? body.links.filter((l: unknown) => typeof l === "string").slice(0, 200) : [],
    sent_at: body.sent_at ?? new Date().toISOString(),
  };
  // Re-sending after a failed attempt (e.g. a missing recipient) reuses the id, so update in place.
  const { error } = await db.from("mp_emails").upsert(row, { onConflict: "id" });
  return error ? json({ error: error.message }, 500) : json({ ok: true });
}

async function updateEmail(req: Request, id: string) {
  const patch = pickPatch(await req.json().catch(() => ({})));
  if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
  const { error } = await db.from("mp_emails").update(patch).eq("id", id);
  return error ? json({ error: error.message }, 500) : json({ ok: true });
}

async function deleteEmail(id: string) {
  const { error } = await db.from("mp_emails").delete().eq("id", id);
  return error ? json({ error: error.message }, 500) : json({ ok: true });
}

async function selfView(id: string) {
  const now = Date.now();
  await db.from("mp_emails").update({ suppress_until: new Date(now + SELF_WINDOW_MS).toISOString() }).eq("id", id);
  // The proxy fetch for this view may have arrived just before the ping.
  await db
    .from("mp_events")
    .update({ counted: false, reason: "self" })
    .eq("email_id", id)
    .eq("kind", "open")
    .gte("created_at", new Date(now - SELF_WINDOW_MS).toISOString());
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const route = parseRoute(req.method, new URL(req.url).pathname) as { name: string; id: string; n: number };

  try {
    switch (route.name) {
      case "open":
        // Always answer with the pixel, even if recording fails.
        await recordOpen(req, route.id).catch((e) => console.error("open", e));
        return pixel();
      case "click":
        return await handleClick(req, route.id, route.n);
    }

    if (!authorized(req)) return json({ error: "unauthorized" }, 401);
    switch (route.name) {
      case "ping":
        return json({ ok: true });
      case "listEmails":
        return await listEmails(req);
      case "createEmail":
        return await createEmail(req);
      case "updateEmail":
        return await updateEmail(req, route.id);
      case "deleteEmail":
        return await deleteEmail(route.id);
      case "selfView":
        return await selfView(route.id);
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
