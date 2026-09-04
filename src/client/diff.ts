export type DiffLineKind = "addition" | "deletion" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

export function parseUnifiedDiff(value: string): DiffLine[] {
  let oldNumber = 1;
  let newNumber = 1;
  return value.split("\n").map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      return { kind: "hunk", oldNumber: null, newNumber: null, text };
    }
    if (text.startsWith("diff --git ") || text.startsWith("index ") || text.startsWith("--- ") || text.startsWith("+++ ") || text.startsWith("Binary files ") || text.startsWith("new file mode ") || text.startsWith("deleted file mode ") || text.startsWith("similarity index ") || text.startsWith("rename from ") || text.startsWith("rename to ")) {
      return { kind: "meta", oldNumber: null, newNumber: null, text };
    }
    if (text.startsWith("+") && !text.startsWith("+++")) return { kind: "addition", oldNumber: null, newNumber: newNumber++, text };
    if (text.startsWith("-") && !text.startsWith("---")) return { kind: "deletion", oldNumber: oldNumber++, newNumber: null, text };
    if (text.startsWith(" ")) return { kind: "context", oldNumber: oldNumber++, newNumber: newNumber++, text };
    return { kind: "meta", oldNumber: null, newNumber: null, text };
  });
}

export function diffStats(value: string) {
  const lines = parseUnifiedDiff(value);
  return {
    additions: lines.filter((line) => line.kind === "addition").length,
    deletions: lines.filter((line) => line.kind === "deletion").length,
  };
}

export function extractEditedPaths(items: Array<Record<string, unknown>>) {
  const mutating = new Set(["write_file", "edit_file", "apply_patch", "create_file", "delete_file", "move_file", "rename_file"]);
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== "toolCall" || !mutating.has(String(item.tool))) continue;
    try {
      const args = JSON.parse(String(item.args ?? "{}"));
      for (const key of ["path", "filePath", "file_path", "destination", "destinationPath"]) {
        if (typeof args[key] === "string") paths.add(args[key].replace(/^\.\//, ""));
      }
      for (const value of Object.values(args)) {
        if (typeof value !== "string") continue;
        for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.add(match[1]!.trim().replace(/^\.\//, ""));
      }
    } catch { /* Model-authored arguments may not be valid JSON. */ }
  }
  return [...paths];
}
