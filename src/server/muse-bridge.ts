import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EXPECTED_SCHEMA_FINGERPRINT, spawnMspConnection, type SpawnedMspConnection } from "@muse-code/sdk";
import type { Diagnostics, ReasoningEffort, SessionListResponse, SessionSummary, TurnInputPart } from "../shared/contracts.js";
import { MORTIPHI_VERSION } from "../shared/version.js";
import { AppError, messageFrom } from "./errors.js";
import { SessionLabelStore } from "./session-labels.js";
import { SessionProjection } from "./session-projection.js";
import { SessionVisibilityStore } from "./session-visibility.js";

const execFileAsync = promisify(execFile);
type Json = Record<string, unknown>;

export interface BridgeOptions {
  museBin?: string;
  cwd?: string;
  clientVersion?: string;
  maxJournal?: number;
  labelStorePath?: string;
  visibilityStorePath?: string;
}

export class MuseBridge {
  private host?: SpawnedMspConnection;
  private projections = new Map<string, SessionProjection>();
  private titles = new Map<string, string>();
  private subscribed = new Set<string>();
  private releaseTimers = new Map<string, NodeJS.Timeout>();
  private stderr: string[] = [];
  private options: Required<BridgeOptions>;
  private labels: SessionLabelStore;
  private visibility: SessionVisibilityStore;

  constructor(options: BridgeOptions = {}) {
    this.options = {
      museBin: options.museBin ?? process.env.MUSE_BIN ?? "muse",
      cwd: options.cwd ?? process.cwd(),
      clientVersion: options.clientVersion ?? MORTIPHI_VERSION,
      maxJournal: options.maxJournal ?? 800,
      labelStorePath: options.labelStorePath ?? process.env.MORTIPHI_LABEL_STORE ?? join(homedir(), ".mortiphi", "session-labels.json"),
      visibilityStorePath: options.visibilityStorePath ?? process.env.MORTIPHI_VISIBILITY_STORE ?? join(homedir(), ".mortiphi", "hidden-sessions.json"),
    };
    this.labels = new SessionLabelStore(this.options.labelStorePath);
    this.visibility = new SessionVisibilityStore(this.options.visibilityStorePath);
  }

  async initialize() {
    if (this.host) return;
    await Promise.all([this.labels.load(), this.visibility.load()]);
    const handshake = spawnMspConnection({
      command: this.options.museBin,
      args: ["serve"],
      cwd: this.options.cwd,
      onStderr: (chunk) => {
        this.stderr.push(chunk.trim());
        this.stderr = this.stderr.filter(Boolean).slice(-80);
      },
    });
    this.host = await handshake.initialize({
      clientInfo: { name: "mortiphi", title: "mortiφ", version: this.options.clientVersion },
      capabilities: { requestedCapabilities: ["userShell"] },
    });
    if (this.host.initializeResult.schema.version !== 1) {
      const unsupportedVersion = this.host.initializeResult.schema.version;
      await this.host.close();
      this.host = undefined;
      throw new AppError("unsupported_envelope", `Muse returned MSP envelope v${unsupportedVersion}.`, 503, false, "Install a Muse release that supports MSP envelope v1.");
    }
    this.host.connection.onNotification((notification) => {
      const params = asJson(notification.params);
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
      if (sessionId) this.projections.get(sessionId)?.apply(notification.method, params, notification.emittedAtMs);
    });
    void this.host.close;
    this.host.connection.closed.then(() => {
      for (const projection of this.projections.values()) projection.disconnect();
    }).catch(() => undefined);
  }

  get connection() {
    if (!this.host) throw new AppError("muse_unavailable", "Muse is not connected.", 503, true, "Restart mortiφ and confirm `muse` is installed and authenticated.");
    return this.host.connection;
  }

  async diagnostics(): Promise<Diagnostics> {
    await this.initialize();
    const init = this.host!.initializeResult;
    let museVersion = init.serverInfo.version;
    try { museVersion = (await execFileAsync(this.options.museBin, ["--version"], { timeout: 3000 })).stdout.trim() || museVersion; } catch { /* handshake version is authoritative fallback */ }
    return {
      mortiphiVersion: this.options.clientVersion,
      museVersion,
      sdkVersion: "0.1.1",
      schemaVersion: init.schema.version,
      schemaFingerprint: init.schema.fingerprint,
      expectedFingerprint: EXPECTED_SCHEMA_FINGERPRINT,
      fingerprintDrift: init.schema.fingerprint !== EXPECTED_SCHEMA_FINGERPRINT,
      durability: init.sessionDurability ?? "durable (legacy default)",
      platform: `${init.platformFamily} · ${init.platformOs}`,
      connected: true,
      grantedCapabilities: init.grantedCapabilities,
      unsupported: ["Login/logout", "Skills management", "MCP configuration", "Export/trace", "Account quota", "Muse-native delete/archive", "Muse-native task naming", "Worktree/sandbox launch controls", "Interactive terminal"],
    };
  }

