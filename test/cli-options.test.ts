import { describe, expect, it } from "vitest";
import { parseCliOptions } from "../src/cli/options";

describe("parseCliOptions", () => {
  it("uses an available port and opens the browser by default", () => {
    expect(parseCliOptions([])).toMatchObject({ port: 0, open: true });
  });

  it("accepts supported overrides", () => {
    expect(parseCliOptions(["--port=4312", "--muse-bin", "/opt/muse", "--no-open"])).toMatchObject({ port: 4312, museBin: "/opt/muse", open: false });
  });

  it("rejects unknown options and invalid ports", () => {
    expect(() => parseCliOptions(["--wat"])).toThrow("Unknown option");
    expect(() => parseCliOptions(["--port", "70000"])).toThrow("0 to 65535");
  });
});
