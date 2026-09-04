import { describe, expect, it } from "vitest";
import { diffStats, extractEditedPaths, parseUnifiedDiff } from "../src/client/diff";

describe("unified diff presentation", () => {
  it("tracks line numbers and ignores file headers in totals", () => {
    const value = "--- a/file.ts\n+++ b/file.ts\n@@ -2,2 +2,2 @@\n same\n-old\n+new";
    expect(diffStats(value)).toEqual({ additions: 1, deletions: 1 });
    expect(parseUnifiedDiff(value).slice(-3)).toEqual([
      { kind: "context", oldNumber: 2, newNumber: 2, text: " same" },
      { kind: "deletion", oldNumber: 3, newNumber: null, text: "-old" },
      { kind: "addition", oldNumber: null, newNumber: 3, text: "+new" },
    ]);
  });

  it("attributes only known editing tools to a turn", () => {
    expect(extractEditedPaths([
      { kind: "toolCall", tool: "read_file", args: JSON.stringify({ path: "ignored.ts" }) },
      { kind: "toolCall", tool: "write_file", args: JSON.stringify({ path: "created.md" }) },
      { kind: "toolCall", tool: "apply_patch", args: JSON.stringify({ patch: "*** Update File: src/app.ts\n" }) },
    ])).toEqual(["created.md", "src/app.ts"]);
  });

  it("numbers an untracked file from line one", () => {
    expect(parseUnifiedDiff("+first\n+second").map((line) => line.newNumber)).toEqual([1, 2]);
  });
});
