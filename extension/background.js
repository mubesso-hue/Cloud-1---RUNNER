import * as api from "./lib/api.js";
import { findReply, findThread, getToken, profileEmail } from "./lib/gmail.js";
import { getSettings, isConfigured } from "./lib/settings.js";
import { gmailThreadUrl } from "./lib/status.js";

// storage.local keys:
//   settings  - see lib/settings.js
//   emails    - last list from the backend (what the side panel shows)
//   queue     - registrations not yet accepted by the backend
//   seen      - { [id]: open_count + click_count when the user last looked } for the badge
//   lastSync, syncError

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create("sync", { periodInMinutes: 1 });
  chrome.alarms.create("replies", { periodInMinutes: 5 });
}
chrome.runtime.onInstalled.addListener((details) => {
  setup();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(setup);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") sync().catch(() => {});
  if (alarm.name === "replies") checkReplies().catch(() => {});
});

// ---------- registration queue ----------

async function enqueue(email) {
  const { queue = [] } = await chrome.storage.local.get("queue");
  const next = queue.filter((q) => q.id !== email.id);
  next.push(email);
  await chrome.storage.local.set({ queue: next });
}

async function flushQueue() {
  const { queue = [] } = await chrome.storage.local.get("queue");
  if (!queue.length) return;
  const left = [];
  for (const email of queue) {
    try {
      await api.createEmail(email);
    } catch {
      left.push(email);
    }
  }
  await chrome.storage.local.set({ queue: left });
}

// ---------- sync, notifications, badge ----------

let syncing = null;
function sync() {
  syncing ??= doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync() {
  const settings = await getSettings();
  if (!isConfigured(settings)) return { ok: false, error: "not configured" };
  try {
    await flushQueue();
    const { emails } = await api.listEmails();
    const { emails: prev } = await chrome.storage.local.get("emails");
    if (prev && settings.notifyOnOpen) notifyChanges(prev, emails);
    await chrome.storage.local.set({ emails, lastSync: Date.now(), syncError: null });
    await updateBadge();
    return { ok: true };
  } catch (e) {
    await chrome.storage.local.set({ syncError: e.message });
    return { ok: false, error: e.message };
  }
}

function recipientLabel(e) {
  const r = e.recipients?.[0];
  const name = r?.name || r?.email || "Someone";
  return e.recipients?.length > 1 ? `${name} +${e.recipients.length - 1}` : name;
}

function notifyChanges(prev, emails) {
  const before = new Map(prev.map((e) => [e.id, e]));
  for (const e of emails) {
    const p = before.get(e.id);
    if (!p) continue;
    const what = [];
    if (e.open_count > p.open_count) what.push(e.open_count === 1 ? "opened your email" : `opened your email (${e.open_count}×)`);
    if (e.click_count > p.click_count) what.push("clicked a link");
    if (e.replied_at && !p.replied_at) what.push("replied");
    if (!what.length) continue;
    chrome.notifications.create(`mp:${e.id}:${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `${recipientLabel(e)} ${what.join(" and ")}`,
      message: e.subject || "(no subject)",
      priority: 1,
    });
  }
}

chrome.notifications.onClicked.addListener(async (notifId) => {
  const id = notifId.split(":")[1];
  const { emails = [] } = await chrome.storage.local.get("emails");
  const e = emails.find((x) => x.id === id);
  if (e) chrome.tabs.create({ url: gmailThreadUrl(e) });
  chrome.notifications.clear(notifId);
});

async function updateBadge() {
  const { emails = [], seen = {} } = await chrome.storage.local.get(["emails", "seen"]);
  const unseen = emails.filter((e) => e.open_count + e.click_count > (seen[e.id] ?? 0)).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  await chrome.action.setBadgeText({ text: unseen ? String(unseen) : "" });
}

async function markSeen() {
  const { emails = [] } = await chrome.storage.local.get("emails");
  const seen = Object.fromEntries(emails.map((e) => [e.id, e.open_count + e.click_count]));
  await chrome.storage.local.set({ seen });
  await updateBadge();
}

// ---------- reply detection ----------

async function checkReplies() {
  const settings = await getSettings();
  if (!settings.replyDetection || !isConfigured(settings)) return { ok: false, error: "reply detection is off" };
  let me;
  try {
    me = await profileEmail();
  } catch (e) {
    return { ok: false, error: `Gmail not connected: ${e.message}` };
  }

  const { emails = [] } = await chrome.storage.local.get("emails");
  const cutoff = Date.now() - 30 * 86_400_000;
  const candidates = emails
    .filter((e) => !e.replied_at && e.status === "active" && Date.parse(e.sent_at) > cutoff)
    .filter((e) => !e.account || e.account === me) // the API can only see the Chrome profile's mailbox
    .slice(0, 25);

  let changed = false;
  for (const e of candidates) {
    try {
      let threadId = e.thread_id;
      if (!threadId) {
        threadId = await findThread(e);
        if (!threadId) continue;
        await api.updateEmail(e.id, { thread_id: threadId });
        changed = true;
      }
      const reply = await findReply(threadId, e.sent_at);
      if (reply) {
        await api.updateEmail(e.id, reply);
        changed = true;
      }
    } catch (err) {
      console.warn("MailPulse reply check failed for", e.id, err);
    }
  }
  if (changed) await sync();
  return { ok: true, checked: candidates.length };
}

// ---------- messages from the content script, side panel and options page ----------

const lastSelfPing = new Map();

const handlers = {
  async register({ email }) {
    await enqueue(email);
    await flushQueue();
    sync();
    return { ok: true };
  },
  async selfView({ id }) {
    const last = lastSelfPing.get(id) ?? 0;
    if (Date.now() - last < 15_000) return { ok: true, skipped: true };
    lastSelfPing.set(id, Date.now());
    await api.selfView(id);
    return { ok: true };
  },
  sync: () => sync(),
  markSeen: () => markSeen().then(() => ({ ok: true })),
  async update({ id, patch }) {
    await api.updateEmail(id, patch);
    await sync();
    return { ok: true };
  },
  async remove({ id }) {
    await api.deleteEmail(id);
    const { queue = [] } = await chrome.storage.local.get("queue");
    await chrome.storage.local.set({ queue: queue.filter((q) => q.id !== id) });
    await sync();
    return { ok: true };
  },
  checkReplies: () => checkReplies(),
  async connectGmail() {
    await getToken(true);
    return { ok: true, email: await profileEmail() };
  },
  ping: () => api.ping(),
  openOptions: () => chrome.runtime.openOptionsPage().then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
