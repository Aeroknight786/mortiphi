import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SessionLabelStore {
  private labels = new Map<string, string>();
  private loaded = false;

  constructor(private readonly path: string) {}

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [sessionId, label] of Object.entries(parsed)) {
        if (typeof label === "string" && label.trim() && label.length <= 100) this.labels.set(sessionId, label);
      }
    } catch {
      // Task labels are cosmetic. A missing or damaged store must never block Muse.
    }
  }

  get(sessionId: string) { return this.labels.get(sessionId); }

  async set(sessionId: string, label: string) {
    await this.load();
    this.labels.set(sessionId, label);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(this.labels), null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