  async listSessions(cursor?: string | null, workspaceRoot?: string): Promise<SessionListResponse> {
    const result = await this.request("session/list", compact({ cursor, limit: 100, workspaceRoot }));
    const sessions = (Array.isArray(result.sessions) ? result.sessions.map(asJson) : []).filter((session) => !isInternalSmokeWorkspace(text(session.workspaceRoot)) && !this.visibility.has(text(session.sessionId) ?? ""));
    await Promise.all(sessions.slice(0, 30).map(async (session) => {
      const id = text(session.sessionId); if (!id || this.titles.has(id)) return;
      try {
        const read = await this.request("session/read", { sessionId: id, excludeItems: false });
        const items = historyItems(read.history);
        this.titles.set(id, deriveTitle(items));
      } catch { this.titles.set(id, "Untitled task"); }
    }));
    return {
      sessions: sessions.map((session) => this.summary(session)),
      nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
    };
  }

  async readSession(sessionId: string) {
    this.assertVisible(sessionId);
    const result = await this.request("session/read", { sessionId, excludeItems: false });
    const session = asJson(result.session);
    const items = historyItems(result.history);
    this.titles.set(sessionId, deriveTitle(items));
    return { session: this.summary(session), items, history: result.history, pendingRequests: result.pendingRequests, viewCursor: result.viewCursor };
  }

  async startSession(workspaceRoot: string, modelId?: string, approvalMode?: string) {
    const result = await this.command("session/start", compact({ workspaceRoot, modelId, approvalMode }));
    const session = asJson(result.session);
    const id = requiredText(session.sessionId, "Muse did not return a session id.");
    const projection = new SessionProjection(session, this.options.maxJournal);
    this.projections.set(id, projection);
    this.subscribed.add(id);
    this.titles.set(id, "New task");
    return { session: this.summary(session), snapshot: projection.snapshot() };
  }

  async attach(sessionId: string) {
    this.assertVisible(sessionId);
    const existing = this.projections.get(sessionId);
    if (existing && !existing.needsResync && this.subscribed.has(sessionId)) return existing;
    const read = await this.request("session/read", { sessionId, excludeItems: false });
    const session = asJson(read.session);
    const projection = existing ?? new SessionProjection(session, this.options.maxJournal);
    if (existing) {
      await this.request("view/unsubscribe", { sessionId }).catch(() => undefined);
      projection.reset(session);
    }
    await this.hydrateHistory(projection, sessionId, asJson(read.history));
    this.projections.set(sessionId, projection);
    await this.command("session/resume", { sessionId, cursor: read.viewCursor, excludeItems: true });
    this.subscribed.add(sessionId);
    const pending = await this.request("approval/listPending", { sessionId });
    projection.replacePending(pending);
    this.titles.set(sessionId, deriveTitle(projection.snapshot().items));
    return projection;
  }

  async fork(sessionId: string) {
    const result = await this.command("session/fork", { sessionId, excludeItems: true });
    const session = asJson(result.session);
    const id = requiredText(session.sessionId, "Muse did not return a fork id.");
    const projection = new SessionProjection(session, this.options.maxJournal);
    this.projections.set(id, projection);
    this.subscribed.add(id);
    await this.refreshProjection(id, projection);
    return { session: this.summary(session), snapshot: projection.snapshot() };
  }

  async renameTask(sessionId: string, requestedLabel: string) {
    this.assertVisible(sessionId);
    await this.request("session/read", { sessionId, excludeItems: true });
    const label = requestedLabel.replace(/\s+/g, " ").trim();
    if (!label || label.length > 100) {
      throw new AppError("invalid_label", "A task name must be between 1 and 100 characters.", 400, false, "Use a shorter descriptive name.");
    }
    await this.labels.set(sessionId, label);
    return { sessionId, title: label, titleSource: "mortiphi" as const };
  }

