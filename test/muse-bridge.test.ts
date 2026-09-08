import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError, classifyMuseError, friendlyMuseMessage } from "../src/server/errors.js";
import { MuseBridge } from "../src/server/muse-bridge.js";

function tmpTitles() { return join(tmpdir(), `mortiphi-test-titles-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`); }

function notLoadedError() {
  const error = new AppError("muse_operation_failed", "session S is not loaded on this host", 409, false, "retry");
  error.museCode = -32024;
  error.museKind = "sessionNotLoaded";
  return error;
}

function stubbedBridge() {
  const bridge = new MuseBridge({});
  const attaches: boolean[] = [];
  const stub = bridge as unknown as {
    attach: (sessionId: string, force?: boolean) => Promise<{ admitTurn(result: unknown): void }>;
    command: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  stub.attach = async (_sessionId: string, force = false) => {
    attaches.push(force);
    return { admitTurn() {} };
  };
  return { bridge, attaches, stub };
}

describe("MuseBridge trustWorkspace", () => {
  it("trusts the workspace host by default", () => {
    const bridge = new MuseBridge({});
    expect((bridge as unknown as { options: { trustWorkspace: boolean } }).options.trustWorkspace).toBe(true);
  });

  it("honors MORTIPHI_TRUST_WORKSPACE=0 and explicit options", () => {
    process.env.MORTIPHI_TRUST_WORKSPACE = "0";
    try {
      const bridge = new MuseBridge({});
      expect((bridge as unknown as { options: { trustWorkspace: boolean } }).options.trustWorkspace).toBe(false);
    } finally {
      delete process.env.MORTIPHI_TRUST_WORKSPACE;
    }
    const bridge = new MuseBridge({ trustWorkspace: false });
    expect((bridge as unknown as { options: { trustWorkspace: boolean } }).options.trustWorkspace).toBe(false);
  });
});

describe("MuseBridge withSessionLoaded", () => {
  it("retries once with a forced re-attach on sessionNotLoaded", async () => {
    const { bridge, attaches, stub } = stubbedBridge();
    let commands = 0;
    stub.command = async () => {
      commands += 1;
      if (commands === 1) throw notLoadedError();
      return { turnId: "t1" };
    };
    const result = await bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue");
    expect(result).toMatchObject({ turnId: "t1" });
    expect(commands).toBe(2);
    expect(attaches).toEqual([false, true]);
  });

  it("does not retry other errors", async () => {
    const { bridge, attaches, stub } = stubbedBridge();
    let commands = 0;
    stub.command = async () => {
      commands += 1;
      throw new AppError("muse_operation_failed", "boom", 409, false, "retry");
    };
    await expect(bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue")).rejects.toThrow("boom");
    expect(commands).toBe(1);
    expect(attaches).toEqual([false]);
  });

  it("surfaces the error when the retry also finds the session unloaded", async () => {
    const { bridge, attaches, stub } = stubbedBridge();
    let commands = 0;
    stub.command = async () => {
      commands += 1;
      throw notLoadedError();
    };
    await expect(bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue")).rejects.toThrow("not loaded on this host");
    expect(commands).toBe(2);
    expect(attaches).toEqual([false, true]);
  });
});

describe("MuseBridge release/subscribe bookkeeping", () => {
  it("stops claiming a live view once view/unsubscribe has been issued, even if it fails", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new MuseBridge({});
      const internals = bridge as unknown as {
        subscribed: Set<string>;
        projections: Map<string, unknown>;
        connection: { request(method: string, params: unknown): Promise<unknown> };
      };
      internals.subscribed.add("S");
      internals.projections.set("S", {
        snapshot: () => ({
          state: { activeTurnId: null, queuedTurns: [] },
          pending: { approvals: [], userInputs: [] },
        }),
      });
      let unsubscribes = 0;
      Object.defineProperty(bridge, "connection", {
        value: {
          request: async (method: string) => {
            if (method === "view/unsubscribe") { unsubscribes += 1; throw new Error("transport closed"); }
            return {};
          },
        },
      });

      bridge.release("S");
      await vi.advanceTimersByTimeAsync(20_000);

      expect(unsubscribes).toBe(1);
      // The muse-side view is gone (or in an unknown state). Continuing to claim it is
      // subscribed makes attach() early-return forever, so the session goes blind.
      expect(internals.subscribed.has("S")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MuseBridge attach cursor", () => {
  it("does not resume with session/read's fold head as the view cursor", async () => {
    const bridge = new MuseBridge({ titleStorePath: tmpTitles() });
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const stub = bridge as unknown as {
      request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
      command: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    stub.request = async (method, params) => {
      calls.push({ method, params });
      if (method === "session/read") {
        return { session: { sessionId: "S" }, history: {}, viewCursor: "v:S:1" };
      }
      return {};
    };
    stub.command = async (method, params) => {
      calls.push({ method, params });
      return { session: { sessionId: "S" } };
    };

    await bridge.attach("S");

    const resume = calls.find((call) => call.method === "session/resume");
    expect(resume).toBeDefined();
    // "v:S:1" is session/read's durable-log fold head, not a cursor this client
    // observed on a live view. Muse rejects it with -32011 "unknown cursor
    // anchor" whenever its host already holds the session — i.e. every re-attach.
    expect(resume?.params.cursor).toBeUndefined();
  });
});

describe("failure taxonomy", () => {
  it("marks overload/backpressure transient and retryable", () => {
    for (const kind of ["overloaded", "backpressured"]) {
      const result = classifyMuseError({ code: -32000, data: { kind }, message: "busy" });
      expect(result.category).toBe("transient");
      expect(result.retryable).toBe(true);
    }
  });

  it("marks sessionNotFound gone, not retryable", () => {
    const result = classifyMuseError({ code: -32001, data: { kind: "sessionNotFound" }, message: "missing" });
    expect(result.category).toBe("gone");
    expect(result.retryable).toBe(false);
  });

  it("honors the SDK retryable override over kind defaults", () => {
    expect(classifyMuseError({ data: { kind: "internal" }, retryable: false }).retryable).toBe(false);
    expect(classifyMuseError({ data: { kind: "commandRejected" }, retryable: true }).retryable).toBe(true);
  });

  it("keeps unknown engine errors readable, never raw", () => {
    const result = classifyMuseError(new Error("engine exploded (code 7)"));
    expect(result.category).toBe("readable");
    expect(result.retryable).toBe(false);
    const friendly = friendlyMuseMessage(result.kind, "turn/start", "engine exploded (code 7)");
    expect(friendly.message).not.toContain("engine exploded");
  });
});

describe("MuseBridge host supervision", () => {
  it("drops the host claim on close so later requests reconnect instead of serving death", async () => {
    const bridge = new MuseBridge({ titleStorePath: tmpTitles() });
    (bridge as unknown as { host: unknown }).host = { connection: {} };
    expect(bridge.isConnected()).toBe(true);
    (bridge as unknown as { onHostClosed(reason: string): void }).onHostClosed("test");
    expect(bridge.isConnected()).toBe(false);
    await bridge.close();
    expect(bridge.isConnected()).toBe(false);
  });
});

type FakeCalls = Array<{ kind: "request" | "command"; method: string }>;
type FakeHandler = (kind: "request" | "command", method: string) => Promise<Record<string, unknown>>;

function attachFlow(): FakeHandler {
  return async (_kind, method) => {
    if (method === "session/read") {
      return {
        session: { sessionId: "S", workspaceRoot: "/tmp", createdAt: "", updatedAt: "", turnCount: 0 },
        history: { mode: "inline", items: [{ itemId: "i1", kind: "userMessage", text: "Hello there" }] },
      };
    }
    if (method === "session/resume") return { session: { sessionId: "S" } };
    return { approvals: [], userInputs: [] };
  };
}

function fakeHost(handler: FakeHandler = attachFlow()) {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const calls: FakeCalls = [];
  const wrap = (kind: "request" | "command") => async (method: string) => {
    calls.push({ kind, method });
    return handler(kind, method);
  };
  return {
    host: {
      connection: { onNotification() {}, closed, request: wrap("request"), command: wrap("command") },
      exited: new Promise(() => {}),
      initializeResult: { schema: { version: 1, fingerprint: "x" } },
      close: async () => {},
    },
    calls,
    kill: () => resolveClosed(),
  };
}

describe("MuseBridge host death injection", () => {
  it("respawns the host and re-attaches retained sessions with a live resume", async () => {
    vi.useFakeTimers();
    try {
      const first = fakeHost();
      const second = fakeHost();
      let spawns = 0;
      const bridge = new MuseBridge({
        titleStorePath: tmpTitles(),
        spawnHost: (() => {
          spawns += 1;
          const fake = spawns === 1 ? first : second;
          return { initialize: async () => fake.host };
        }) as any,
      });
      await bridge.initialize();
      await bridge.attach("S");
      expect(spawns).toBe(1);

      first.kill();
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.isConnected()).toBe(false);
      expect(bridge.getProjection("S")?.snapshot().state.connection).toBe("disconnected");
      expect(bridge.health().pendingReattach).toEqual(["S"]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(spawns).toBe(2);
      expect(bridge.isConnected()).toBe(true);
      // The re-attach must run session/resume on the NEW host — an early
      // return here would leave the session permanently blind.
      expect(second.calls).toContainEqual({ kind: "request", method: "session/read" });
      expect(second.calls).toContainEqual({ kind: "command", method: "session/resume" });
      expect(bridge.getProjection("S")?.snapshot().state.connection).toBe("connected");
      expect(bridge.health().pendingReattach).toEqual([]);
      await bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off and retries when the respawn itself fails", async () => {
    vi.useFakeTimers();
    try {
      const good = fakeHost();
      const recovered = fakeHost();
      let spawns = 0;
      const bridge = new MuseBridge({
        titleStorePath: tmpTitles(),
        spawnHost: (() => {
          spawns += 1;
          if (spawns === 1) return { initialize: async () => good.host };
          if (spawns === 2) return { initialize: async () => { throw new Error("muse binary gone"); } };
          return { initialize: async () => recovered.host };
        }) as any,
      });
      await bridge.initialize();
      good.kill();
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.isConnected()).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      expect(spawns).toBe(2);
      expect(bridge.isConnected()).toBe(false);
      expect((bridge as unknown as { reconnectAttempt: number }).reconnectAttempt).toBe(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(spawns).toBe(3);
      expect(bridge.isConnected()).toBe(true);
      expect((bridge as unknown as { reconnectAttempt: number }).reconnectAttempt).toBe(0);
      await bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a transport failure under a live claim drops the host and records the session", async () => {
    const fake = fakeHost(async (kind, method) => {
      if (method === "session/list") throw new Error("transport closed unexpectedly");
      return {};
    });
    const bridge = new MuseBridge({
      titleStorePath: tmpTitles(),
      spawnHost: (() => ({ initialize: async () => fake.host })) as any,
    });
    await bridge.initialize();
    await expect(bridge.listSessions()).rejects.toMatchObject({ code: "muse_operation_failed", retryable: true });
    expect(bridge.isConnected()).toBe(false);
    expect(bridge.health().reconnectScheduled).toBe(true);
    await bridge.close();
  });

  it("concurrent requests during an outage share one connect attempt", async () => {
    const fake = fakeHost(async (_kind, method) => {
      if (method === "session/list") return { sessions: [], nextCursor: null };
      return {};
    });
    let spawns = 0;
    let resolveInit!: (host: unknown) => void;
    const gate = new Promise<unknown>((resolve) => { resolveInit = resolve; });
    const bridge = new MuseBridge({
      titleStorePath: tmpTitles(),
      spawnHost: (() => {
        spawns += 1;
        return { initialize: () => gate };
      }) as any,
    });
    const pending = [bridge.listSessions(), bridge.listSessions()];
    // The first connect blocks on the gate (store loads are disk I/O, not
    // microtasks). The second call must join it, not spawn again.
    await vi.waitFor(() => expect(spawns).toBe(1));
    await Promise.resolve();
    expect(spawns).toBe(1);
    resolveInit(fake.host);
    await expect(Promise.all(pending)).resolves.toHaveLength(2);
    await bridge.close();
  });
});

describe("MuseBridge read-only sessions", () => {
  function readableResumeError() {
    const error = new AppError("muse_operation_failed", "view pruned", 409, false, "retry");
    error.museKind = "viewTruncated";
    error.category = "readable";
    return error;
  }

  function bridgeWithFailingResume() {
    const bridge = new MuseBridge({ titleStorePath: tmpTitles() });
    const stub = bridge as unknown as {
      request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
      command: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    stub.request = async (method) => {
      if (method === "session/read") {
        return {
          session: { sessionId: "S", workspaceRoot: "/tmp", createdAt: "", updatedAt: "", turnCount: 0 },
          history: { mode: "inline", items: [{ itemId: "i1", kind: "userMessage", text: "Hello there" }] },
        };
      }
      return { approvals: [], userInputs: [] };
    };
    stub.command = async (method) => {
      if (method === "session/resume") throw readableResumeError();
      return {};
    };
    return bridge;
  }

  it("opens read-only when muse can read but not resume a session", async () => {
    const bridge = bridgeWithFailingResume();
    const projection = await bridge.attach("S");
    expect(projection.readOnly).toBe(true);
    expect(projection.snapshot().readOnly).toBe(true);
    expect(bridge.isReadOnly("S")).toBe(true);
    await expect(bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue")).rejects.toMatchObject({ code: "session_readonly" });
    await bridge.close();
  });

  it("quarantines gone sessions so the list marks them instead of the click", async () => {
    const bridge = new MuseBridge({ titleStorePath: tmpTitles() });
    const stub = bridge as unknown as {
      request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
      command: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    stub.request = async () => ({ session: { sessionId: "S" }, history: { mode: "inline", items: [] } });
    stub.command = async (method) => {
      if (method === "session/resume") {
        const error = new AppError("muse_operation_failed", "gone", 404, false, "gone");
        error.museKind = "sessionNotFound";
        error.category = "gone";
        throw error;
      }
      return {};
    };
    await expect(bridge.attach("S")).rejects.toMatchObject({ code: "muse_operation_failed" });
    const summary = (bridge as unknown as { summary(session: Record<string, unknown>): { unopenableReason: string | null } })
      .summary({ sessionId: "S", workspaceRoot: "/tmp" });
    expect(summary.unopenableReason).toBeTruthy();
    await bridge.close();
  });
});

describe("MuseBridge session catalog", () => {
  it("reads full history only for titles never seen before", async () => {
    const bridge = new MuseBridge({ titleStorePath: tmpTitles() });
    const stub = bridge as unknown as {
      request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    let reads = 0;
    stub.request = async (method) => {
      if (method === "session/list") {
        return {
          sessions: [
            { sessionId: "S1", workspaceRoot: "/tmp" },
            { sessionId: "S2", workspaceRoot: "/tmp" },
          ],
          nextCursor: null,
        };
      }
      reads += 1;
      return {
        session: { sessionId: "Sx", workspaceRoot: "/tmp" },
        history: { mode: "inline", items: [{ itemId: "i", kind: "userMessage", text: "Cached title" }] },
      };
    };
    const first = await bridge.listSessions();
    expect(reads).toBe(2);
    expect(first.sessions[0]?.title).toBe("Cached title");
    await bridge.listSessions();
    expect(reads).toBe(2);
    await bridge.close();
  });
});
