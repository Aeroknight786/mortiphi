import { describe, expect, it } from "vitest";
import { SessionProjection, STALE_TURN_SILENCE_MS } from "../src/server/session-projection.js";

// T0 tracks the real clock: snapshot() applies the rule with Date.now(), so
// fixtures must be fresh relative to now except where a test pins emittedAtMs
// or updatedAt into the past on purpose.
const T0 = Date.now();
const base = { sessionId: "s1", workspaceRoot: "/tmp/project", activeTurnId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: new Date(T0).toISOString() };
const p = (extra: Record<string, unknown> = {}) => ({ sessionId: "s1", viewCursor: crypto.randomUUID(), ...extra });

describe("turn staleness", () => {
  it("never marks on a connected host, however quiet the turn", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }), T0);
    // A long tool execution emits nothing for minutes on a healthy host;
    // silence is only meaningful once no live host can still terminal it.
    expect(projection.markStaleTurns(T0 + STALE_TURN_SILENCE_MS + 1)).toEqual([]);
    expect(projection.snapshot().state.activeTurnId).toBe("t1");
  });

  it("marks a silent running turn stale and frees the session for retry", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }), T0);
    projection.disconnect();
    expect(projection.markStaleTurns(T0 + STALE_TURN_SILENCE_MS + 1)).toEqual(["t1"]);
    const snapshot = projection.snapshot();
    expect(snapshot.turns[0]?.state).toBe("stale");
    expect(snapshot.state.activeTurnId).toBeNull();
  });

  it("keeps a streaming turn running via item events without a turnId", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }), T0);
    projection.apply("item/started", p({ item: { itemId: "i1", turnId: "t1", kind: "agentMessage", status: "inProgress", revision: 1 } }), T0);
    // item/delta carries no turnId; the stored item maps it back to the turn.
    projection.apply("item/delta", p({ itemId: "i1", delta: "more" }), T0 + STALE_TURN_SILENCE_MS);
    projection.disconnect();
    expect(projection.markStaleTurns(T0 + STALE_TURN_SILENCE_MS + 10)).toEqual([]);
    const snapshot = projection.snapshot();
    expect(snapshot.turns[0]?.state).toBe("running");
    expect(snapshot.state.activeTurnId).toBe("t1");
  });

  it("never stales a turn waiting on approval or user input", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }), T0);
    projection.apply("approval/requested", p({ approvalId: "a1", availableChoices: [] }), T0);
    projection.disconnect();
    expect(projection.markStaleTurns(T0 + STALE_TURN_SILENCE_MS + 1)).toEqual([]);
    expect(projection.snapshot().state.activeTurnId).toBe("t1");
  });

  it("still folds a late terminal event after staleness", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }), T0);
    projection.disconnect();
    projection.markStaleTurns(T0 + STALE_TURN_SILENCE_MS + 1);
    projection.apply("turn/completed", p({ turnId: "t1", terminal: "completed" }), T0 + STALE_TURN_SILENCE_MS + 2);
    const snapshot = projection.snapshot();
    expect(snapshot.turns[0]?.state).toBe("completed");
    expect(snapshot.state.activeTurnId).toBeNull();
  });

  it("clears a dangling activeTurnId with an old session clock", () => {
    const withActive = { ...base, activeTurnId: "t9", updatedAt: new Date(T0 - STALE_TURN_SILENCE_MS - 1).toISOString() };
    const projection = new SessionProjection(withActive);
    projection.disconnect();
    expect(projection.markStaleTurns(T0)).toEqual(["t9"]);
    const snapshot = projection.snapshot();
    expect(snapshot.state.activeTurnId).toBeNull();
    expect(snapshot.turns[0]).toMatchObject({ turnId: "t9", state: "stale" });
  });

  it("keeps a dangling activeTurnId when the session clock is fresh", () => {
    const withActive = { ...base, activeTurnId: "t9" };
    const projection = new SessionProjection(withActive);
    projection.disconnect();
    expect(projection.markStaleTurns(T0 + 1000)).toEqual([]);
    expect(projection.snapshot().state.activeTurnId).toBe("t9");
  });

  it("never stales when the session clock is missing", () => {
    const { updatedAt: _dropped, ...noClock } = base;
    const withActive = { ...noClock, activeTurnId: "t9" };
    const projection = new SessionProjection(withActive);
    projection.disconnect();
    expect(projection.markStaleTurns(T0 + STALE_TURN_SILENCE_MS + 1)).toEqual([]);
    expect(projection.snapshot().state.activeTurnId).toBe("t9");
  });

  it("never stales non-running turns", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }), T0);
    projection.apply("turn/unqueued", p({ turnId: "t1" }), T0);
    projection.disconnect();
    expect(projection.markStaleTurns(T0 + STALE_TURN_SILENCE_MS + 1)).toEqual([]);
    expect(projection.snapshot().turns[0]?.state).toBe("unqueued");
  });

  it("journals the stale transition once so SSE readers observe it", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }), Date.now() - STALE_TURN_SILENCE_MS - 1000);
    projection.disconnect();
    const before = projection.revision;
    const snapshot = projection.snapshot();
    expect(snapshot.turns[0]?.state).toBe("stale");
    expect(snapshot.state.activeTurnId).toBeNull();
    const events = projection.eventsAfter(before) ?? [];
    expect(events.map((event) => event.method)).toContain("morti/turnStale");
    // A second snapshot marks nothing new and publishes nothing further.
    const after = projection.snapshot().revision;
    expect(projection.eventsAfter(after)).toEqual([]);
  });
});
