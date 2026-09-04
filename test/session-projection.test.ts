import { describe, expect, it } from "vitest";
import { SessionProjection } from "../src/server/session-projection.js";

const base = { sessionId: "s1", workspaceRoot: "/tmp/project", activeTurnId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const p = (extra: Record<string, unknown> = {}) => ({ sessionId: "s1", viewCursor: crypto.randomUUID(), ...extra });

describe("SessionProjection", () => {
  it("folds items, deltas, turn lifecycle, state and pending requests", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }));
    projection.apply("item/started", p({ item: { itemId: "i1", turnId: "t1", kind: "agentMessage", status: "inProgress", revision: 1, text: "Hi" } }));
    projection.apply("item/delta", p({ itemId: "i1", delta: " there" }));
    projection.apply("approval/requested", p({ approvalId: "a1", availableChoices: [] }));
    projection.apply("userInput/requested", p({ userInputId: "u1", questions: [] }));
    projection.apply("session/modelChanged", p({ modelId: "muse-model", providerId: "provider", source: "user" }));
    projection.apply("session/contextUsage", p({ usedTokens: 50, windowTokens: 100, pressure: "low" }));
    projection.apply("turn/retryScheduled", p({ turnId: "t1", attempt: 1, nextAttempt: 2, maxAttempts: 3 }));
    projection.apply("turn/completed", p({ turnId: "t1", terminal: "completed" }));
    const snapshot = projection.snapshot();
    expect(snapshot.items[0]?.text).toBe("Hi there");
    expect(snapshot.state.activeTurnId).toBeNull();
    expect(snapshot.state.model?.modelId).toBe("muse-model");
    expect(snapshot.state.contextUsage?.usedTokens).toBe(50);
    expect(snapshot.pending.approvals).toHaveLength(1);
    expect(snapshot.pending.userInputs).toHaveLength(1);
    expect(snapshot.turns[0]?.state).toBe("completed");
    expect(snapshot.turns[0]?.retry).toBeTruthy();
  });

  it("seeds snapshots, preserves unknown additions, and requests resync on gaps", () => {
    const projection = new SessionProjection(base, 2);
    projection.seedSnapshot({ state: { items: [{ itemId: "seed", kind: "newKind", status: "completed", revision: 1, fallbackText: "kept" }], activeTurn: null, queuedTurns: [], effectiveModel: null, approvalMode: null, branch: null, goal: null, todoList: null, tokenUsage: null, contextUsage: null } });
    projection.apply("future/newNotification", p());
    projection.apply("session/goalChanged", p({ goal: { objective: "Ship" } }));
    projection.apply("session/todoListChanged", p({ items: [] }));
    expect(projection.eventsAfter(0)).toBeNull();
    expect(projection.snapshot().state.unknownEvents[0]?.method).toBe("future/newNotification");
    expect(projection.snapshot().items[0]?.fallbackText).toBe("kept");
    projection.apply("view/gap", p());
    expect(projection.needsResync).toBe(true);
  });

  it("does not treat an interrupt admission as terminal", () => {
    const projection = new SessionProjection(base);
    projection.apply("turn/started", p({ turnId: "t1", commandId: "c1" }));
    projection.markStopping("t1");
    expect(projection.snapshot().state.activeTurnId).toBe("t1");
    projection.apply("turn/retracted", p({ turnId: "t1", commandId: "c1" }));
    expect(projection.snapshot().state.activeTurnId).toBeNull();
  });
});
