import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

await rm(resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist"), { recursive: true, force: true });
