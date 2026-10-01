const DAY = 86_400_000;

/**
 * The pipeline stage of a tracked email, in priority order:
 * pending (not synced yet) > replied > done > followup > opened > unopened.
 */
export function stageOf(e, followUpDays, now = Date.now()) {
  if (e.pending) return "pending";
  if (e.replied_at) return "replied";
  if (e.status === "done") return "done";
  if (isFollowUpDue(e, followUpDays, now)) return "followup";
  return e.open_count > 0 ? "opened" : "unopened";
}

export function isFollowUpDue(e, followUpDays, now = Date.now()) {
  if (e.replied_at || e.status === "done" || e.pending) return false;
  if (e.follow_up_at) return now >= Date.parse(e.follow_up_at);
  return now - Date.parse(e.sent_at) >= followUpDays * DAY;
}

/** Most recent thing that happened to the email, for sorting. */
export function lastActivity(e) {
  return Math.max(
    Date.parse(e.sent_at) || 0,
    Date.parse(e.last_opened_at) || 0,
    Date.parse(e.last_clicked_at) || 0,
    Date.parse(e.replied_at) || 0,
  );
}

export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 0) {
    const d = Math.ceil(-s / 86400);
    return d <= 1 ? "tomorrow" : `in ${d}d`;
  }
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fullTime(iso) {
  const t = Date.parse(iso);
  return t
    ? new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
}

export function gmailThreadUrl(e) {
  const auth = e.account ? `?authuser=${encodeURIComponent(e.account)}` : "";
  if (e.thread_id) return `https://mail.google.com/mail/${auth}#all/${e.thread_id}`;
  const q = `in:sent ${e.subject ? `subject:"${e.subject.replace(/"/g, "")}"` : ""}`.trim();
  return `https://mail.google.com/mail/${auth}#search/${encodeURIComponent(q)}`;
}
