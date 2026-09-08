import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProjection } from "../src/server/session-projection.js";

afterEach(() => vi.useRealTimers());

describe("disconnected turn truth", () => {
  it("publishes disconnection immediately without fabricating failure after silence", () => {
    vi.useFakeTimers();
    const projection = new SessionProjection({ sessionId: "S", activeTurnId: "T" });
    projection.apply("turn/started", { turnId: "T" });
    projection.markStopping("T");
    const events: unknown[] = [];
    projection.subscribe(event => events.push(event));
    projection.disconnect();
    vi.advanceTimersByTime(600_000);
    const snapshot = projection.snapshot();
    expect(snapshot.state).toMatchObject({ connection: "disconnected", activeTurnId: "T", stoppingTurnId: "T" });
    expect(snapshot.turns[0]?.state).toBe("running");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ method: "morti/hostDisconnected" });
    projection.apply("turn/completed", { turnId: "T", terminal: "completed" });
    expect(projection.snapshot().state.activeTurnId).toBeNull();
  });

  it("keeps listeners and increasing revisions across an authoritative restore", () => {
    const projection = new SessionProjection({ sessionId: "S", activeTurnId: "T" });
    projection.disconnect();
    const before = projection.revision;
    const events: unknown[] = [];
    projection.subscribe(event => events.push(event));
    const restored = new SessionProjection({ sessionId: "S", activeTurnId: null });
    restored.apply("turn/completed", { turnId: "T", terminal: "completed" }, undefined, true);
    projection.restore(restored);
    projection.apply("turn/started", { turnId: "T2" });
    expect(projection.revision).toBeGreaterThan(before);
    expect(events).toHaveLength(2);
    expect(projection.snapshot().state).toMatchObject({ connection: "connected", activeTurnId: "T2" });
  });
});
