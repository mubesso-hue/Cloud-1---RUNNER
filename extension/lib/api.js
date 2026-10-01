import { getSettings, isConfigured } from "./settings.js";

async function request(method, path, body) {
  const s = await getSettings();
  if (!isConfigured(s)) throw new Error("MailPulse is not configured yet (open Settings).");
  const res = await fetch(`${s.backendUrl}${path}`, {
    method,
    headers: { "x-tracker-key": s.secret, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Backend returned HTTP ${res.status}`);
  return data;
}

export const ping = () => request("GET", "/api/ping");
export const listEmails = () => request("GET", "/api/emails?limit=500");
export const createEmail = (email) => request("POST", "/api/emails", email);
export const updateEmail = (id, patch) => request("PATCH", `/api/emails/${encodeURIComponent(id)}`, patch);
export const deleteEmail = (id) => request("DELETE", `/api/emails/${encodeURIComponent(id)}`);
export const selfView = (id) => request("POST", `/api/self/${encodeURIComponent(id)}`);
