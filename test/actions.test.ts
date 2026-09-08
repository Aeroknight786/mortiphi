import { describe, expect, it } from "vitest";
import { ACTIONS, ACTION_BY_COMMAND } from "../src/shared/actions.js";

describe("shared action registry", () => {
  it("pairs every slash command with one visible GUI surface", () => {
    expect(ACTIONS.length).toBeGreaterThanOrEqual(19);
    expect(new Set(ACTIONS.map((action) => action.command)).size).toBe(ACTIONS.length);
    for (const action of ACTIONS) {
      expect(action.command).toMatch(/^\/[a-z]+$/);
      expect(action.gui.length).toBeGreaterThan(2);
      expect(["Muse", "mortiφ"]).toContain(action.source);
      expect(ACTION_BY_COMMAND.get(action.command)?.id).toBe(action.id);
    }
  });

  it("contains the complete Gate 1 command vocabulary", () => {
    const expected = ["/new","/resume","/fork","/rename","/delete","/clear","/compact","/model","/effort","/permissions","/stop","/copy","/help","/queue","/steer","/replace","/unqueue","/tasks","/details","/changes","/activity","/settings"];
    expect([...ACTION_BY_COMMAND.keys()].sort()).toEqual([...expected, "/resync"].sort());
  });
});
