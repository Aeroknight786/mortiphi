import type { ProjectionEvent, SessionProjectionSnapshot } from "../shared/contracts.js";

// Silence window before a still-"running" turn is treated as orphaned.
// Streaming turns emit item/delta every few seconds and host reconnects take
// seconds, so 120s of zero events for the active turn means no live host will
// ever terminal it. Tunable per call via markStaleTurns(nowMs, maxSilenceMs).
export const STALE_TURN_SILENCE_MS = 120_000;

const KNOWN = new Set([
  "turn/started", "turn/completed", "turn/retracted", "turn/retryScheduled", "turn/unqueued",
  "item/started", "item/updated", "item/delta", "item/completed", "view/gap",
  "approval/request", "approval/requested", "approval/updated", "approval/resolved",
  "userInput/request", "userInput/requested", "userInput/settled",
  "session/modelChanged", "session/approvalModeChanged", "session/branchChanged", "session/goalChanged",
  "session/todoListChanged", "session/tokenUsage", "session/contextUsage",
]);

export class SessionProjection {
  revision = 0;
  readOnly = false;
  session: Record<string, unknown>;
  private itemOrder: string[] = [];
  private itemsById = new Map<string, Record<string, unknown>>();
  private turnsById = new Map<string, Record<string, unknown>>();
  private approvals = new Map<string, Record<string, unknown>>();
  private userInputs = new Map<string, Record<string, unknown>>();
  private journal: ProjectionEvent[] = [];
  private turnLastEventAtMs = new Map<string, number>();
  private listeners = new Set<(event: ProjectionEvent | { type: "resyncRequired" }) => void>();
  private maxJournal: number;
  needsResync = false;
  state: SessionProjectionSnapshot["state"] = {
    activeTurnId: null,
    stoppingTurnId: null,
    queuedTurns: [],
    model: null,
    approvalMode: null,
    branch: null,
    goal: null,
    todos: null,
    tokenUsage: null,
    contextUsage: null,
    connection: "connected",
    unknownEvents: [],
  };

  constructor(session: Record<string, unknown>, maxJournal = 800) {
    this.session = { ...session };
    this.maxJournal = maxJournal;
    this.state.activeTurnId = typeof session.activeTurnId === "string" ? session.activeTurnId : null;
    this.state.model = session.modelId ? { modelId: session.modelId, providerId: session.providerId ?? null } : null;
    this.state.approvalMode = session.approvalMode && typeof session.approvalMode === "object" ? session.approvalMode as Record<string, unknown> : null;
  }

  reset(session: Record<string, unknown>) {
    this.session = { ...session };
    this.itemOrder = [];
    this.itemsById.clear();
    this.turnsById.clear();
    this.approvals.clear();
    this.userInputs.clear();
    this.turnLastEventAtMs.clear();
    this.needsResync = false;
    this.state = {
      activeTurnId: typeof session.activeTurnId === "string" ? session.activeTurnId : null,
      stoppingTurnId: null,
      queuedTurns: [], model: null, approvalMode: asRecord(session.approvalMode), branch: null,
      goal: null, todos: null, tokenUsage: null, contextUsage: null,
      connection: "connected", unknownEvents: [],
    };
  }

  seedItems(items: Array<Record<string, unknown>>) {
    for (const item of items) this.putItem(item);
  }

  seedSnapshot(snapshot: Record<string, unknown>) {
    const state = snapshot.state && typeof snapshot.state === "object" ? snapshot.state as Record<string, unknown> : snapshot;
    if (Array.isArray(state.items)) this.seedItems(state.items as Array<Record<string, unknown>>);
    this.state.activeTurnId = refId(state.activeTurn) ?? this.state.activeTurnId;
    this.state.queuedTurns = Array.isArray(state.queuedTurns) ? state.queuedTurns as Array<Record<string, unknown>> : [];
    this.state.model = asRecord(state.effectiveModel);
    this.state.approvalMode = asRecord(state.approvalMode);
    this.state.branch = asRecord(state.branch);
    this.state.goal = asRecord(state.goal);
    this.state.todos = asRecord(state.todoList);
    this.state.tokenUsage = asRecord(state.tokenUsage);
    this.state.contextUsage = asRecord(state.contextUsage);
    for (const pointer of (state.pendingApprovals as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof pointer.approvalId === "string") this.approvals.set(pointer.approvalId, pointer);
    }
    for (const pointer of (state.pendingUserInputs as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof pointer.userInputId === "string") this.userInputs.set(pointer.userInputId, pointer);
    }
  }

