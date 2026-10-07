import { describe, expect, it } from "vitest";
import { heuristicAction, HeuristicPlayer, RandomPlayer } from "../src/players";
import type { Prediction } from "../src/predictor";
import { ACTIONS, buildQuestion, buildState, side } from "../src/prompt";

const pred = (offset: number, approaching: boolean, nextCenterMs: number | null = 300): Prediction => ({
  t: 1000, releaseT: 2200, landT: 2800,
  blockX: 120 + offset, blockVx: 80, towerX: 120, towerVx: -3,
  landX: 120 + offset, offset, approaching, nextCenterMs,
  periodMs: 2000, swingAmp: 60, swayAmp: 4,
});

describe("prompt", () => {
  it("asks a choice with exactly the two options drop and wait", () => {
    const q = buildQuestion(pred(-4, true), 5).action;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual([...ACTIONS]);
    expect(ACTIONS).toEqual(["drop", "wait"]);
  });

  it("describes where a drop now would land", () => {
    expect(buildQuestion(pred(-4.2, true), 5).action.criteria.drop).toBe("lands 4 px left of the tower center");
    expect(side(7.6)).toBe("8 px right of the tower center");
    expect(side(0.3)).toBe("on the tower center");
    expect(buildQuestion(pred(20, false, 412.4), 5).action.criteria.wait).toContain("412 ms");
    expect(buildQuestion(pred(20, false, null), 5).action.criteria.wait).toBe("hold the block for a better moment");
    // laya-ts adds the "drop: " / "wait: " labels itself.
    for (const v of Object.values(buildQuestion(pred(3, true), 5).action.criteria)) expect(v).not.toMatch(/^(drop|wait):/);
  });

  it("puts the prediction in a flat, rounded state", () => {
    const s = buildState(pred(-4.4, true), 5, 3);
    expect(s).toMatchObject({ landing_offset_px: -4, approaching_center: true, look_ahead_ms: 1800, tolerance_px: 5, blocks_placed: 3 });
    expect(Object.values(s).every((v) => v === null || typeof v !== "object")).toBe(true);
  });
});

describe("heuristic", () => {
  it.each([
    [0, true, "drop"],
    [5, true, "drop"],
    [-5, true, "drop"],
    [5.1, true, "wait"],
    [-30, true, "wait"],
    [2, false, "wait"],
    [0, false, "wait"],
  ] as const)("offset %d px, approaching %s -> %s", (offset, approaching, action) => {
    expect(heuristicAction(pred(offset, approaching), 5)).toBe(action);
  });

  it("is a Player", async () => {
    const p = pred(1, true);
    const d = await new HeuristicPlayer().decide({ prediction: p, state: buildState(p, 5, 0), question: buildQuestion(p, 5), tolerancePx: 5 });
    expect(d).toEqual({ action: "drop", player: "heuristic" });
  });
});

describe("random", () => {
  it("is reproducible from a seed and drops at about its rate", async () => {
    const run = async (seed: number) => {
      const r = new RandomPlayer(0.2, seed);
      const out: string[] = [];
      for (let i = 0; i < 2000; i++) out.push((await r.decide()).action);
      return out;
    };
    const a = await run(42);
    expect(await run(42)).toEqual(a);
    const rate = a.filter((x) => x === "drop").length / a.length;
    expect(rate).toBeGreaterThan(0.17);
    expect(rate).toBeLessThan(0.23);
  });
});
