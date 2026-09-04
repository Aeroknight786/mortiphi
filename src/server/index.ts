import { startLocalServer } from "./runtime.js";

const port = Number(process.env.PORT ?? 3000);
const runtime = await startLocalServer({ port, cwd: process.cwd(), development: process.env.NODE_ENV === "development" });
console.log(`mortiφ ready at ${runtime.url}`);
const shutdown = async () => {
  await runtime.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
