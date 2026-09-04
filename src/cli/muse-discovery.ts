import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MuseInstallation {
  path: string;
  version: string;
  source: "argument" | "environment" | "path" | "common-location";
}

export async function discoverMuse(options: { explicit?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {}): Promise<MuseInstallation | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const candidates = new Map<string, MuseInstallation["source"]>();
  add(candidates, options.explicit, "argument");
  add(candidates, env.MUSE_BIN, "environment");
  for (const candidate of pathCandidates(env.PATH, platform)) add(candidates, candidate, "path");
  for (const candidate of commonCandidates(home, env, platform)) add(candidates, candidate, "common-location");

  for (const [candidate, source] of candidates) {
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      const canonical = await realpath(candidate);
      const result = await execFileAsync(canonical, ["--version"], { timeout: 4_000, maxBuffer: 64 * 1024, windowsHide: true });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      const match = output.match(/Muse Code\s+([^\s]+)/i);
      if (match) return { path: canonical, version: match[1]!, source };
    } catch { /* Try the next known installation location. */ }
  }
  return null;
}

function add(candidates: Map<string, MuseInstallation["source"]>, path: string | undefined, source: MuseInstallation["source"]) {
  if (path) candidates.set(path, source);
}

function pathCandidates(pathValue: string | undefined, platform: NodeJS.Platform) {
  if (!pathValue) return [];
  const names = platform === "win32" ? ["muse.exe", "muse.cmd", "muse.bat", "muse"] : ["muse"];
  return pathValue.split(delimiter).filter(Boolean).flatMap((directory) => names.map((name) => join(directory, name)));
}

function commonCandidates(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return [join(home, ".local", "bin", "muse.exe"), local && join(local, "Programs", "Muse", "muse.exe"), local && join(local, "muse", "bin", "muse.exe")].filter((value): value is string => Boolean(value));
  }
  return [join(home, ".local", "bin", "muse"), join(home, "bin", "muse"), join(home, ".cargo", "bin", "muse"), "/opt/homebrew/bin/muse", "/usr/local/bin/muse", "/usr/bin/muse"];
}
