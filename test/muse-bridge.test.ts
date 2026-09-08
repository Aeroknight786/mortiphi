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
  it("does not trust the workspace host by default", () => {
    const bridge = new MuseBridge({});
    expect((bridge as unknown as { options: { trustWorkspace: boolean } }).options.trustWorkspace).toBe(false);
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
    (bridge as unknown as { host: unknown }).host = { connection: {}, close: async () => {} };
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

describe("MuseBridge idempotent turn resend", () => {
  interface TurnSend {
    method: string;
    params: Record<string, unknown>;
    options?: { commandId?: string };
  }

  function idempotentFakeHost(hooks: {
    mint: () => string;
    onTurnCommand?: (
      send: TurnSend,
      notify: (method: string, params: Record<string, unknown>) => void,
    ) => Promise<Record<string, unknown>>;
    onSessionRead?: () => Record<string, unknown>;
  }) {
    let emit: (notification: { method: string; params: Record<string, unknown>; emittedAtMs?: number }) => void = () => {};
    const turnSends: TurnSend[] = [];
    const readCalls: unknown[] = [];
    const connection = {
      onNotification(handler: typeof emit) { emit = handler; },
      closed: new Promise<void>(() => {}),
      mintCommandId: hooks.mint,
      request: async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        if (method === "session/read") {
          readCalls.push(params);
          if (hooks.onSessionRead) return hooks.onSessionRead();
          return {
            session: { sessionId: "S", workspaceRoot: "/tmp", createdAt: "", updatedAt: "", turnCount: 0 },
            history: { mode: "inline", items: [{ itemId: "i1", kind: "userMessage", text: "Hello there" }] },
          };
        }
        if (method === "approval/listPending") return { approvals: [], userInputs: [] };
        return {};
      },
      command: async (method: string, params: Record<string, unknown>, options?: { commandId?: string }): Promise<Record<string, unknown>> => {
        if (method === "session/resume") return { session: { sessionId: "S" } };
        if (method === "turn/start" || method === "turn/steer") {
          const send: TurnSend = { method, params, options };
          turnSends.push(send);
          if (hooks.onTurnCommand) {
            return hooks.onTurnCommand(send, (notifiedMethod, notifiedParams) =>
              emit({ method: notifiedMethod, params: notifiedParams, emittedAtMs: Date.now() }),
            );
          }
          return { turnId: `t-${turnSends.length}`, disposition: "accepted", commandId: options?.commandId };
        }
        return {};
      },
    };
    return {
      host: {
        connection,
        exited: new Promise<never>(() => {}),
        initializeResult: { schema: { version: 1, fingerprint: "x" } },
        close: async () => {},
      },
      turnSends,
      readCalls,
    };
  }

  function sharedMint() {
    let minted = 0;
    return () => `cmd-${(minted += 1)}`;
  }

  function inFlightSize(bridge: MuseBridge) {
    return (bridge as unknown as { inFlightCommands: Map<string, Set<string>> }).inFlightCommands.size;
  }

  it("never resends a turn/start the host admitted before the drop", async () => {
    const fake = idempotentFakeHost({
      mint: sharedMint(),
      onTurnCommand: async (send, notify) => {
        // Muse admitted the turn, then the ack was lost on a dead transport.
        notify("turn/started", { sessionId: "S", turnId: "t-admitted", commandId: send.options?.commandId });
        throw new Error("transport closed unexpectedly");
      },
    });
    const bridge = new MuseBridge({
      titleStorePath: tmpTitles(),
      spawnHost: (() => ({ initialize: async () => fake.host })) as any,
    });
    await bridge.initialize();

    const error = await bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue").catch((cause) => cause);
    expect(error).toMatchObject({ code: "turn_unknown_outcome", retryable: false });
    expect(String(error.message)).toContain("t-admitted");
    // The admitted turn is surfaced, not re-issued: exactly one send, and the
    // reconcile hit the in-memory projection without another session/read.
    expect(fake.turnSends).toHaveLength(1);
    expect(fake.turnSends[0]?.options?.commandId).toBe("cmd-1");
    expect(fake.readCalls).toHaveLength(1);
    expect(inFlightSize(bridge)).toBe(0);
    await bridge.close();
  });

  it("reconciles an admitted turn from session state instead of resending", async () => {
    const mint = sharedMint();
    let admittedCommandId: string | undefined;
    const first = idempotentFakeHost({
      mint,
      onTurnCommand: async (send) => {
        admittedCommandId = send.options?.commandId;
        throw new Error("transport closed unexpectedly");
      },
    });
    const second = idempotentFakeHost({
      mint,
      onSessionRead: () => ({
        session: { sessionId: "S", workspaceRoot: "/tmp", createdAt: "", updatedAt: "", turnCount: 1, activeTurnId: admittedCommandId },
        history: {
          mode: "inline",
          items: [{ itemId: "i9", kind: "userMessage", text: "Hello there", turnId: "t-from-read", commandId: admittedCommandId }],
        },
      }),
    });
    let spawns = 0;
    const bridge = new MuseBridge({
      titleStorePath: tmpTitles(),
      spawnHost: (() => {
        spawns += 1;
        return { initialize: async () => (spawns === 1 ? first.host : second.host) };
      }) as any,
    });
    await bridge.initialize();

    // No turn/started notification arrived, so the projection is clean: the
    // bridge must consult session state before deciding not to resend.
    const error = await bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue").catch((cause) => cause);
    expect(error).toMatchObject({ code: "turn_unknown_outcome", retryable: false });
    expect(String(error.message)).toContain(admittedCommandId);
    expect(first.turnSends).toHaveLength(1);
    expect(second.turnSends).toHaveLength(0);
    expect(spawns).toBe(2);
    expect(inFlightSize(bridge)).toBe(0);
    await bridge.close();
  });

  it("blocks fresh sends when a dropped submission cannot be confirmed", async () => {
    const mint = sharedMint();
    let sends = 0;
    const fakes: Array<ReturnType<typeof idempotentFakeHost>> = [];
    const bridge = new MuseBridge({
      titleStorePath: tmpTitles(),
      spawnHost: (() => {
        const fake = idempotentFakeHost({
          mint,
          onTurnCommand: async (send) => {
            sends += 1;
            if (sends === 1) throw new Error("transport closed unexpectedly");
            return { turnId: "t-2", disposition: "accepted", commandId: send.options?.commandId };
          },
        });
        fakes.push(fake);
        return { initialize: async () => fake.host };
      }) as any,
    });
    await bridge.initialize();

    const error = await bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue").catch((cause) => cause);
    expect(error).toMatchObject({ code: "turn_unknown_outcome", retryable: false });

    await expect(bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue")).rejects.toMatchObject({ code: "turn_unknown_outcome" });
    const keys = fakes.flatMap((fake) => fake.turnSends.map((send) => send.options?.commandId));
    expect(keys).toEqual(["cmd-1"]);
    expect(inFlightSize(bridge)).toBe(0);
    await bridge.close();
  });

  it("mints a distinct commandId per concurrent send", async () => {
    const fake = idempotentFakeHost({
      mint: sharedMint(),
      onTurnCommand: async (send) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const commandId = send.options?.commandId ?? "missing";
        return { turnId: `t-${commandId}`, disposition: "accepted", commandId };
      },
    });
    const bridge = new MuseBridge({
      titleStorePath: tmpTitles(),
      spawnHost: (() => ({ initialize: async () => fake.host })) as any,
    });
    await bridge.initialize();
    await bridge.attach("S");

    const [first, second] = await Promise.all([
      bridge.startTurn("S", [{ type: "text", text: "a" }], "none", "queue"),
      bridge.startTurn("S", [{ type: "text", text: "b" }], "none", "queue"),
    ]);
    const keys = fake.turnSends.map((send) => send.options?.commandId);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(first.turnId).not.toBe(second.turnId);
    expect(inFlightSize(bridge)).toBe(0);
    await bridge.close();
  });
});

describe("MuseBridge reconcile review fixes", () => {
  function reconcileFake(hooks: {
    onCommand?: (method: string) => Promise<Record<string, unknown>>;
    onRead?: () => Record<string, unknown>;
  }) {
    const calls: string[] = [];
    const readSession = hooks.onRead ?? (() => ({ session: { sessionId: "S", workspaceRoot: "/tmp", createdAt: "", updatedAt: "", turnCount: 0 } }));
    return {
      host: {
        connection: {
          onNotification() {},
          closed: new Promise<void>(() => {}),
          mintCommandId: () => `cmd-${calls.length + 1}`,
          request: async (method: string) => {
            calls.push(`request:${method}`);
            if (method === "session/read") return readSession();
            return { approvals: [], userInputs: [] };
          },
          command: async (method: string) => {
            calls.push(`command:${method}`);
            if (method === "session/resume") return { session: { sessionId: "S" } };
            if (hooks.onCommand) return hooks.onCommand(method);
            return {};
          },
        },
        exited: new Promise<never>(() => {}),
        initializeResult: { schema: { version: 1, fingerprint: "x" } },
        close: async () => {},
      },
      calls,
    };
  }

  function reconcileBridge(fake: ReturnType<typeof reconcileFake>) {
    return new MuseBridge({
      titleStorePath: tmpTitles(),
      spawnHost: (() => ({ initialize: async () => fake.host })) as any,
    });
  }

  function rejectedError() {
    const error = new AppError("muse_operation_failed", "Muse rejected this command.", 409, false, "resync");
    error.museKind = "commandRejected";
    error.category = "readable";
    return error;
  }

  it("does not claim that a steer target proves acceptance", async () => {
    const fake = reconcileFake({
      onCommand: async (method) => {
        if (method === "turn/steer") throw new Error("transport closed unexpectedly");
        return {};
      },
    });
    const bridge = reconcileBridge(fake);
    await bridge.initialize();
    const error = await bridge.steer("S", "t-run", [{ type: "text", text: "nudge" }], "none").catch((cause) => cause);
    expect(error).toMatchObject({ code: "turn_unknown_outcome", retryable: false });
    expect(String(error.message)).toContain("could be confirmed");
    expect(String(error.message)).not.toContain("absorbed");
    await bridge.close();
  });

  it("rethrows definitive rejections without a reconcile read", async () => {
    const fatal = rejectedError();
    const fake = reconcileFake({
      onCommand: async (method) => {
        if (method === "turn/start") throw fatal;
        return { turnId: "t-x", disposition: "accepted" };
      },
    });
    const bridge = reconcileBridge(fake);
    await bridge.initialize();
    const error = await bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue").catch((cause) => cause);
    expect(error).toBe(fatal);
    expect(fake.calls.filter((call) => call === "request:session/read")).toHaveLength(1);
    await bridge.close();
  });

  it("rethrows muse_unavailable without reconciling a send that never transmitted", async () => {
    const down = new AppError("muse_unavailable", "Muse is reconnecting.", 503, true, "retry");
    const fake = reconcileFake({
      onCommand: async (method) => {
        if (method === "turn/start") throw down;
        return { turnId: "t-x", disposition: "accepted" };
      },
    });
    const bridge = reconcileBridge(fake);
    await bridge.initialize();
    const error = await bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue").catch((cause) => cause);
    expect(error).toBe(down);
    await bridge.close();
  });

  it("does not claim a pre-existing active turn as the failed send", async () => {
    const session = { sessionId: "S", workspaceRoot: "/tmp", createdAt: "", updatedAt: "", turnCount: 1, activeTurnId: "t-old" };
    const fake = reconcileFake({
      onCommand: async (method) => {
        if (method === "turn/start") throw new Error("transport closed unexpectedly");
        return {};
      },
      onRead: () => ({ session, history: { mode: "inline", items: [] } }),
    });
    const bridge = reconcileBridge(fake);
    await bridge.initialize();
    const error = await bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue").catch((cause) => cause);
    expect(error).toMatchObject({ code: "turn_unknown_outcome", retryable: false });
    await bridge.close();
  });

  it("keeps the original operation in the failure record when the reconcile read fails", async () => {
    const fake = reconcileFake({
      onCommand: async (method) => {
        if (method === "turn/start") throw new Error("transport closed unexpectedly");
        return {};
      },
    });
    // Fail session/read only after attach's read has succeeded.
    let reads = 0;
    const inner = fake.host.connection.request;
    fake.host.connection.request = async (method: string) => {
      if (method === "session/read") {
        reads += 1;
        if (reads > 1) throw new Error("transport closed unexpectedly");
      }
      return (inner as (method: string) => Promise<Record<string, unknown>>)(method);
    };
    const bridge = reconcileBridge(fake);
    await bridge.initialize();
    const error = await bridge.startTurn("S", [{ type: "text", text: "hi" }], "none", "queue").catch((cause) => cause);
    expect(error).toMatchObject({ code: "turn_unknown_outcome" });
    expect(bridge.health().failures[0]).toMatchObject({ sessionId: "S", method: "turn/start" });
    await bridge.close();
  });

  it("retains in-flight pins across host death for reconcile", async () => {
    // The owning send is still settling through catch/finally when the host
    // dies; clearing here would blind reconcile's steer lookup. Pins are
    // self-cleaning (untrack in finally) and cleared at shutdown.
    const fake = reconcileFake({});
    const bridge = reconcileBridge(fake);
    await bridge.initialize();
    (bridge as unknown as { inFlightCommands: Map<string, Set<string>> }).inFlightCommands.set("S", new Set(["cmd-1"]));
    (bridge as unknown as { onHostClosed(reason: string): void }).onHostClosed("test");
    expect(bridge.health().inFlightCommands).toEqual([{ sessionId: "S", commandIds: ["cmd-1"] }]);
    await bridge.close();
    expect(bridge.health().inFlightCommands).toEqual([]);
  });
});
