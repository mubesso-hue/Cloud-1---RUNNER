import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOpen,
  DEDUPE_MS,
  GRACE_MS,
  guessClient,
  isValidId,
  parseRoute,
  pickPatch,
  resolveLink,
  summarize,
} from "../supabase/functions/track/logic.js";

test("parseRoute handles paths with and without the function prefix", () => {
  assert.deepEqual(parseRoute("GET", "/track/o/abcdefghijklmnop.gif"), { name: "open", id: "abcdefghijklmnop" });
  assert.deepEqual(parseRoute("GET", "/functions/v1/track/o/abcdefghijklmnop.gif"), { name: "open", id: "abcdefghijklmnop" });
  assert.deepEqual(parseRoute("GET", "/track/c/abcdefghijklmnop/2"), { name: "click", id: "abcdefghijklmnop", n: 2 });
  assert.deepEqual(parseRoute("GET", "/track/c/abcdefghijklmnop/x"), { name: "notFound" });
  assert.deepEqual(parseRoute("GET", "/track/api/emails"), { name: "listEmails" });
  assert.deepEqual(parseRoute("POST", "/track/api/emails"), { name: "createEmail" });
  assert.deepEqual(parseRoute("PATCH", "/track/api/emails/abc"), { name: "updateEmail", id: "abc" });
  assert.deepEqual(parseRoute("DELETE", "/track/api/emails/abc"), { name: "deleteEmail", id: "abc" });
  assert.deepEqual(parseRoute("POST", "/track/api/self/abc"), { name: "selfView", id: "abc" });
  assert.deepEqual(parseRoute("GET", "/track/api/ping"), { name: "ping" });
  assert.deepEqual(parseRoute("POST", "/track/o/abc"), { name: "notFound" });
});

test("isValidId", () => {
  assert.ok(isValidId("Ab3_-Ab3_-Ab3_-Ab3_-AA"));
  assert.ok(!isValidId("short"));
  assert.ok(!isValidId("has spaces in it here"));
  assert.ok(!isValidId(undefined));
});

test("classifyOpen ignores grace period, self views and duplicates", () => {
  const created = Date.parse("2026-01-01T00:00:00Z");
  const email = { created_at: new Date(created).toISOString(), suppress_until: null };

  assert.deepEqual(classifyOpen(email, null, created + 1000), { counted: false, reason: "grace" });
  assert.deepEqual(classifyOpen(email, null, created + GRACE_MS + 1), { counted: true, reason: null });

  const suppressed = { ...email, suppress_until: new Date(created + 60_000).toISOString() };
  assert.deepEqual(classifyOpen(suppressed, null, created + 30_000), { counted: false, reason: "self" });
  assert.deepEqual(classifyOpen(suppressed, null, created + 61_000), { counted: true, reason: null });

  const last = new Date(created + 100_000).toISOString();
  assert.deepEqual(classifyOpen(email, last, created + 100_000 + DEDUPE_MS - 1), { counted: false, reason: "duplicate" });
  assert.deepEqual(classifyOpen(email, last, created + 100_000 + DEDUPE_MS + 1), { counted: true, reason: null });
});

test("guessClient", () => {
  assert.equal(guessClient("Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)"), "Gmail");
  assert.equal(guessClient("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"), "iOS Mail");
  assert.equal(guessClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"), "Apple Mail");
  assert.equal(guessClient("Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)"), "Outlook");
  assert.equal(guessClient(""), "Unknown");
});

test("resolveLink only returns registered http(s) links", () => {
  const links = ["https://example.com/a?b=1", "javascript:alert(1)", "not a url"];
  assert.equal(resolveLink(links, 0), "https://example.com/a?b=1");
  assert.equal(resolveLink(links, 1), null);
  assert.equal(resolveLink(links, 2), null);
  assert.equal(resolveLink(links, 9), null);
  assert.equal(resolveLink(null, 0), null);
});

test("summarize aggregates only counted events of that email", () => {
  const email = { id: "e1", subject: "Hi", suppress_until: "2026-01-01T00:00:00Z" };
  const events = [
    { email_id: "e1", kind: "open", created_at: "2026-01-02T10:00:00Z", counted: true, client: "Gmail" },
    { email_id: "e1", kind: "open", created_at: "2026-01-01T10:00:00Z", counted: true, client: "Gmail" },
    { email_id: "e1", kind: "open", created_at: "2026-01-03T10:00:00Z", counted: false },
    { email_id: "e1", kind: "click", created_at: "2026-01-02T11:00:00Z", counted: true, url: "https://x.y" },
    { email_id: "e2", kind: "open", created_at: "2026-01-02T10:00:00Z", counted: true },
  ];
  const s = summarize(email, events);
  assert.equal(s.open_count, 2);
  assert.equal(s.first_opened_at, "2026-01-01T10:00:00Z");
  assert.equal(s.last_opened_at, "2026-01-02T10:00:00Z");
  assert.equal(s.click_count, 1);
  assert.equal(s.events.length, 3);
  assert.equal(s.events[2].url, "https://x.y");
  assert.ok(!("suppress_until" in s));
});

test("pickPatch keeps only allowed fields and valid status", () => {
  assert.deepEqual(pickPatch({ notes: "n", id: "x", suppress_until: "y" }), { notes: "n" });
  assert.deepEqual(pickPatch({ status: "bogus", thread_id: "t" }), { thread_id: "t" });
  assert.deepEqual(pickPatch({ status: "done" }), { status: "done" });
  assert.deepEqual(pickPatch(null), {});
});