  async removeLocal(sessionId: string) {
    this.assertVisible(sessionId);
    const result = await this.request("session/read", { sessionId, excludeItems: true });
    const status = this.summary(asJson(result.session)).status;
    if (status !== "idle") {
      throw new AppError("task_busy", "A running, queued, or waiting task cannot be removed.", 409, true, "Stop or settle the task first, then remove it.");
    }
    await this.visibility.hide(sessionId);
    const timer = this.releaseTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.releaseTimers.delete(sessionId);
    if (this.subscribed.has(sessionId)) await this.request("view/unsubscribe", { sessionId }).catch(() => undefined);
    this.subscribed.delete(sessionId);
    this.projections.delete(sessionId);
    return { sessionId, removedFrom: "mortiphi" as const, museSessionPreserved: true };
  }

  async compact(sessionId: string, turnId?: string) { return this.command("session/compact", compact({ sessionId, turnId })); }
  async models(sessionId?: string) { return this.request("model/list", compact({ sessionId })); }
  async setModel(sessionId: string, model: Json) { return this.command("session/setModel", { sessionId, model }); }
  async setApprovalMode(sessionId: string, mode: string) { return this.command("session/setApprovalMode", { sessionId, mode }); }

  async startTurn(sessionId: string, input: TurnInputPart[], effort: ReasoningEffort, ifBusy: string) {
    const projection = await this.attach(sessionId);
    const result = await this.command("turn/start", { sessionId, input, displayText: displayText(input), reasoningEffort: effort, ifBusy });
    projection.admitTurn(result);
    return result;
  }

  async steer(sessionId: string, expectedTurnId: string, input: TurnInputPart[], effort?: ReasoningEffort) {
    return this.command("turn/steer", compact({ sessionId, expectedTurnId, input, reasoningEffort: effort }));
  }
  async interrupt(sessionId: string, turnId?: string) {
    const projection = await this.attach(sessionId);
    const result = await this.command("turn/interrupt", compact({ sessionId, turnId, retract: true }));
    const targeted = text(result.turnId) ?? turnId;
    if (targeted) projection.markStopping(targeted);
    return result;
  }
  async cancel(sessionId: string, turnId?: string) { return this.command("turn/cancel", compact({ sessionId, turnId })); }
  async unqueue(sessionId: string, turnId: string) { return this.command("turn/unqueue", { sessionId, turnId }); }
  async decideApproval(sessionId: string, approvalId: string, requirementId: Json, choiceId: string, feedback?: string) {
    return this.command("approval/decide", compact({ sessionId, approvalId, requirementId, choiceId, feedback }));
  }
  async answerInput(sessionId: string, userInputId: string, answers: unknown[]) { return this.command("userInput/answer", { sessionId, userInputId, answers }); }
  async clarifyInput(sessionId: string, userInputId: string, content: string) { return this.command("userInput/clarify", { sessionId, userInputId, clarification: { content, format: "text" } }); }
  async cancelInput(sessionId: string, userInputId: string, reason?: string) { return this.command("userInput/cancel", compact({ sessionId, userInputId, reason })); }

  getProjection(sessionId: string) { return this.projections.get(sessionId); }

  retain(sessionId: string) {
    const timer = this.releaseTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.releaseTimers.delete(sessionId);
  }

  release(sessionId: string) {
    this.retain(sessionId);
    const timer = setTimeout(() => {
      const snapshot = this.projections.get(sessionId)?.snapshot();
      const busy = snapshot && (snapshot.state.activeTurnId || snapshot.state.queuedTurns.length || snapshot.pending.approvals.length || snapshot.pending.userInputs.length);
      if (busy || !this.subscribed.has(sessionId)) return;
      void this.connection.request("view/unsubscribe", { sessionId }).then(() => this.subscribed.delete(sessionId)).catch(() => undefined);
    }, 20_000);
    timer.unref();
    this.releaseTimers.set(sessionId, timer);
  }

  async close() {
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.subscribed.clear();
    if (this.host) await this.host.close();
    this.host = undefined;
  }

  private async refreshProjection(sessionId: string, projection: SessionProjection) {
    const read = await this.request("session/read", { sessionId, excludeItems: false });
    projection.reset(asJson(read.session));
    await this.hydrateHistory(projection, sessionId, asJson(read.history));
    const pending = await this.request("approval/listPending", { sessionId });
    projection.replacePending(pending);
  }

  private async hydrateHistory(projection: SessionProjection, sessionId: string, history: Json) {
    if (history.mode === "inline" && Array.isArray(history.items)) {
      projection.seedItems(history.items.map(asJson));
      return;
    }
    if ((history.mode === "snapshot" || history.mode === "anchoredSnapshot") && history.snapshot) {
      projection.seedSnapshot(asJson(history.snapshot));
      const snapshotCursor = text(asJson(history.snapshot).viewCursor);
      if (snapshotCursor) await this.pageForward(projection, sessionId, snapshotCursor);
      return;
    }
    await this.pageAll(projection, sessionId);
  }

