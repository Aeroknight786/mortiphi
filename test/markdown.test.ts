// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { markdown } from "../src/client/markdown";

describe("transcript Markdown", () => {
  it("renders links without crashing and hardens external navigation", () => {
    const result = markdown("See [Muse](https://muse.dev/docs) and [local](javascript:alert(1)).");
    const doc = new DOMParser().parseFromString(result.__html, "text/html");
    const links = [...doc.querySelectorAll("a")];

    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe("Muse");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(doc.body.textContent).toContain("local");
    expect(result.__html).not.toContain("javascript:");
  });

  it("strips raw HTML and still renders surrounding content", () => {
    const result = markdown("before <script>alert(1)</script> after");

    expect(result.__html).not.toContain("<script");
    expect(result.__html).toContain("before");
    expect(result.__html).toContain("after");
  });
});
