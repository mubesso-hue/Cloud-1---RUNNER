export const DEFAULTS = {
  backendUrl: "", // e.g. https://<project-ref>.supabase.co/functions/v1/track
  secret: "", // must match TRACKER_SECRET on the backend
  trackByDefault: true, // new compose windows start with tracking on
  trackClicks: true, // rewrite links so clicks are recorded
  notifyOnOpen: true, // desktop notification on new opens/clicks
  followUpDays: 3, // unanswered after this many days -> "Follow up"
  replyDetection: false, // use the Gmail API to detect replies
};

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings ?? {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  next.backendUrl = (next.backendUrl ?? "").trim().replace(/\/+$/, "");
  next.followUpDays = Math.max(1, Number(next.followUpDays) || DEFAULTS.followUpDays);
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function isConfigured(s) {
  return Boolean(s.backendUrl && s.secret);
}
