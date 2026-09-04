import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionVisibilityStore } from "../src/server/session-visibility.js";

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ""; });

describe("SessionVisibilityStore", () => {
  it("persists locally removed task ids", async () => {
    directory = await mkdtemp(join(tmpdir(), "mortiphi-hidden-"));
    const path = join(directory, "hidden-sessions.json");
    const first = new SessionVisibilityStore(path);
    await first.hide("task-1");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(["task-1"]);
    const second = new SessionVisibilityStore(path);
    await second.load();
    expect(second.has("task-1")).toBe(true);
  });
});
