import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EXPECTED_SCHEMA_FINGERPRINT, spawnMspConnection, type CommandOptions, type SpawnedMspConnection } from "@muse-code/sdk";
import type { Diagnostics, ReasoningEffort, SessionListResponse, SessionSummary, TurnInputPart } from "../shared/contracts.js";
import { MORTIPHI_VERSION } from "../shared/version.js";
import { AppError, classifyMuseError, friendlyMuseMessage, messageFrom } from "./errors.js";
import { SessionLabelStore } from "./session-labels.js";
import { SessionProjection } from "./session-projection.js";
import { SessionTitleStore } from "./session-titles.js";
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
  titleStorePath?: string;
  trustWorkspace?: boolean;
  spawnHost?: typeof spawnMspConnection;
}

export interface SessionFailure {
  sessionId: string;
  method: string;
  message: string;
  kind?: string;
  code?: number;
  category?: string;
  at: string;
}

export class MuseBridge {
  private host?: SpawnedMspConnection;
  private connecting?: Promise<void>;
  private shutdown = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private lastExit?: unknown;
  private projections = new Map<string, SessionProjection>();
  private titles: SessionTitleStore;
  private subscribed = new Set<string>();
  private releaseTimers = new Map<string, NodeJS.Timeout>();
  private failures = new Map<string, SessionFailure>();
  private inFlightCommands = new Map<string, Set<string>>();
  private steerCommands = new Map<string, string>();
  private quarantined = new Map<string, string>();
  private readOnlyIds = new Set<string>();
  private pendingReattach = new Set<string>();
  private attaching = new Map<string, Promise<SessionProjection>>();
  private buffered = new Map<string, Array<{ method: string; params: Json; emittedAtMs?: number }>>();
  private uncertainSends = new Map<string, { commandId: string; error: AppError }>();
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
      titleStorePath: options.titleStorePath ?? process.env.MORTIPHI_TITLE_STORE ?? join(homedir(), ".mortiphi", "session-titles.json"),
      trustWorkspace: options.trustWorkspace ?? process.env.MORTIPHI_TRUST_WORKSPACE === "1",
      spawnHost: options.spawnHost ?? spawnMspConnection,
    };
    this.labels = new SessionLabelStore(this.options.labelStorePath);
    this.visibility = new SessionVisibilityStore(this.options.visibilityStorePath);
    this.titles = new SessionTitleStore(this.options.titleStorePath);
  }

  async initialize() {
    await this.connect();
  }

  isConnected() { return Boolean(this.host); }

  private async connect() {
    if (this.host) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await Promise.all([this.labels.load(), this.visibility.load(), this.titles.load()]);
      const handshake = this.options.spawnHost({
        command: this.options.museBin,
        // Trust loads every session workspace's skills and rules. Explicit opt-in only.
        args: this.options.trustWorkspace ? ["serve", "--trust-workspace"] : ["serve"],
        cwd: this.options.cwd,
        onStderr: (chunk) => {
          this.stderr.push(chunk.trim());
          this.stderr = this.stderr.filter(Boolean).slice(-80);
        },
      });
      const host = await handshake.initialize({
        clientInfo: { name: "mortiphi", title: "mortiφ", version: this.options.clientVersion },
        capabilities: { requestedCapabilities: ["userShell"] },
      });
      if (host.initializeResult.schema.version !== 1) {
        const unsupportedVersion = host.initializeResult.schema.version;
        await host.close();
        throw new AppError("unsupported_envelope", `Muse returned MSP envelope v${unsupportedVersion}.`, 503, false, "Install a Muse release that supports MSP envelope v1.");
      }
      host.connection.onNotification((notification) => {
        if (this.host !== host) return;
        const params = asJson(notification.params);
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
        if (sessionId) {
          const buffer = this.buffered.get(sessionId);
          if (buffer) buffer.push({ method: notification.method, params, emittedAtMs: notification.emittedAtMs });
          else this.projections.get(sessionId)?.apply(notification.method, params, notification.emittedAtMs);
        }
      });
      host.connection.closed.then(() => { if (this.host === host) this.onHostClosed("closed"); }).catch(() => undefined);
      host.exited.then((exit) => { if (this.host === host) this.lastExit = exit; }).catch(() => undefined);
      if (this.shutdown) { await host.close(); return; }
      this.host = host;
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private onHostClosed(reason: string) {
    if (!this.host && !this.connecting) {
      if (!this.shutdown) this.scheduleReconnect();
      return;
    }
    const retired = this.host;
    this.host = undefined;
    if (retired) void retired.close().catch(() => undefined);
    for (const projection of this.projections.values()) projection.disconnect();
    // In-flight pins are NOT cleared here: their owning sends are still
    // settling through catch/finally, and reconcile needs the steer pin to
    // name the targeted turn. Both maps are self-cleaning (untrack in
    // finally); close() clears them at shutdown.
    // The dead host's views are gone. Move the claims to the re-attach queue:
    // leaving them in `subscribed` would make attach() early-return against a
    // host that never ran session/resume, leaving the session permanently blind.
    for (const sessionId of this.subscribed) this.pendingReattach.add(sessionId);
    this.subscribed.clear();
    logBridge("host_closed", { reason, retainedSessions: this.pendingReattach.size });
    if (this.shutdown) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.shutdown || (this.host && !this.pendingReattach.size) || this.connecting || this.reconnectTimer) return;
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 3));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectNow();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnectNow() {
    if (this.shutdown) return;
    if (!this.host) {
      this.reconnectAttempt += 1;
      try {
        await this.connect();
        this.reconnectAttempt = 0;
        logBridge("host_reconnected", { retainedSessions: this.pendingReattach.size });
      } catch (error) {
        logBridge("host_reconnect_failed", { attempt: this.reconnectAttempt, message: messageFrom(error) });
        this.scheduleReconnect();
        return;
      }
    }
    // Drain the re-attach queue even when the host is already up: an on-demand
    // connect during the outage leaves queued sessions behind otherwise.
    const targets = [...this.pendingReattach];
    this.pendingReattach.clear();
    for (const sessionId of targets) {
      try {
        await this.attach(sessionId);
      } catch (error) {
        const failure = error instanceof AppError ? error : transportError(error, "session/resume");
        this.recordFailure(sessionId, "session/resume", failure, messageFrom(error));
        if (failure.retryable) this.pendingReattach.add(sessionId);
      }
    }
    if (this.pendingReattach.size) { this.reconnectAttempt += 1; this.scheduleReconnect(); }
    else this.reconnectAttempt = 0;
  }

  private async ensureHost() {
    if (this.host) return;
    if (this.shutdown) throw new AppError("muse_unavailable", "Muse is not connected.", 503, true, "Restart mortiφ and confirm `muse` is installed and authenticated.");
    try {
      await this.connect();
    } catch {
      this.scheduleReconnect();
      throw new AppError("muse_unavailable", "Muse is reconnecting.", 503, true, "Retry in a few seconds; mortiφ respawns the Muse host automatically.");
    }
    if (!this.host) {
      this.scheduleReconnect();
      throw new AppError("muse_unavailable", "Muse is reconnecting.", 503, true, "Retry in a few seconds; mortiφ respawns the Muse host automatically.");
    }
  }

  get connection() {
    if (!this.host) throw new AppError("muse_unavailable", "Muse is not connected.", 503, true, "Restart mortiφ and confirm `muse` is installed and authenticated.");
    return this.host.connection;
  }

  health() {
    return {
      connected: this.isConnected(),
      shutdown: this.shutdown,
      reconnectAttempt: this.reconnectAttempt,
      reconnectScheduled: Boolean(this.reconnectTimer),
      lastExit: this.lastExit ?? null,
      subscriptions: this.subscribed.size,
      inFlightCommands: [...this.inFlightCommands.entries()].map(([sessionId, commandIds]) => ({ sessionId, commandIds: [...commandIds] })),
      pendingReattach: [...this.pendingReattach],
      projections: this.projections.size,
      pendingReleases: this.releaseTimers.size,
      readOnlySessions: [...this.readOnlyIds],
      quarantined: [...this.quarantined.entries()].map(([sessionId, reason]) => ({ sessionId, reason })),
      failures: [...this.failures.values()].slice(-20).reverse(),
      stderrTail: this.stderr.slice(-20),
    };
  }

  private recordFailure(sessionId: string | undefined, method: string, failure: AppError, rawMessage: string) {
    logBridge("muse_request_failed", { method, sessionId: sessionId ?? null, kind: failure.museKind ?? null, code: failure.museCode ?? null, category: failure.category ?? null });
    if (!sessionId) return;
    this.failures.set(sessionId, {
      sessionId,
      method,
      message: rawMessage || failure.message,
      kind: failure.museKind,
      code: failure.museCode,
      category: failure.category,
      at: new Date().toISOString(),
    });
    if (this.failures.size > 100) {
      const oldest = this.failures.keys().next();
      if (!oldest.done) this.failures.delete(oldest.value);
    }
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
      connected: this.isConnected(),
      grantedCapabilities: init.grantedCapabilities,
      unsupported: ["Login/logout", "Skills management", "MCP configuration", "Export/trace", "Account quota", "Muse-native delete/archive", "Muse-native task naming", "Worktree/sandbox launch controls", "Interactive terminal"],
    };
  }

  async listSessions(cursor?: string | null, workspaceRoot?: string): Promise<SessionListResponse> {
    const result = await this.request("session/list", compact({ cursor, limit: 100, workspaceRoot }));
    const sessions = (Array.isArray(result.sessions) ? result.sessions.map(asJson) : []).filter((session) => !isInternalSmokeWorkspace(text(session.workspaceRoot)) && !this.visibility.has(text(session.sessionId) ?? ""));
    // Titles are a persistent cache: only sessions never seen before pay for a
    // full history read, once. Everything else resolves from the cache, and
    // failures quarantine the session instead of poisoning the title.
    await Promise.all(sessions.slice(0, 30).map(async (session) => {
      const id = text(session.sessionId); if (!id || this.labels.get(id) || this.titles.get(id)) return;
      try {
        const read = await this.request("session/read", { sessionId: id, excludeItems: false });
        this.titles.set(id, deriveTitle(historyItems(read.history)));
      } catch (error) {
        const failure = error instanceof AppError ? error : transportError(error, "session/read");
        this.recordFailure(id, "session/read", failure, messageFrom(error));
        if (failure.category === "gone") this.quarantined.set(id, failure.message);
      }
    }));
    return {
      sessions: sessions.map((session) => this.summary(session)),
      nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
    };
  }

  async readSession(sessionId: string) {
    this.assertVisible(sessionId);
    let result: Json;
    try {
      result = await this.request("session/read", { sessionId, excludeItems: false });
    } catch (error) {
      const failure = error instanceof AppError ? error : transportError(error, "session/read");
      if (failure.category === "gone") this.quarantined.set(sessionId, failure.message);
      throw error;
    }
    const session = asJson(result.session);
    const items = historyItems(result.history);
    this.titles.set(sessionId, deriveTitle(items));
    this.quarantined.delete(sessionId);
    const summary = this.summary(session);
    if (this.readOnlyIds.has(sessionId)) summary.readOnly = true;
    return { session: summary, items, history: result.history, pendingRequests: result.pendingRequests, viewCursor: result.viewCursor };
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

  async resync(sessionId: string) {
    return this.attach(sessionId, true);
  }

  async attach(sessionId: string, force = false) {
    this.assertVisible(sessionId);
    const pending = this.attaching.get(sessionId);
    if (pending) return pending;
    const operation = this.attachSession(sessionId, force);
    this.attaching.set(sessionId, operation);
    try { return await operation; }
    finally { this.attaching.delete(sessionId); }
  }

  private async attachSession(sessionId: string, force: boolean) {
    this.retain(sessionId);
    const existing = this.projections.get(sessionId);
    if (!force && existing && !existing.needsResync && !existing.readOnly && this.subscribed.has(sessionId)) return existing;
    let read: Json;
    try {
      read = await this.request("session/read", { sessionId, excludeItems: false });
    } catch (error) {
      const failure = error instanceof AppError ? error : transportError(error, "session/read");
      if (failure.category === "gone") this.quarantined.set(sessionId, failure.message);
      throw error;
    }
    const session = asJson(read.session);
    const projection = new SessionProjection(session, this.options.maxJournal);
    if (existing) {
      // Only tear down a view this host actually holds. After a host death the
      // claim is already queued for re-attach, and unsubscribing on a fresh
      // host just manufactures a failure record.
      if (this.subscribed.has(sessionId)) await this.request("view/unsubscribe", { sessionId }).catch(() => undefined);
    }
    this.subscribed.delete(sessionId);
    const buffer: Array<{ method: string; params: Json; emittedAtMs?: number }> = [];
    this.buffered.set(sessionId, buffer);
    let resumedSuccessfully = false;
    try {
      const resumed = await this.command("session/resume", { sessionId, excludeItems: false });
      resumedSuccessfully = true;
      const host = this.host;
      const resumedSession = asJson(resumed.session);
      projection.reset({ ...session, ...resumedSession });
      await this.hydrateHistory(projection, sessionId, asJson(resumed.history));
      const pending = await this.request("approval/listPending", { sessionId });
      projection.replacePending(pending);
      if (host !== this.host) throw new AppError("muse_unavailable", "Connection changed while restoring this task.", 503, true, "Reconnecting automatically.");
      for (const event of buffer) projection.apply(event.method, event.params, event.emittedAtMs);
    } catch (error) {
      // Pending/history failures must be retried; only a definitive resume
      // rejection permits falling back to a stored read-only transcript.
      const failure = error instanceof AppError ? error : transportError(error, "session/resume");
      if (failure.category === "gone") {
        this.quarantined.set(sessionId, failure.message);
        this.projections.delete(sessionId);
        throw error;
      }
      if (failure.retryable || resumedSuccessfully) {
        existing?.disconnect();
        this.pendingReattach.add(sessionId);
        this.scheduleReconnect();
        throw error;
      }
      // Muse can read this session but not resume it (e.g. a log it wrote but
      // can no longer fold). Open read-only from the read above instead of
      // throwing: the transcript stays viewable, writes are blocked.
      projection.readOnly = true;
      projection.reset(session);
      await this.hydrateHistory(projection, sessionId, asJson(read.history));
      this.readOnlyIds.add(sessionId);
      this.quarantined.delete(sessionId);
      this.recordFailure(sessionId, "session/resume", failure, messageFrom(error));
      logBridge("session_readonly", { sessionId, kind: failure.museKind ?? null, code: failure.museCode ?? null });
      this.titles.set(sessionId, deriveTitle(projection.snapshot().items));
      if (existing) existing.restore(projection);
      const result = existing ?? projection;
      this.projections.set(sessionId, result);
      return result;
    } finally {
      this.buffered.delete(sessionId);
    }
    this.subscribed.add(sessionId);
    this.readOnlyIds.delete(sessionId);
    this.quarantined.delete(sessionId);
    if (existing) existing.restore(projection);
    const result = existing ?? projection;
    this.projections.set(sessionId, result);
    this.pendingReattach.delete(sessionId);
    this.titles.set(sessionId, deriveTitle(projection.snapshot().items));
    return result;
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
    return this.withSessionLoaded(sessionId, async (projection) => {
      this.assertWritable(projection, sessionId);
      this.assertSubmissionResolved(sessionId, projection);
      // Pin one client-minted commandId per send so a drop mid-send can be
      // reconciled against the admitted turn instead of re-issued as a dup.
      const commandId = this.mintCommandId();
      this.trackInFlight(sessionId, commandId);
      const priorActive = typeof projection.snapshot === "function" ? projection.snapshot().state.activeTurnId : null;
      try {
        const result = await this.command("turn/start", { sessionId, input, displayText: displayText(input), reasoningEffort: effort, ifBusy }, { commandId });
        projection.admitTurn(result);
        return result;
      } catch (error) {
        return this.reconcileTurnSend(sessionId, projection, "turn/start", commandId, error, "admitted", priorActive);
      } finally {
        this.untrackInFlight(sessionId, commandId);
      }
    });
  }

  async steer(sessionId: string, expectedTurnId: string, input: TurnInputPart[], effort?: ReasoningEffort) {
    return this.withSessionLoaded(sessionId, async (projection) => {
      this.assertWritable(projection, sessionId);
      this.assertSubmissionResolved(sessionId, projection);
      const commandId = this.mintCommandId();
      this.trackInFlight(sessionId, commandId);
      // A steer carries no new turnId (its input is absorbed into the running
      // turn), so remember which turn this commandId targeted for reconcile.
      // Read in catch below; deleted in finally after reconcile has run.
      this.steerCommands.set(commandId, expectedTurnId);
      try {
        return await this.command("turn/steer", compact({ sessionId, expectedTurnId, input, reasoningEffort: effort }), { commandId });
      } catch (error) {
        return this.reconcileTurnSend(sessionId, projection, "turn/steer", commandId, error, "absorbed", expectedTurnId);
      } finally {
        this.steerCommands.delete(commandId);
        this.untrackInFlight(sessionId, commandId);
      }
    });
  }
  async interrupt(sessionId: string, turnId?: string) {
    return this.withSessionLoaded(sessionId, async (projection) => {
      const result = await this.command("turn/interrupt", compact({ sessionId, turnId, retract: true }));
      const targeted = text(result.turnId) ?? turnId;
      if (targeted) projection.markStopping(targeted);
      return result;
    });
  }
  async cancel(sessionId: string, turnId?: string) {
    return this.withSessionLoaded(sessionId, async () => this.command("turn/cancel", compact({ sessionId, turnId })));
  }
  async unqueue(sessionId: string, turnId: string) {
    return this.withSessionLoaded(sessionId, async () => this.command("turn/unqueue", { sessionId, turnId }));
  }
  private async withSessionLoaded<T>(sessionId: string, fn: (projection: SessionProjection) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.attach(sessionId));
    } catch (error) {
      if (!isSessionNotLoaded(error)) throw error;
      return await fn(await this.attach(sessionId, true));
    }
  }
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
      this.releaseTimers.delete(sessionId);
      const snapshot = this.projections.get(sessionId)?.snapshot();
      const busy = snapshot && (snapshot.state.activeTurnId || snapshot.state.queuedTurns.length || snapshot.pending.approvals.length || snapshot.pending.userInputs.length);
      if (busy || !this.subscribed.has(sessionId)) return;
      // Drop the bookkeeping before the request, not in its `.then`. Once we have asked muse to
      // tear the view down we can no longer claim a live subscription: if the call fails (or is
      // still in flight when the next turn starts) the swallowed rejection would leave
      // `subscribed` stale-true, attach() would early-return forever, and the session would go
      // permanently blind — turns run on the host while no turn/* or item/* event ever arrives.
      // Being wrong the other way is harmless: attach() unsubscribes before it resumes.
      this.subscribed.delete(sessionId);
      try {
        void this.connection.request("view/unsubscribe", { sessionId }).catch(() => undefined);
      } catch {
        // Host already gone. The bookkeeping above is the load-bearing part;
        // there is nothing left to unsubscribe from.
      }
    }, 20_000);
    timer.unref();
    this.releaseTimers.set(sessionId, timer);
  }

  isReadOnly(sessionId: string) { return this.readOnlyIds.has(sessionId); }

  private assertWritable(projection: SessionProjection, sessionId: string) {
    if (projection.readOnly || this.readOnlyIds.has(sessionId)) {
      throw new AppError("session_readonly", "This task is open read-only because Muse cannot resume it.", 409, false, "Fork the task into a new session to keep working; the transcript remains viewable here.");
    }
  }

  private assertSubmissionResolved(sessionId: string, projection: SessionProjection) {
    const uncertain = this.uncertainSends.get(sessionId);
    if (!uncertain) return;
    if (this.findAdmittedTurnId(projection, uncertain.commandId)) this.uncertainSends.delete(sessionId);
    else throw uncertain.error;
  }

  async close() {
    this.shutdown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.pendingReattach.clear();
    this.inFlightCommands.clear();
    this.steerCommands.clear();
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.subscribed.clear();
    if (this.host) await this.host.close();
    this.host = undefined;
    await this.titles.flush();
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
      status: projection?.state.connection === "disconnected" ? "reconnecting" : active || rawStatus === "running" ? "running" : queued ? "queued" : pending ? "waiting" : "idle",
      activeTurnId: active,
      modelId: text(session.modelId) ?? null,
      providerId: text(session.providerId) ?? null,
      approvalMode: (asJson(session.approvalMode).mode as SessionSummary["approvalMode"]) ?? null,
      createdAt: text(session.createdAt) ?? "",
      updatedAt: text(session.updatedAt) ?? "",
      turnCount: Number(session.turnCount ?? 0),
      forkedFrom: text(asJson(session.forkedFrom).sessionId) ?? null,
      available: Boolean(root),
      readOnly: this.readOnlyIds.has(id),
      unopenableReason: this.quarantined.get(id) ?? null,
    };
  }

  private async request(method: string, params: Json, silent = false): Promise<Json> {
    await this.ensureHost();
    const host = this.host;
    try {
      return await this.connection.request(method, params);
    } catch (error) {
      throw this.noteFailure(method, params, error, silent, host);
    }
  }
  private async command(method: string, params: Json, options?: CommandOptions): Promise<Json> {
    await this.ensureHost();
    const host = this.host;
    try {
      return await this.connection.command(method, params, options);
    } catch (error) {
      throw this.noteFailure(method, params, error, false, host);
    }
  }

  private mintCommandId(): string {
    try {
      return this.connection.mintCommandId();
    } catch {
      // No live host (unit stubs that replace command()/attach()). The real
      // send path always runs after ensureHost, so production ids still come
      // from the connection's single minter.
      return randomUUID();
    }
  }

  private trackInFlight(sessionId: string, commandId: string) {
    const pending = this.inFlightCommands.get(sessionId) ?? new Set<string>();
    pending.add(commandId);
    this.inFlightCommands.set(sessionId, pending);
  }

  private untrackInFlight(sessionId: string, commandId: string) {
    const pending = this.inFlightCommands.get(sessionId);
    if (!pending) return;
    pending.delete(commandId);
    if (!pending.size) this.inFlightCommands.delete(sessionId);
  }

  private async reconcileTurnSend(sessionId: string, projection: SessionProjection, method: string, commandId: string, error: unknown, outcome: "admitted" | "absorbed", priorActive: string | null): Promise<never> {
    if (!isUnknownOutcome(error)) throw error;
    // Reconcile before any resend: if Muse already took this commandId,
    // surfacing that beats re-issuing it as a duplicate.
    const admittedInMemory = this.findAdmittedTurnId(projection, commandId);
    if (admittedInMemory) throw this.unknownTurnOutcome(sessionId, method, commandId, admittedInMemory, error, outcome);
    // Always attempt the metadata leg: sampling connectedness before the send
    // misses the reconnect race (down at capture, transmitted before the ack
    // was lost). Metadata-only — a full history read on every failure would
    // reintroduce the catalog-cost disease this bridge just cured. Only new
    // activity counts: a pre-existing active turn is not evidence our send
    // landed (fresh turns carry turnId == commandId, so ours is unmistakable).
    try {
      const read = await this.request("session/read", { sessionId, excludeItems: true }, true);
      const active = text(asJson(read.session).activeTurnId);
      if (active === commandId) {
        throw this.unknownTurnOutcome(sessionId, method, commandId, active, error, outcome);
      }
    } catch (readError) {
      if (readError instanceof AppError && readError.code === "turn_unknown_outcome") throw readError;
      // Best-effort: a failed reconcile must not mask the original failure.
    }
    const unresolved = new AppError("turn_unknown_outcome", "The connection dropped before this submission could be confirmed.", 409, false,
      "Choose Refresh task in the task menu to check the original submission. Sending is paused until it is confirmed; you can fork to continue with a different request.");
    this.uncertainSends.set(sessionId, { commandId, error: unresolved });
    throw unresolved;
  }

  private findAdmittedTurnId(projection: SessionProjection, commandId: string): string | undefined {
    const snapshot = typeof projection.snapshot === "function" ? projection.snapshot() : undefined;
    const turns = snapshot?.turns ?? [];
    for (const turn of turns) {
      // Fresh turns carry turnId == commandId (SS3.1.4), so match the turn id
      // too: it catches admitted turns whose command echo never arrived.
      if ((turn.commandId === commandId || turn.turnId === commandId) && typeof turn.turnId === "string") return turn.turnId;
    }
    for (const queued of snapshot?.state.queuedTurns ?? []) {
      if ((queued.commandId === commandId || queued.turnId === commandId) && typeof queued.turnId === "string") return queued.turnId;
    }
    for (const item of snapshot?.items ?? []) {
      if ((item.commandId === commandId || item.turnId === commandId) && typeof item.turnId === "string") return item.turnId;
    }
    return undefined;
  }

  private unknownTurnOutcome(sessionId: string, method: string, commandId: string, turnId: string, cause: unknown, outcome: "admitted" | "absorbed"): AppError {
    // retryable is deliberately false: no generic retry loop may resend this.
    // A retry with a fresh key would manufacture the duplicate turn this
    // error exists to prevent; resyncing observes the original instead.
    const failure = new AppError(
      "turn_unknown_outcome",
      outcome === "admitted"
        ? `Muse admitted turn ${turnId} but the confirmation was lost in a connection drop.`
        : `Muse may have absorbed steer ${commandId} into turn ${turnId} before the connection dropped.`,
      409,
      false,
      "Resync the task to observe it. Do not resend — a resend would create a duplicate turn.",
    );
    this.recordFailure(sessionId, method, failure, `${messageFrom(cause)} (command ${commandId}, turn ${turnId})`);
    logBridge("turn_unknown_outcome", { method, sessionId, commandId, turnId });
    return failure;
  }

  private noteFailure(method: string, params: Json, error: unknown, silent = false, host = this.host): AppError {
    const raw = messageFrom(error);
    // Already classified (a previous transportError, or a hand-built AppError
    // carrying kind/category): re-wrapping would discard the kind, category,
    // and friendly message, so record and pass through untouched.
    if (error instanceof AppError && (error.code !== "muse_operation_failed" || error.category !== undefined)) {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!silent) this.recordFailure(sessionId, method, error, raw);
      return error;
    }
    const failure = transportError(error, method);
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    // A transport-level failure under a live claim means the host died beneath
    // us (possibly before `connection.closed` fires). Drop the claim so the
    // supervised respawn takes over instead of serving a dead connection.
    if (/closed|transport|EPIPE|ECONNRESET|not connected/i.test(raw) && host && this.host === host) {
      this.onHostClosed(`transport:${method}`);
    }
    // Silent reads are best-effort probes (reconcile): recording them would
    // overwrite the real operation's entry in the per-session failure map.
    if (!silent) this.recordFailure(sessionId, method, failure, raw);
    return failure;
  }

  private assertVisible(sessionId: string) {
    if (this.visibility.has(sessionId)) throw new AppError("task_removed", "This task was removed from mortiφ.", 404, false, "The Muse session is preserved, but restoring hidden tasks is not exposed yet.");
  }
}

function transportError(error: unknown, method: string) {
  const raw = messageFrom(error);
  const { category, retryable, kind, code } = classifyMuseError(error);
  const friendly = friendlyMuseMessage(kind, method, raw);
  const failure = new AppError("muse_operation_failed", friendly.message, category === "gone" ? 404 : 409, retryable, friendly.remediation);
  failure.museCode = code;
  failure.museKind = kind;
  failure.category = category;
  return failure;
}

function logBridge(event: string, fields: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: "muse-bridge", event, ...fields }));
}
function isUnknownOutcome(error: unknown) {
  // Known pre-admission rejections can be retried. Transport failures remain
  // uncertain even when a metadata read cannot find an active turn.
  if (!(error instanceof AppError)) return true;
  if (isSessionNotLoaded(error) || ["overloaded", "backpressured"].includes(error.museKind ?? "")) return false;
  if (error.code === "muse_unavailable") return false;
  if (error.code !== "muse_operation_failed") return false;
  return error.retryable === true;
}
function isSessionNotLoaded(error: unknown) {
  if (error instanceof AppError && (error.museKind === "sessionNotLoaded" || error.museCode === -32024)) return true;
  return /not loaded on this host/i.test(messageFrom(error));
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
