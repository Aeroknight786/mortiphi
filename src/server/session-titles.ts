import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SessionTitleStore {
  private titles = new Map<string, string>();
  private loaded = false;
  private pendingSave?: Promise<void>;

  constructor(private readonly path: string) {}

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [sessionId, title] of Object.entries(parsed)) {
        if (typeof title === "string" && title.trim()) this.titles.set(sessionId, title);
      }
    } catch {
      // Derived titles are a performance cache. A missing or damaged store
      // must never block Muse — the list path re-derives them on demand.
    }
  }

  get(sessionId: string) { return this.titles.get(sessionId); }

  set(sessionId: string, title: string) {
    if (!title.trim() || this.titles.get(sessionId) === title) return;
    this.titles.set(sessionId, title);
    void this.save().catch(() => undefined);
  }

  private async save() {
    if (this.pendingSave) return this.pendingSave;
    this.pendingSave = (async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(Object.fromEntries(this.titles), null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.path);
      } finally {
        this.pendingSave = undefined;
      }
    })();
    return this.pendingSave;
  }
}
