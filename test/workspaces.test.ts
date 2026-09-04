import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "../src/server/workspaces.js";

const exec = promisify(execFile);
const roots: string[] = [];

describe("WorkspaceRegistry", () => {
  afterEach(async () => { for (const root of roots.splice(0)) await exec("rm", ["-rf", root]); });
  it("canonicalizes directories and rejects traversal and symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "mortiphi-root-")); roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "mortiphi-out-")); roots.push(outside);
    await mkdir(join(root, "src")); await writeFile(join(root, "src", "ok.ts"), "ok"); await writeFile(join(outside, "secret"), "no"); await symlink(join(outside, "secret"), join(root, "src", "escape"));
    const registry = new WorkspaceRegistry();
    const opened = await registry.open(root);
    expect(opened.canonicalPath).toContain("mortiphi-root-");
    await expect(registry.resolveInside(opened.canonicalPath, "../secret")).rejects.toMatchObject({ code: "path_escape" });
    await expect(registry.resolveInside(opened.canonicalPath, "src/escape")).rejects.toMatchObject({ code: "symlink_escape" });
    await expect(registry.resolveInside(opened.canonicalPath, "src/ok.ts")).resolves.toMatchObject({ relative: "src/ok.ts" });
  });

  it("bounds untracked diff reads before loading bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mortiphi-git-")); roots.push(root);
    await exec("git", ["init", "-q", root]);
    await writeFile(join(root, "large.txt"), Buffer.alloc(1_000_001, 65));
    const registry = new WorkspaceRegistry(); const opened = await registry.open(root);
    await expect(registry.diff(opened.canonicalPath, "large.txt")).resolves.toMatchObject({ truncated: true });
  });

  it("lists every Git change class and previews staged and deleted files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mortiphi-changes-")); roots.push(root);
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "modified.txt"), "before\n");
    await writeFile(join(root, "deleted.txt"), "delete me\n");
    await writeFile(join(root, "renamed.txt"), "rename me\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "initial"]);
    await writeFile(join(root, "modified.txt"), "after\n");
    await exec("git", ["-C", root, "rm", "-q", "deleted.txt"]);
    await exec("git", ["-C", root, "mv", "renamed.txt", "moved.txt"]);
    await writeFile(join(root, "new.txt"), "new\n");

    const registry = new WorkspaceRegistry(); const opened = await registry.open(root);
    const changes = await registry.changes(opened.canonicalPath);
    expect(changes.files.map((file) => file.path).sort()).toEqual(["deleted.txt", "modified.txt", "moved.txt", "new.txt"]);
    await expect(registry.diff(opened.canonicalPath, "deleted.txt")).resolves.toMatchObject({ binary: false });
    await expect(registry.diff(opened.canonicalPath, "modified.txt")).resolves.toMatchObject({ binary: false });
    await expect(registry.diff(opened.canonicalPath, "moved.txt")).resolves.toMatchObject({ binary: false });
  });
});
