import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SessionVisibilityStore {
  private hidden = new Set<string>();
  private loaded = false;

  constructor(private readonly path: string) {}

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (Array.isArray(parsed)) for (const sessionId of parsed) if (typeof sessionId === "string") this.hidden.add(sessionId);
    } catch {
      // Visibility is cosmetic. A missing or damaged store must never block Muse.
    }
  }

  has(sessionId: string) { return this.hidden.has(sessionId); }

  async hide(sessionId: string) {
    await this.load();
    this.hidden.add(sessionId);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...this.hidden], null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
