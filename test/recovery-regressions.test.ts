import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MspError } from "@muse-code/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseBridge } from "../src/server/muse-bridge.js";
import { classifyMuseError } from "../src/server/errors.js";

type Json = Record<string, any>;
const session = { sessionId: "S", workspaceRoot: "/tmp", activeTurnId: null };
const history = { mode: "inline", items: [] };
const bridges: MuseBridge[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fake(handler: (method: string, params: Json) => Promise<Json> = async () => ({})) {
  let receive: (event: any) => void = () => {};
  let end!: () => void;
  let serial = 0;
  const dispatch = vi.fn(async (method: string, params: Json) => {
    const custom = await handler(method, params);
    if (Object.keys(custom).length) return custom;
    if (method === "session/read" || method === "session/resume") return { session, history };
    if (method === "approval/listPending") return { approvals: [], userInputs: [] };
    return {};
  });
  const host = {
    connection: {
      onNotification: (fn: typeof receive) => { receive = fn; },
      closed: new Promise<void>(resolve => { end = resolve; }),
      mintCommandId: () => `cmd-${++serial}`,
      request: dispatch,
      command: (method: string, params: Json, options?: Json) => dispatch(method, { ...params, commandId: options?.commandId }),
    },
    initializeResult: { schema: { version: 1 } },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return { host, dispatch, end: () => end(), emit: (method: string, params: Json) => receive({ method, params: { sessionId: "S", ...params } }) };
}

async function bridgeFor(hosts: ReturnType<typeof fake>[], trustWorkspace?: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "mortiphi-recovery-"));
  dirs.push(dir);
  let i = 0;
  const spawn = vi.fn(() => ({ initialize: async () => hosts[Math.min(i++, hosts.length - 1)]!.host }));
  const bridge = new MuseBridge({
    spawnHost: spawn as any, trustWorkspace,
    titleStorePath: join(dir, "titles.json"),
    labelStorePath: join(dir, "labels.json"),
    visibilityStorePath: join(dir, "hidden.json"),
  });
  bridges.push(bridge);
  await bridge.initialize();
  return { bridge, spawn };
}

