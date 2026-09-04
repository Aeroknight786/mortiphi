import type { BootstrapResponse, SessionListResponse, SessionProjectionSnapshot, TurnInputPart, WorkspaceChanges } from "../shared/contracts";

let csrf = "";

export class ApiError extends Error {
  constructor(public code: string, message: string, public retryable: boolean, public remediation: string) { super(message); }
}

export async function bootstrap() {
  const result = await request<BootstrapResponse>("/api/bootstrap");
  csrf = result.csrfToken;
  return result;
}

export async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const method = init.method ?? "GET";
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      credentials: "same-origin",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(!["GET", "HEAD"].includes(method) && csrf ? { "X-CSRF-Token": csrf } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(body.code ?? "request_failed", body.message ?? "The request failed.", Boolean(body.retryable), body.remediation ?? "Retry the action.");
    return body as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("request_timeout", "Muse did not answer this request in time.", true, "The previous task is still open. Retry; mortiφ will resync from authoritative Muse state.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  sessions: (cursor?: string) => request<SessionListResponse>(`/api/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  resume: (id: string) => request<SessionProjectionSnapshot>(`/api/sessions/${encodeURIComponent(id)}/resume`, { method: "POST", body: "{}" }, 45_000),
  snapshot: (id: string) => request<SessionProjectionSnapshot>(`/api/sessions/${encodeURIComponent(id)}/snapshot`, {}, 45_000),
  openWorkspace: (path: string) => request<any>("/api/workspaces/open", { method: "POST", body: JSON.stringify({ path }) }),
  newSession: (workspaceRoot: string, modelId?: string | null, approvalMode?: string) => request<any>("/api/sessions", { method: "POST", body: JSON.stringify({ workspaceRoot, modelId, approvalMode }) }),
  fork: (id: string) => request<any>(`/api/sessions/${id}/fork`, { method: "POST", body: "{}" }),
  renameTask: (id: string, title: string) => request<{ sessionId: string; title: string; titleSource: "mortiphi" }>(`/api/sessions/${id}/label`, { method: "PATCH", body: JSON.stringify({ title }) }),
  removeTask: (id: string) => request<{ sessionId: string; removedFrom: "mortiphi"; museSessionPreserved: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  compact: (id: string) => request<any>(`/api/sessions/${id}/compact`, { method: "POST", body: "{}" }),
  models: (id?: string) => request<any>(`/api/models${id ? `?sessionId=${encodeURIComponent(id)}` : ""}`),
  setModel: (id: string, model: any) => request<any>(`/api/sessions/${id}/model`, { method: "POST", body: JSON.stringify({ model }) }),
  setMode: (id: string, mode: string) => request<any>(`/api/sessions/${id}/approval-mode`, { method: "POST", body: JSON.stringify({ mode }) }),
  turn: (id: string, parts: TurnInputPart[], effort: string, ifBusy: string) => request<any>(`/api/sessions/${id}/turns`, { method: "POST", body: JSON.stringify({ parts, effort, ifBusy }) }),
  steer: (id: string, turnId: string, parts: TurnInputPart[], effort: string) => request<any>(`/api/sessions/${id}/turns/${turnId}/steer`, { method: "POST", body: JSON.stringify({ parts, effort }) }),
  stop: (id: string, turnId: string) => request<any>(`/api/sessions/${id}/turns/${turnId}/interrupt`, { method: "POST", body: "{}" }),
  unqueue: (id: string, turnId: string) => request<any>(`/api/sessions/${id}/turns/${turnId}/unqueue`, { method: "POST", body: "{}" }),
  decide: (id: string, approvalId: string, data: any) => request<any>(`/api/sessions/${id}/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify(data) }),
  answer: (id: string, userInputId: string, answers: any[]) => request<any>(`/api/sessions/${id}/questions/${userInputId}/answer`, { method: "POST", body: JSON.stringify({ answers }) }),
  clarify: (id: string, userInputId: string, content: string) => request<any>(`/api/sessions/${id}/questions/${userInputId}/clarify`, { method: "POST", body: JSON.stringify({ content }) }),
  cancelQuestion: (id: string, userInputId: string) => request<any>(`/api/sessions/${id}/questions/${userInputId}/cancel`, { method: "POST", body: "{}" }),
  changes: (id: string) => request<WorkspaceChanges>(`/api/sessions/${id}/workspace/changes`),
  diff: (id: string, path: string) => request<any>(`/api/sessions/${id}/workspace/diff?path=${encodeURIComponent(path)}`),
  files: (id: string, q = "") => request<{ files: string[] }>(`/api/sessions/${id}/workspace/files?q=${encodeURIComponent(q)}`),
};