  private async pageAll(projection: SessionProjection, sessionId: string) {
    let cursor: string | undefined;
    const pages: Json[][] = [];
    for (let page = 0; page < 250; page++) {
      const result = await this.request("view/page", compact({ sessionId, direction: "backward", cursor, limit: 1000 }));
      pages.push(Array.isArray(result.events) ? result.events.map(asJson) : []);
      cursor = text(result.nextCursor);
      if (!cursor) break;
    }
    for (const events of pages.reverse()) for (const event of events) projection.apply(text(event.method) ?? "unknown", asJson(event.params), undefined, true);
  }

  private async pageForward(projection: SessionProjection, sessionId: string, start: string) {
    let cursor: string | undefined = start;
    for (let page = 0; page < 250; page++) {
      const result = await this.request("view/page", { sessionId, direction: "forward", cursor, limit: 1000 });
      for (const event of (Array.isArray(result.events) ? result.events.map(asJson) : [])) projection.apply(text(event.method) ?? "unknown", asJson(event.params), undefined, true);
      cursor = text(result.nextCursor);
      if (!cursor) break;
    }
  }

  private summary(session: Json): SessionSummary {
    const id = requiredText(session.sessionId, "Invalid Muse session metadata.");
    const root = text(session.workspaceRoot) ?? "";
    const rawStatus = text(session.status);
    const projection = this.projections.get(id)?.snapshot();
    const active = text(session.activeTurnId) ?? projection?.state.activeTurnId ?? null;
    const queued = projection?.state.queuedTurns.length ?? 0;
    const pending = (projection?.pending.approvals.length ?? 0) + (projection?.pending.userInputs.length ?? 0);
    return {
      sessionId: id,
      workspaceRoot: root,
      title: this.labels.get(id) ?? (projection ? deriveTitle(projection.items) : this.titles.get(id) ?? "Untitled task"),
      titleSource: this.labels.get(id) ? "mortiphi" : "prompt",
      status: active || rawStatus === "running" ? "running" : queued ? "queued" : pending ? "waiting" : "idle",
      activeTurnId: active,
      modelId: text(session.modelId) ?? null,
      providerId: text(session.providerId) ?? null,
      approvalMode: (asJson(session.approvalMode).mode as SessionSummary["approvalMode"]) ?? null,
      createdAt: text(session.createdAt) ?? "",
      updatedAt: text(session.updatedAt) ?? "",
      turnCount: Number(session.turnCount ?? 0),
      forkedFrom: text(asJson(session.forkedFrom).sessionId) ?? null,
      available: Boolean(root),
    };
  }

  private async request(method: string, params: Json): Promise<Json> {
    try { return await this.connection.request(method, params); }
    catch (error) { throw transportError(error, method); }
  }
  private async command(method: string, params: Json): Promise<Json> {
    try { return await this.connection.command(method, params); }
    catch (error) { throw transportError(error, method); }
  }

  private assertVisible(sessionId: string) {
    if (this.visibility.has(sessionId)) throw new AppError("task_removed", "This task was removed from mortiφ.", 404, false, "The Muse session is preserved, but restoring hidden tasks is not exposed yet.");
  }
}

function transportError(error: unknown, method: string) {
  const message = messageFrom(error);
  return new AppError("muse_operation_failed", message, 409, /timeout|closed|transport/i.test(message), `The ${method} operation was not reported as successful. Reconnect or retry; no success has been inferred.`);
}
function asJson(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function requiredText(value: unknown, message: string): string { if (typeof value !== "string" || !value) throw new AppError("invalid_muse_response", message, 502, true, "Reconnect to Muse and retry."); return value; }
function compact(value: Json): Json { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)); }
function historyItems(historyValue: unknown): Json[] {
  const history = asJson(historyValue);
  if (Array.isArray(history.items)) return history.items.map(asJson);
  const snapshot = asJson(history.snapshot); const state = asJson(snapshot.state);
  return Array.isArray(state.items) ? state.items.map(asJson) : [];
}
function deriveTitle(items: Json[]): string {
  const raw = items.find((item) => item.kind === "userMessage" && !item.retracted)?.text;
  if (typeof raw !== "string" || !raw.trim()) return "Untitled task";
  return raw.replace(/\s+/g, " ").trim().slice(0, 68);
}
function displayText(input: TurnInputPart[]) { return input.filter((part): part is Extract<TurnInputPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n"); }
function isInternalSmokeWorkspace(root?: string) { return Boolean(root && /(?:^|\/)(?:muse-gui-smoke|mortiphi-smoke)-[^/]+$/.test(root)); }
