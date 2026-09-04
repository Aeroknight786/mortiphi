import { mkdtemp, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMuse } from "../src/cli/muse-discovery";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("discoverMuse", () => {
  it("validates an explicit Muse executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mortiphi-discovery-")); temporary.push(directory);
    const executable = join(directory, "muse");
    await writeFile(executable, "#!/bin/sh\nprintf 'Muse Code 1.0.3 (test)\\n'\n");
    await chmod(executable, 0o755);
    await expect(discoverMuse({ explicit: executable, env: { PATH: "" }, platform: "darwin", home: directory })).resolves.toMatchObject({ path: await realpath(executable), version: "1.0.3", source: "argument" });
  });

  it("does not accept an unrelated executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mortiphi-discovery-")); temporary.push(directory);
    const executable = join(directory, "muse");
    await writeFile(executable, "#!/bin/sh\nprintf 'not muse\\n'\n");
    await chmod(executable, 0o755);
    await expect(discoverMuse({ explicit: executable, env: { PATH: "" }, platform: "darwin", home: directory })).resolves.toBeNull();
  });
});
