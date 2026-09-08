import type { HealthStatus, SessionSummary } from "../shared/contracts";

export function tabDraftId() {
  let id = sessionStorage.getItem("mortiphi:tab-id");
  if (!id) {
    id = (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem("mortiphi:tab-id", id);
  }
  return id;
}

export function readTabDraft(draftKey: string, legacyKey: string) {
  const own = localStorage.getItem(draftKey);
  if (own !== null) return own;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return "";
  localStorage.setItem(draftKey, legacy);
  localStorage.removeItem(legacyKey);
  return legacy;
}

export function connectionLabel(health: HealthStatus | null, bootConnected: boolean) {
  if (!health) return bootConnected ? "Connected" : "Unavailable";
  if (health.connected) return "Connected";
  return health.reconnectScheduled || health.reconnectAttempt > 0 ? "Reconnecting" : "Unavailable";
}

export function scrollAnchorKey(sessionId: string) { return `mortiphi:scroll:${sessionId}`; }

export function statusLabel(status: string) {
  return ({ running: "Running", queued: "Queued", waiting: "Waiting", failed: "Failed", idle: "Idle" } as Record<string, string>)[status] ?? status;
}

export function relativeTime(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "time unavailable";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function taskSubtitle(session: SessionSummary) {
  if (session.unopenableReason) return "Needs attention · unopenable";
  const base = session.available ? session.status === "idle" ? relativeTime(session.updatedAt) : `${statusLabel(session.status)} · ${relativeTime(session.updatedAt)}` : "Workspace unavailable";
  return session.readOnly ? `${base} · Read-only` : base;
}