describe("PR recovery regressions", () => {
  it("hydrates completion at resume rather than the earlier read", async () => {
    const host = fake(async method => method === "session/read"
      ? { session: { ...session, activeTurnId: "T" }, history }
      : method === "session/resume"
      ? { session, history: { mode: "inline", items: [{ itemId: "answer", turnId: "T", kind: "agentMessage", text: "Done" }] } }
      : {});
    const { bridge } = await bridgeFor([host]);
    const p = await bridge.attach("S");
    expect(p.snapshot().state.activeTurnId).toBeNull();
    expect(p.snapshot().items).toMatchObject([{ text: "Done" }]);
  });

  it("resync keeps the original SSE listener and applies buffered events once", async () => {
    let resync = false;
    const delta = { viewCursor: "v2", itemId: "I", delta: "!" };
    const host = fake(async method => {
      if (!resync) return {};
      if (method === "session/resume") {
        host.emit("item/delta", delta);
        return { session, history: { mode: "none" } };
      }
      if (method === "view/page") return { events: [
        { method: "item/started", params: { viewCursor: "v1", item: { itemId: "I", kind: "agentMessage", text: "Hello" } } },
        { method: "item/delta", params: delta },
      ], nextCursor: null };
      return {};
    });
    const { bridge } = await bridgeFor([host]);
    const original = await bridge.attach("S");
    const listener = vi.fn();
    original.subscribe(listener);
    resync = true;
    expect(await bridge.resync("S")).toBe(original);
    expect(original.snapshot().items[0]?.text).toBe("Hello!");
    host.emit("turn/started", { turnId: "new" });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ method: "turn/started" }));
    expect(host.dispatch.mock.calls.some(([method]) => method === "view/unsubscribe")).toBe(true);
  });

  it("ignores a superseded host's delayed close and notifications", async () => {
    const first = fake(async method => { if (method === "session/list") throw new Error("transport closed"); return {}; });
    const second = fake(async method => method === "session/list" ? { sessions: [] } : {});
    const { bridge, spawn } = await bridgeFor([first, second]);
    await bridge.attach("S");
    await expect(bridge.listSessions()).rejects.toThrow();
    await bridge.listSessions();
    first.end();
    await Promise.resolve();
    first.emit("turn/started", { turnId: "wrong" });
    expect(bridge.isConnected()).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(bridge.getProjection("S")?.snapshot().state.activeTurnId).not.toBe("wrong");
    expect(first.host.close).toHaveBeenCalled();
  });

  it("retries a transient per-session reattach while the replacement host remains connected", async () => {
    let failed = false;
    const first = fake();
    const second = fake(async method => {
      if (method === "session/resume" && !failed) {
        failed = true;
        throw new MspError({ code: -32001, message: "busy", data: { kind: "overloaded", retryable: true } });
      }
      return {};
    });
    const { bridge } = await bridgeFor([first, second]);
    await bridge.attach("S");
    vi.useFakeTimers();
    first.end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bridge.health().pendingReattach).toEqual(["S"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(bridge.health().pendingReattach).toEqual([]);
    expect(bridge.getProjection("S")?.snapshot().state.connection).toBe("connected");
  });

  it.each(["sessionNotLoaded", "overloaded", "backpressured"])("does not turn %s steer rejection into uncertain acceptance", async kind => {
    let attempts = 0;
    const host = fake(async method => {
      if (method === "turn/steer") {
        if (++attempts === 1) throw new MspError({ code: kind === "sessionNotLoaded" ? -32024 : -32001, message: "rejected", data: { kind, retryable: true } });
        return { turnId: "T", status: "accepted" };
      }
      return {};
    });
    const { bridge } = await bridgeFor([host]);
    const result = bridge.steer("S", "T", [{ type: "text", text: "change" }]);
    if (kind === "sessionNotLoaded") { await expect(result).resolves.toMatchObject({ turnId: "T" }); expect(attempts).toBe(2); }
    else { await expect(result).rejects.toMatchObject({ museKind: kind, retryable: true }); expect(attempts).toBe(1); }
  });

  it.each(["queued", "completed", "unrelated", "readFailed"])("blocks another send after an inconclusive %s result", async situation => {
    let sent = false;
    const host = fake(async method => {
      if (method === "turn/start") { sent = true; throw new Error("ack timeout"); }
      if (method === "session/read" && sent) {
        if (situation === "readFailed") throw new Error("timeout");
        return { session: { ...session, activeTurnId: situation === "unrelated" ? "other" : null }, history };
      }
      return {};
    });
    const { bridge } = await bridgeFor([host]);
    const send = () => bridge.startTurn("S", [{ type: "text", text: "build" }], "none", "queue");
    await expect(send()).rejects.toMatchObject({ code: "turn_unknown_outcome", retryable: false });
    await expect(send()).rejects.toMatchObject({ code: "turn_unknown_outcome" });
    expect(host.dispatch.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(1);
  });

  it("classifies the actual SDK sessionNotFound error as gone", () => {
    expect(classifyMuseError(new MspError({ code: -32020, message: "missing", data: { kind: "sessionNotFound", retryable: false } })))
      .toMatchObject({ category: "gone", retryable: false });
  });

  it("retries pending approvals recovery instead of opening a false empty state", async () => {
    let fail = false;
    const host = fake(async method => {
      if (method === "approval/listPending" && fail) throw new MspError({ code: -32001, message: "busy", data: { kind: "overloaded", retryable: true } });
      return {};
    });
    const { bridge } = await bridgeFor([host]);
    const projection = await bridge.attach("S");
    fail = true;
    await expect(bridge.resync("S")).rejects.toThrow();
    expect(projection.snapshot().state.connection).toBe("disconnected");
    expect(bridge.health().pendingReattach).toContain("S");
    fail = false;
    expect(await bridge.resync("S")).toBe(projection);
    expect(projection.snapshot().state.connection).toBe("connected");
  });

  it("rejects a resume response from a host replaced before its acknowledgement arrives", async () => {
    let bridge: MuseBridge;
    const first = fake(async method => {
      if (method === "session/resume") {
        first.end();
        await Promise.resolve();
        await bridge.initialize();
        return { session, history };
      }
      return {};
    });
    ({ bridge } = await bridgeFor([first, fake()]));
    await expect(bridge.attach("S")).rejects.toMatchObject({ code: "muse_unavailable" });
    expect(bridge.health().subscriptions).toBe(0);
    expect(bridge.health().pendingReattach).toContain("S");
  });

  it("requests a new snapshot when a browser reconnects with an earlier server's revision", async () => {
    const { bridge } = await bridgeFor([fake()]);
    const projection = await bridge.attach("S");
    expect(projection.eventsAfter(1_000)).toBeNull();
  });

  it.each([false, true])("launches with workspace trust only when explicitly selected: %s", async trust => {
    const { spawn } = await bridgeFor([fake()], trust);
    expect(spawn.mock.calls[0]).toMatchObject([{ args: trust ? ["serve", "--trust-workspace"] : ["serve"] }]);
  });
});