  replacePending(result: Record<string, unknown>) {
    this.approvals.clear();
    this.userInputs.clear();
    for (const approval of asRecords(result.approvals)) {
      if (typeof approval.approvalId === "string") this.approvals.set(approval.approvalId, approval);
    }
    for (const input of asRecords(result.userInputs)) {
      if (typeof input.userInputId === "string") this.userInputs.set(input.userInputId, input);
    }
  }

  apply(method: string, params: Record<string, unknown>, emittedAtMs?: number, replay = false) {
    if (!replay && emittedAtMs) this.session.updatedAt = new Date(emittedAtMs).toISOString();
    if (method === "view/gap") {
      this.needsResync = true;
    } else if (method.startsWith("item/") && method !== "item/delta") {
      const item = asRecord(params.item);
      if (item) this.putItem(item);
    } else if (method === "item/delta") {
      this.applyDelta(params);
    } else if (method === "turn/started") {
      const turnId = string(params.turnId);
      if (turnId) {
        this.turnsById.set(turnId, { ...params, state: "running" });
        this.state.activeTurnId = turnId;
        this.state.queuedTurns = this.state.queuedTurns.filter((turn) => turn.turnId !== turnId);
      }
    } else if (method === "turn/completed") {
      const turnId = string(params.turnId);
      if (turnId) this.turnsById.set(turnId, { ...(this.turnsById.get(turnId) ?? {}), ...params, state: params.terminal ?? "completed" });
      if (!turnId || this.state.activeTurnId === turnId) this.state.activeTurnId = null;
      if (!turnId || this.state.stoppingTurnId === turnId) this.state.stoppingTurnId = null;
    } else if (method === "turn/retracted") {
      const turnId = string(params.turnId);
      if (turnId) this.turnsById.set(turnId, { ...(this.turnsById.get(turnId) ?? {}), ...params, state: "retracted" });
      if (this.state.activeTurnId === turnId) this.state.activeTurnId = null;
      if (this.state.stoppingTurnId === turnId) this.state.stoppingTurnId = null;
    } else if (method === "turn/unqueued") {
      const turnId = string(params.turnId);
      this.state.queuedTurns = this.state.queuedTurns.filter((turn) => turn.turnId !== turnId);
      if (turnId) this.turnsById.set(turnId, { ...params, state: "unqueued" });
    } else if (method === "turn/retryScheduled") {
      const turnId = string(params.turnId);
      if (turnId) this.turnsById.set(turnId, { ...(this.turnsById.get(turnId) ?? {}), retry: params });
    } else if (method === "approval/request" || method === "approval/requested" || method === "approval/updated") {
      const id = string(params.approvalId); if (id) this.approvals.set(id, { ...(this.approvals.get(id) ?? {}), ...params });
    } else if (method === "approval/resolved") {
      const id = string(params.approvalId); if (id) this.approvals.delete(id);
    } else if (method === "userInput/request" || method === "userInput/requested") {
      const id = string(params.userInputId); if (id) this.userInputs.set(id, params);
    } else if (method === "userInput/settled") {
      const id = string(params.userInputId); if (id) this.userInputs.delete(id);
    } else if (method === "session/modelChanged") {
      this.state.model = { modelId: params.modelId, providerId: params.providerId ?? null, source: params.source };
    } else if (method === "session/approvalModeChanged") {
      this.state.approvalMode = { mode: params.mode, source: params.source, clientName: params.clientName };
    } else if (method === "session/branchChanged") {
      this.state.branch = { branch: params.branch ?? null, vcs: params.vcs, workspaceRoot: params.workspaceRoot };
    } else if (method === "session/goalChanged") {
      this.state.goal = asRecord(params.goal);
    } else if (method === "session/todoListChanged") {
      this.state.todos = { items: params.items, revision: params.revision };
    } else if (method === "session/tokenUsage") {
      this.state.tokenUsage = { cumulative: params.cumulative, usage: params.usage };
    } else if (method === "session/contextUsage") {
      this.state.contextUsage = { usedTokens: params.usedTokens, windowTokens: params.windowTokens, pressure: params.pressure };
    } else if (!KNOWN.has(method)) {
      this.state.unknownEvents = [...this.state.unknownEvents.slice(-49), { method, viewCursor: string(params.viewCursor) }];
    }

    this.touchTurn(method, params, emittedAtMs ?? Date.now());

    if (!replay) this.publish(method, params, emittedAtMs);
  }

