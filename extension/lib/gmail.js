// Reply detection through the Gmail API (read-only scope), using the Chrome profile's Google account.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No Gmail token"));
      } else {
        resolve(typeof token === "string" ? token : token.token);
      }
    });
  });
}

async function gmail(path, retried = false) {
  const token = await getToken(false);
  const res = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 && !retried) {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    return gmail(path, true);
  }
  if (!res.ok) throw new Error(`Gmail API HTTP ${res.status}`);
  return res.json();
}

export async function profileEmail() {
  const p = await gmail("profile");
  return (p.emailAddress || "").toLowerCase();
}

const header = (msg, name) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** Find the Gmail message/thread that a tracked email became, by subject, recipient and send time. */
export async function findThread(email) {
  const sentMs = Date.parse(email.sent_at);
  const terms = ["in:sent", "newer_than:30d"];
  const subject = (email.subject || "").replace(/["\\]/g, " ").trim();
  if (subject) terms.push(`subject:"${subject}"`);
  const to = email.recipients?.[0]?.email;
  if (to) terms.push(`to:${to}`);

  const list = await gmail(`messages?maxResults=10&q=${encodeURIComponent(terms.join(" "))}`);
  let best = null;
  for (const { id } of list.messages ?? []) {
    const msg = await gmail(`messages/${id}?format=minimal`);
    const delta = Math.abs(Number(msg.internalDate) - sentMs);
    if (delta < 15 * 60_000 && (!best || delta < best.delta)) best = { threadId: msg.threadId, delta };
  }
  return best?.threadId ?? null;
}

/** First message in the thread after our send that we did not send ourselves. */
export async function findReply(threadId, sentAt) {
  const sentMs = Date.parse(sentAt);
  const thread = await gmail(`threads/${threadId}?format=metadata&metadataHeaders=From`);
  for (const msg of thread.messages ?? []) {
    const labels = msg.labelIds ?? [];
    if (labels.includes("SENT") || labels.includes("DRAFT")) continue;
    if (Number(msg.internalDate) <= sentMs) continue;
    return { replied_at: new Date(Number(msg.internalDate)).toISOString(), reply_from: header(msg, "From") };
  }
  return null;
}
