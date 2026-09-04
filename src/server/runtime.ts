import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import express from "express";
import { createHttpApp } from "./http-app.js";
import { MuseBridge } from "./muse-bridge.js";

export interface LocalServerOptions {
  port?: number;
  museBin?: string;
  cwd?: string;
  development?: boolean;
  clientDir?: string;
}

export interface LocalServer {
  host: "127.0.0.1";
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startLocalServer(options: LocalServerOptions = {}): Promise<LocalServer> {
  const host = "127.0.0.1" as const;
  let boundPort = options.port ?? 0;
  const bridge = new MuseBridge({ cwd: options.cwd, museBin: options.museBin });
  await bridge.initialize();
  const web = createHttpApp(bridge, undefined, () => boundPort);

  if (options.development) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    web.use(vite.middlewares);
  } else {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const client = options.clientDir ?? resolve(here, "../client");
    if (!existsSync(resolve(client, "index.html"))) {
      await bridge.close().catch(() => undefined);
      throw new Error("The mortiφ web build is missing from this installation.");
    }
    web.use(express.static(client, { etag: false, maxAge: 0 }));
    web.get("*splat", (_req, res) => res.sendFile(resolve(client, "index.html")));
  }

  let server: Server;
  try {
    server = await new Promise<Server>((resolveServer, reject) => {
      const candidate = web.listen(boundPort, host, () => resolveServer(candidate));
      candidate.once("error", reject);
    });
  } catch (error) {
    await bridge.close().catch(() => undefined);
    throw error;
  }
  boundPort = (server.address() as AddressInfo).port;
  let closed = false;
  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await bridge.close().catch(() => undefined);
    },
  };
}
