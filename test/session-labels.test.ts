import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLabelStore } from "../src/server/session-labels.js";

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ""; });

describe("SessionLabelStore", () => {
  it("persists local task labels across server launches", async () => {
    directory = await mkdtemp(join(tmpdir(), "mortiphi-labels-"));
    const path = join(directory, "session-labels.json");
    const first = new SessionLabelStore(path);
    await first.set("task-1", "Explore another approach");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ "task-1": "Explore another approach" });
    const second = new SessionLabelStore(path);
    await second.load();
    expect(second.get("task-1")).toBe("Explore another approach");
  });
});
