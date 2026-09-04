import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseBridge } from "../src/server/muse-bridge.js";

const workspace = await mkdtemp(join(tmpdir(), "mortiphi-smoke-"));
const bridge = new MuseBridge({ cwd: workspace });
try {
  await bridge.initialize();
  const created = await bridge.startSession(workspace, undefined, "promptUnmatched");
  const sessionId = created.session.sessionId;
  const projection = bridge.getProjection(sessionId)!;
  await bridge.startTurn(sessionId, [{ type: "text", text: "Reply with exactly MORTIPHI_SMOKE_OK. Do not use tools." }], "minimal", "queue");
  await waitFor(() => projection.snapshot().items.some((item) => item.kind === "agentMessage" && String(item.text).includes("MORTIPHI_SMOKE_OK")), 60_000);
  const read = await bridge.readSession(sessionId);
  if (!read.items.some((item) => item.kind === "agentMessage" && String(item.text).includes("MORTIPHI_SMOKE_OK"))) throw new Error("Session read did not recover the live response.");
  console.log(`MORTIPHI_SMOKE_OK ${sessionId}`);
} finally {
  await bridge.close().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
}

async function waitFor(test: () => boolean, timeoutMs: number) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the Muse smoke response.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
