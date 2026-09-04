#!/usr/bin/env node
import { spawn } from "node:child_process";
import { startLocalServer } from "../server/runtime.js";
import { MORTIPHI_VERSION } from "../shared/version.js";
import { discoverMuse } from "./muse-discovery.js";
import { parseCliOptions } from "./options.js";

const HELP = `mortiφ — a browser GUI for Muse Code

Usage:
  mortiphi [options]

Options:
  --port <number>     Use a specific loopback port (default: available port)
  --muse-bin <path>   Use a specific Muse executable
  --no-open           Start without opening the browser
  -V, --version       Print the mortiφ version
  -h, --help          Show this help

Environment:
  MUSE_BIN            Muse executable override
  PORT                Port override when --port is not supplied
`;

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  if (options.version) { process.stdout.write(`${MORTIPHI_VERSION}\n`); return; }
  if (options.port === 0 && process.env.PORT) options.port = parseCliOptions(["--port", process.env.PORT]).port;

  process.stdout.write(`mortiφ ${MORTIPHI_VERSION}\nDetecting Muse Code…\n`);
  const muse = await discoverMuse({ explicit: options.museBin });
  if (!muse) {
    throw new Error("Muse Code was not found. Confirm `muse --version` works, or run mortiphi --muse-bin /absolute/path/to/muse.");
  }
  process.stdout.write(`Muse Code ${muse.version}\n${muse.path}\n`);
  const runtime = await startLocalServer({ port: options.port, museBin: muse.path, cwd: process.cwd() });
  process.stdout.write(`\nReady: ${runtime.url}\n${options.open ? "Opening your browser…" : "Open this URL in your browser."}\nPress Ctrl+C to stop.\n`);
  if (options.open) await openBrowser(runtime.url).catch(() => process.stdout.write(`Could not open the browser automatically. Open ${runtime.url}\n`));

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    process.stdout.write("\nStopping mortiφ…\n");
    await runtime.close();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
}

async function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nmortiφ could not start\n${message}\n`);
  if (/auth|credential|login/i.test(message)) process.stderr.write("Run `muse login`, then start mortiφ again.\n");
  process.exitCode = 1;
});
