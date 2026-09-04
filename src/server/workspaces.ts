import { execFile } from "node:child_process";
import { realpath, stat, open } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceChanges, WorkspaceValidation } from "../shared/contracts.js";
import { AppError } from "./errors.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1_500_000;
const MAX_FILE = 1_000_000;

export class WorkspaceRegistry {
  private roots = new Set<string>();

  async open(path: string): Promise<WorkspaceValidation> {
    if (!isAbsolute(path)) throw new AppError("workspace_not_absolute", "Workspace paths must be absolute.", 400, false, "Choose a folder or enter its full absolute path.");
    let canonicalPath: string;
    try { canonicalPath = await realpath(path); }
    catch { throw new AppError("workspace_not_found", "That workspace does not exist.", 404, false, "Choose an existing directory."); }
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new AppError("workspace_not_directory", "The selected path is not a directory.", 400, false, "Choose a project folder, not a file.");
    this.roots.add(canonicalPath);
    return { path, canonicalPath, name: basename(canonicalPath), valid: true };
  }

  async authorizeExisting(path: string) {
    const opened = await this.open(path);
    return opened.canonicalPath;
  }

  require(root: string) {
    if (!this.roots.has(root)) throw new AppError("workspace_not_open", "This workspace has not been opened in mortiφ.", 403, false, "Open the project first, then retry.");
    return root;
  }

  async resolveInside(root: string, requested: string) {
    const canonicalRoot = this.require(root);
    if (!requested || requested.includes("\0")) throw new AppError("invalid_path", "The file path is invalid.", 400, false, "Choose a file inside the opened workspace.");
    const candidate = resolve(canonicalRoot, requested);
    const rel = relative(canonicalRoot, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AppError("path_escape", "The path leaves the opened workspace.", 403, false, "Choose a file inside the active project.");
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { throw new AppError("file_not_found", "That workspace file does not exist.", 404, false, "Refresh file search and choose an existing file."); }
    const canonicalRel = relative(canonicalRoot, canonical);
    if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) throw new AppError("symlink_escape", "That symlink leaves the opened workspace.", 403, false, "Choose a file contained by the active project.");
    return { canonical, relative: canonicalRel.split(sep).join("/") };
  }

  async changes(root: string): Promise<WorkspaceChanges> {
    const canonicalRoot = this.require(root);
    const [statusResult, branchResult] = await Promise.all([
      git(canonicalRoot, ["status", "--porcelain=v1", "-z"]),
      git(canonicalRoot, ["branch", "--show-current"]).catch(() => ""),
    ]);
    const records = statusResult.split("\0").filter(Boolean);
    const entries: WorkspaceChanges["files"] = [];
    for (let index = 0; index < records.length; index++) {
      const line = records[index]!;
      const status = line.slice(0, 2);
      entries.push({ status, path: line.slice(3) });
      if (status.includes("R") || status.includes("C")) index += 1;
    }
    return { workspaceRoot: canonicalRoot, branch: branchResult.trim() || null, files: entries, attribution: "working-tree" };
  }

  async diff(root: string, path: string) {
    const canonicalRoot = this.require(root);
    const relativePath = lexicalRelative(canonicalRoot, path);
    const [unstaged, staged] = await Promise.all([
      git(canonicalRoot, ["diff", "--no-ext-diff", "--", relativePath]),
      git(canonicalRoot, ["diff", "--cached", "--no-ext-diff", "--", relativePath]),
    ]);
    const trackedDiff = [staged, unstaged].filter(Boolean).join("\n");
    if (trackedDiff) return { path: relativePath, diff: trackedDiff, binary: false };
    const inside = await this.resolveInside(canonicalRoot, relativePath);
    const info = await stat(inside.canonical);
    if (info.size > MAX_FILE) return { path: inside.relative, diff: "", binary: false, truncated: true, message: "Untracked file exceeds the 1 MiB preview limit." };
    const handle = await open(inside.canonical, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.includes(0)) return { path: inside.relative, diff: "", binary: true, message: "Binary files are not previewed." };
      const text = buffer.toString("utf8");
      return { path: inside.relative, diff: text.split("\n").map((line) => `+${line}`).join("\n"), binary: false, untracked: true };
    } finally { await handle.close(); }
  }

  async search(root: string, query: string) {
    const canonicalRoot = this.require(root);
    const output = await git(canonicalRoot, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    const needle = query.trim().toLowerCase();
    return output.split("\n").filter(Boolean).filter((path) => !needle || path.toLowerCase().includes(needle)).slice(0, 80);
  }
}

function lexicalRelative(root: string, requested: string) {
  if (!requested || requested.includes("\0")) throw new AppError("invalid_path", "The file path is invalid.", 400, false, "Choose a file inside the opened workspace.");
  const candidate = resolve(root, requested);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AppError("path_escape", "The path leaves the opened workspace.", 403, false, "Choose a file inside the active project.");
  return rel.split(sep).join("/");
}

async function git(cwd: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 7000, maxBuffer: MAX_OUTPUT, encoding: "utf8" });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) throw new AppError("not_git_workspace", "This workspace is not a Git repository.", 409, false, "Workspace changes are available for Git projects only.");
    throw error;
  }
}
