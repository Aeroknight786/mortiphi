// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/shared/contracts";
import { connectionLabel, readTabDraft, scrollAnchorKey, statusLabel, tabDraftId, taskSubtitle } from "../src/client/ui-state";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "S",
    workspaceRoot: "/tmp",
    title: "T",
    status: "idle",
    createdAt: "",
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    turnCount: 0,
    available: true,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("tabDraftId", () => {
  it("is stable within a tab", () => {
    expect(tabDraftId()).toBe(tabDraftId());
  });
});

describe("readTabDraft", () => {
  it("prefers the tab key and migrates the legacy key exactly once", () => {
    localStorage.setItem("mortiphi:draft:S", "legacy text");
    expect(readTabDraft("mortiphi:draft:S:tab-a", "mortiphi:draft:S")).toBe("legacy text");
    expect(localStorage.getItem("mortiphi:draft:S")).toBeNull();
    expect(localStorage.getItem("mortiphi:draft:S:tab-a")).toBe("legacy text");
    // First tab wins; the second tab sees nothing (no duplication).
    expect(readTabDraft("mortiphi:draft:S:tab-b", "mortiphi:draft:S")).toBe("");
  });

  it("returns empty when nothing is stored", () => {
    expect(readTabDraft("mortiphi:draft:S:tab-a", "mortiphi:draft:S")).toBe("");
  });
});

describe("connectionLabel", () => {
  it("falls back to the bootstrap value before the first poll", () => {
    expect(connectionLabel(null, true)).toBe("Connected");
    expect(connectionLabel(null, false)).toBe("Unavailable");
  });

  it("reports live health", () => {
    const base = { reconnectAttempt: 0, reconnectScheduled: false, subscriptions: 0, inFlightCommands: [], pendingReattach: [] };
    expect(connectionLabel({ ...base, connected: true }, false)).toBe("Connected");
    expect(connectionLabel({ ...base, connected: false }, true)).toBe("Unavailable");
    expect(connectionLabel({ ...base, connected: false, reconnectScheduled: true }, true)).toBe("Reconnecting");
    expect(connectionLabel({ ...base, connected: false, reconnectAttempt: 2 }, true)).toBe("Reconnecting");
  });
});

describe("taskSubtitle", () => {
  it("marks unopenable and read-only sessions", () => {
    expect(taskSubtitle(summary({ unopenableReason: "gone" }))).toBe("Needs attention · unopenable");
    expect(taskSubtitle(summary({ readOnly: true }))).toContain("Read-only");
    expect(taskSubtitle(summary({ available: false }))).toBe("Workspace unavailable");
    expect(taskSubtitle(summary())).toContain("ago");
  });
});

describe("scrollAnchorKey", () => {
  it("namespaces anchors per session", () => {
    expect(scrollAnchorKey("S")).toBe("mortiphi:scroll:S");
  });
});

describe("statusLabel", () => {
  it("passes unknown states through", () => {
    expect(statusLabel("running")).toBe("Running");
    expect(statusLabel("weird")).toBe("weird");
  });
});
