import { describe, expect, it } from "vitest";
import type { SystemOneResult } from "laya-ts";
import { AgentRunner, Stats } from "../src/loop";
import { LayaPlayer, type DecisionInput, type LayaBackend } from "../src/players";
import type { Prediction } from "../src/predictor";
import { buildQuestion, buildState } from "../src/prompt";

const pred = (offset: number, approaching = true): Prediction => ({
  t: 0, releaseT: 1300, landT: 1900, blockX: 120 + offset, blockVx: 80, towerX: 120, towerVx: 0,
  landX: 120 + offset, offset, approaching, nextCenterMs: 100, periodMs: 2000, swingAmp: 60, swayAmp: 0,
});

const input = (p: Prediction, extra: Partial<DecisionInput> = {}): DecisionInput => ({
  prediction: p, state: buildState(p, 5, 0), question: buildQuestion(p, 5), tolerancePx: 5, ...extra,
});

const answer = (choice: string, conf: number): SystemOneResult => ({
  model: "laya",
  answers: {
    action: {
      type: "choice", choice, probabilities: { drop: conf, wait: 1 - conf },
      confidence: 0, answer_confidence: conf, action: { act_probability: 1 },
    },
  },
  usage: { input_tokens: 0, output_tokens: 0 },
});

/** A backend that answers after `ms` real milliseconds (or throws). */
function backend(make: () => SystemOneResult, ms = 0, fail = false): LayaBackend & { calls: number } {
  const b = {
    calls: 0,
    ask: async () => {
      b.calls++;
      await new Promise((r) => setTimeout(r, ms));
      if (fail) throw new Error("onnx exploded");
      return { result: make(), ms: ms + 1 };
    },
  };
  return b;
}

describe("Laya player", () => {
  it("takes a confident drop/wait answer", async () => {
    const laya = new LayaPlayer(backend(() => answer("wait", 0.9)), () => 0.6);
    // The heuristic would drop here; Laya's answer wins.
    expect(await laya.decide(input(pred(0)))).toEqual({ action: "wait", player: "laya", confidence: 0.9, latencyMs: 1 });
    expect(laya.firstAnswer?.answers.action).toMatchObject({ choice: "wait" });
    expect(laya.latency.count).toBe(1);
  });

  it("falls back to the heuristic below the confidence threshold", async () => {
    const laya = new LayaPlayer(backend(() => answer("wait", 0.53)), () => 0.6);
    expect(await laya.decide(input(pred(2)))).toMatchObject({ action: "drop", player: "heuristic", fallback: "low confidence", confidence: 0.53 });
    expect(laya.fallbacks["low confidence"]).toBe(1);
  });

  it("falls back on an invalid answer or an error", async () => {
    const odd = new LayaPlayer(backend(() => answer("jump", 0.99)), () => 0.6);
    expect((await odd.decide(input(pred(30)))).fallback).toBe("invalid");
    const broken = new LayaPlayer(backend(() => answer("drop", 1), 0, true), () => 0.6);
    expect(await broken.decide(input(pred(30)))).toMatchObject({ action: "wait", fallback: "error" });
  });

  it("answers on time with the heuristic, on a fresh prediction, when the model is late", async () => {
    const be = backend(() => answer("drop", 0.99), 80);
    const laya = new LayaPlayer(be, () => 0.6);
    const fresh = pred(1);
    const d = await laya.decide(input(pred(40), { deadline: performance.now() + 20, predictNow: () => fresh }));
    expect(d).toMatchObject({ action: "drop", player: "heuristic", fallback: "late" });
    // Still thinking about the last question: no second one is queued behind it.
    expect((await laya.decide(input(pred(40)))).fallback).toBe("busy");
    expect(be.calls).toBe(1);
    // Its late answer still teaches the expected latency.
    await new Promise((r) => setTimeout(r, 100));
    expect(laya.latency.mean).toBe(81);
    expect((await laya.decide(input(pred(40)))).player).toBe("laya");
  });
});

describe("agent runner with a thinking player", () => {
  it("plans the press for when the prediction assumed it, and presses fallbacks at once", async () => {
    let now = 1000;
    const clock = () => now;
    const confident = new LayaPlayer({ ask: async () => ({ result: answer("drop", 0.95), ms: 300 }) }, () => 0.6, clock);
    confident.latency.push(300);
    const stats = new Stats();
    const a = new AgentRunner(confident, stats, { slackMs: 150, minHistoryMs: 0 }, clock);
    expect(a.expectedLatencyMs).toBe(300);
    // Answered "instantly" (fake clock): wait until t0 + expected latency before pressing.
    expect(await a.decide(input(pred(0)))).toMatchObject({ stale: false, pressAt: 1300 });

    const unsure = new LayaPlayer({ ask: async () => ({ result: answer("drop", 0.51), ms: 300 }) }, () => 0.6, clock);
    a.player = unsure;
    now = 5000;
    expect(await a.decide(input(pred(0)))).toMatchObject({ stale: false, pressAt: 5000, decision: { fallback: "low confidence" } });
    expect(stats).toMatchObject({ decisions: 2, fallbacks: 1, stale: 0 });
  });
});
