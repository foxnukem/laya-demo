import { describe, expect, it } from "vitest";
import { agentMayAct, DEFAULT_ROUTER, routeKey, setMode, type KeyIn, type Mode } from "../src/input";

const MODES: Mode[] = ["manual", "agent", "paused"];
const key = (code: string, extra: Partial<KeyIn> = {}): KeyIn => ({ type: "keydown", code, origin: "game", ...extra });

describe("input router", () => {
  it("delivers user keys in every mode: natively from the game, re-dispatched from the page", () => {
    for (const mode of MODES) {
      for (const type of ["keydown", "keyup"] as const) {
        expect(routeKey(mode, key("ArrowUp", { type })).delivery).toBe("native");
        expect(routeKey(mode, key("Digit5", { type, origin: "page" })).delivery).toBe("redispatch");
      }
    }
  });

  it("never forwards the reserved hotkey", () => {
    for (const mode of MODES)
      for (const type of ["keydown", "keyup"] as const)
        for (const origin of ["game", "page"] as const)
          for (const repeat of [false, true])
            expect(routeKey(mode, key(DEFAULT_ROUTER.hotkey, { type, origin, repeat })).delivery).toBe("block");
  });

  it("starts, stops and resumes the agent with the hotkey", () => {
    const hk = key(DEFAULT_ROUTER.hotkey);
    expect(routeKey("manual", hk).mode).toBe("agent");
    expect(routeKey("agent", hk).mode).toBe("manual");
    expect(routeKey("paused", hk)).toMatchObject({
      mode: "agent",
      effects: [{ kind: "mode", from: "paused", to: "agent", reason: "hotkey" }],
    });
    // Holding it down does not toggle again.
    expect(routeKey("agent", { ...hk, repeat: true }).mode).toBe("agent");
    expect(routeKey("agent", { ...hk, type: "keyup" }).mode).toBe("agent");
  });

  it("pauses the agent on any user key, and still delivers that key", () => {
    for (const code of ["ArrowLeft", "Digit5", "KeyQ", "Escape"]) {
      const r = routeKey("agent", key(code));
      expect(r.mode).toBe("paused");
      expect(r.delivery).toBe("native");
      expect(r.effects[0]).toEqual({ kind: "mode", from: "agent", to: "paused", reason: "takeover" });
    }
    // keyup and auto-repeat do not count as a new takeover.
    expect(routeKey("agent", key("ArrowLeft", { type: "keyup" })).mode).toBe("agent");
    expect(routeKey("agent", key("ArrowLeft", { repeat: true })).mode).toBe("agent");
  });

  it("logs the user's own drops, including the one that takes over", () => {
    const drop = { kind: "userDrop" };
    expect(routeKey("manual", key("Digit5")).effects).toEqual([drop]);
    expect(routeKey("paused", key("Digit5", { origin: "page" })).effects).toEqual([drop]);
    expect(routeKey("agent", key("Digit5")).effects).toContainEqual(drop);
    expect(routeKey("manual", key("Digit5", { type: "keyup" })).effects).toEqual([]);
    expect(routeKey("manual", key("Digit5", { repeat: true })).effects).toEqual([]);
    expect(routeKey("manual", key("Enter")).effects).toEqual([]);
  });

  it("leaves keys typed into the panel alone", () => {
    for (const mode of MODES) {
      expect(routeKey(mode, key("Digit5", { origin: "page", editable: true }))).toEqual({ mode, delivery: "ignore", effects: [] });
    }
  });

  it("respects a configured drop key and hotkey", () => {
    const cfg = { hotkey: "F4", dropKey: "Enter" };
    expect(routeKey("manual", key("Enter"), cfg).effects).toEqual([{ kind: "userDrop" }]);
    expect(routeKey("manual", key("F4"), cfg)).toMatchObject({ mode: "agent", delivery: "block" });
    expect(routeKey("manual", key("Backquote"), cfg).delivery).toBe("native");
  });

  it("lets the agent act only while it is in control", () => {
    expect(MODES.filter(agentMayAct)).toEqual(["agent"]);
    expect(setMode("paused", "agent").effects).toEqual([{ kind: "mode", from: "paused", to: "agent", reason: "button" }]);
    expect(setMode("agent", "agent").effects).toEqual([]);
  });
});