  admitTurn(result: Record<string, unknown>) {
    const turnId = string(result.turnId);
    if (!turnId) return;
    const disposition = string(result.disposition) ?? "accepted";
    if (disposition === "queued") this.state.queuedTurns = [...this.state.queuedTurns, { turnId, commandId: result.commandId }];
    this.publish("morti/turnAdmission", result);
  }

  markStopping(turnId: string) { this.state.stoppingTurnId = turnId; this.publish("morti/turnStopping", { turnId }); }
  disconnect() { this.state.connection = "disconnected"; this.publish("morti/hostDisconnected", {}); }

  eventsAfter(afterRevision: number) {
    const oldest = this.journal[0]?.revision ?? this.revision + 1;
    if (afterRevision < oldest - 1) return null;
    return this.journal.filter((event) => event.revision > afterRevision);
  }

  subscribe(listener: (event: ProjectionEvent | { type: "resyncRequired" }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  markStaleTurns(nowMs = Date.now(), maxSilenceMs = STALE_TURN_SILENCE_MS): string[] {
    // Staleness is only meaningful when no live host can still terminal the
    // turn. A connected host goes quiet all the time (long tool executions
    // emit nothing between item/started and item/completed, reasoning is
    // never streamed), so marking there would false-positive on healthy
    // turns — and since release()'s busy-check reads snapshot(), a false
    // stale would unsubscribe the live view, guaranteeing no terminal ever
    // arrives (self-fulfilling). Gate on disconnection instead.
    if (this.state.connection === "connected") return [];
    // A turn blocked on pending approvals/inputs is waiting on the user, not
    // on a dead host. Never stale those: clearing activeTurnId there would let
    // the user start a duplicate turn behind the pending request.
    if (this.approvals.size > 0 || this.userInputs.size > 0) return [];
    const marked: string[] = [];
    const staleReason = "Muse went silent on this turn for over two minutes. It will not resume on its own — resend the prompt to retry.";
    for (const [turnId, turn] of this.turnsById) {
      if (turn.state !== "running" || !this.isTurnSilent(turnId, nowMs, maxSilenceMs)) continue;
      this.turnsById.set(turnId, { ...turn, state: "stale", reason: turn.reason ?? staleReason });
      marked.push(turnId);
    }
    const active = this.state.activeTurnId;
    if (active && (this.turnsById.get(active)?.state === "stale" ||
        (!this.turnsById.has(active) && this.isTurnSilent(active, nowMs, maxSilenceMs)))) {
      if (!this.turnsById.has(active)) {
        this.turnsById.set(active, { turnId: active, state: "stale", reason: staleReason });
        marked.push(active);
      }
      this.state.activeTurnId = null;
    }
    if (this.state.stoppingTurnId && marked.includes(this.state.stoppingTurnId)) this.state.stoppingTurnId = null;
    if (marked.length > 0) {
      // Journal the transition so SSE clients observe it: a silent mutation
      // would leave event-stream readers believing they are current while
      // pollers see a stale turn. A late terminal still folds over the marker
      // via apply().
      this.publish("morti/turnStale", { turnIds: marked });
    }
    return marked;
  }

  snapshot(): SessionProjectionSnapshot {
    // Lazy so every reader (bridge summary, event stream, client) applies the
    // same rule with no caller changes.
    this.markStaleTurns();
    return {
      revision: this.revision,
      readOnly: this.readOnly,
      session: { ...this.session, activeTurnId: this.state.activeTurnId },
      items: this.itemOrder.map((id) => this.itemsById.get(id)!).filter(Boolean),
      turns: [...this.turnsById.values()],
      state: structuredClone(this.state),
      pending: { approvals: [...this.approvals.values()], userInputs: [...this.userInputs.values()] },
    };
  }

  private putItem(item: Record<string, unknown>) {
    const id = string(item.itemId); if (!id) return;
    const prior = this.itemsById.get(id);
    const nextRevision = Number(item.revision ?? 0);
    const priorRevision = Number(prior?.revision ?? -1);
    if (prior && nextRevision < priorRevision) return;
    if (!prior) this.itemOrder.push(id);
    this.itemsById.set(id, { ...(prior ?? {}), ...item });
  }

  private touchTurn(method: string, params: Record<string, unknown>, atMs: number) {
    // Direct turn refs only come from turn/* and item/* events. Anything else
    // (approvals, usage, todos) still proves the active turn's host is alive.
    if (method.startsWith("turn/") || method.startsWith("item/")) {
      const turnId = string(params.turnId) ?? string(asRecord(params.item)?.turnId) ?? this.turnIdForItem(string(params.itemId));
      if (turnId) this.turnLastEventAtMs.set(turnId, atMs);
    }
    const active = this.state.activeTurnId;
    if (active) {
      const prior = this.turnLastEventAtMs.get(active);
      if (prior === undefined || atMs >= prior) this.turnLastEventAtMs.set(active, atMs);
    }
  }

  private turnIdForItem(itemId: string | undefined): string | undefined {
    if (!itemId) return undefined;
    const turnId = this.itemsById.get(itemId)?.turnId;
    return typeof turnId === "string" ? turnId : undefined;
  }

  private isTurnSilent(turnId: string, nowMs: number, maxSilenceMs: number): boolean {
    const last = this.turnLastEventAtMs.get(turnId);
    if (last !== undefined) return nowMs - last > maxSilenceMs;
    // No event ever named this turn (e.g. activeTurnId restored from a read
    // with no replayed history): fall back to the session clock, and stay
    // conservative when that is missing or unparseable.
    const updatedAt = Date.parse(String(this.session.updatedAt ?? ""));
    return Number.isFinite(updatedAt) && nowMs - updatedAt > maxSilenceMs;
  }

  private applyDelta(params: Record<string, unknown>) {
    const id = string(params.itemId); if (!id) return;
    const item = { ...(this.itemsById.get(id) ?? { itemId: id, kind: "unknown", status: "inProgress", revision: 0 }) };
    if (!this.itemsById.has(id)) this.itemOrder.push(id);
    const field = string(params.field) ?? "text";
    const delta = string(params.delta) ?? "";
    if (field.startsWith("summary.")) {
      const index = Number(field.split(".")[1]);
      const summary = Array.isArray(item.summary) ? [...item.summary] : [];
      summary[index] = `${summary[index] ?? ""}${delta}`;
      item.summary = summary;
    } else {
      const key = field === "output" ? "visibleOutput" : field;
      item[key] = `${typeof item[key] === "string" ? item[key] : ""}${delta}`;
    }
    this.itemsById.set(id, item);
  }

  private publish(method: string, params: Record<string, unknown>, emittedAtMs?: number) {
    const event = { revision: ++this.revision, method, params, emittedAtMs };
    this.journal.push(event);
    if (this.journal.length > this.maxJournal) this.journal.shift();
    for (const listener of this.listeners) listener(this.needsResync ? { type: "resyncRequired" } : event);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function asRecords(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)) : []; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function refId(value: unknown): string | null { return asRecord(value) && typeof asRecord(value)!.turnId === "string" ? asRecord(value)!.turnId as string : null; }
