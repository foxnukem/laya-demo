import { describe, expect, it } from "vitest";
import { amplitude, fitSine, Predictor, type Timing } from "../src/predictor";
import { SCENE, swing, trueOffset, type Scene } from "./synth";

const feed = (s: Scene, t0: number, ms: number, fps = 30, jitter = 0) => {
  const p = new Predictor();
  let k = 0;
  for (const o of swing(s, t0, ms, fps)) {
    // Deterministic ±jitter px, standing in for detection rounding.
    const e = jitter * Math.sin(++k * 12.9898);
    p.push({ t: o.t, blockX: o.blockX + e, towerX: o.towerX - e });
  }
  return p;
};

describe("sine fit", () => {
  it("recovers swing period, amplitude and center", () => {
    const obs = swing({ ...SCENE, swingPeriodMs: 1700, swingAmp: 45, pivotX: 130 }, 500, 4000, 30);
    const f = fitSine(obs.map((o) => o.t), obs.map((o) => o.blockX));
    expect((2 * Math.PI) / f.omega).toBeCloseTo(1700, -1);
    expect(amplitude(f)).toBeCloseTo(45, 0);
    expect(f.c).toBeCloseTo(130, 0);
  });

  it("treats a still series as constant", () => {
    const ts = Array.from({ length: 60 }, (_, i) => i * 33);
    const f = fitSine(ts, ts.map(() => 118));
    expect(f.omega).toBe(0);
    expect(f.c).toBeCloseTo(118, 6);
  });
});

describe("landing prediction", () => {
  const timings: Timing[] = [
    { fallMs: 0, latencyMs: 0, carry: 0 },
    { fallMs: 600, latencyMs: 150, carry: 0 },
    { fallMs: 600, latencyMs: 1200, carry: 0 },
    { fallMs: 450, latencyMs: 1300, carry: 0.6 },
  ];
  const scenes: [string, Scene][] = [
    ["still tower", SCENE],
    ["swaying tower", { ...SCENE, swayAmp: 14, swayPeriodMs: 3100, swingPeriodMs: 1800, swingPhase: 1 }],
  ];

  for (const [name, s] of scenes) {
    for (const tm of timings) {
      it(`${name}, fall ${tm.fallMs} ms, latency ${tm.latencyMs} ms, carry ${tm.carry}`, () => {
        const now = 4000;
        const p = feed(s, 0, now).predict(now, tm)!;
        expect(p.releaseT).toBe(now + tm.latencyMs);
        expect(p.offset).toBeCloseTo(trueOffset(s, now + tm.latencyMs, tm.fallMs, tm.carry), 0);
      });
    }
  }

  it("projects ahead by the latency, not from the current position", () => {
    const now = 4000;
    const pred = feed(SCENE, 0, now);
    const fast = pred.predict(now, { fallMs: 500, latencyMs: 0, carry: 0 })!;
    const slow = pred.predict(now, { fallMs: 500, latencyMs: 700, carry: 0 })!;
    expect(Math.abs(fast.offset - slow.offset)).toBeGreaterThan(10);
    expect(slow.offset).toBeCloseTo(trueOffset(SCENE, now + 700, 500, 0), 0);
  });

  it("stays within 2 px under ±0.5 px detection noise", () => {
    const s = scenes[1][1];
    for (const now of [3000, 3500, 4200]) {
      const p = feed(s, now - 3000, 3000, 30, 0.5).predict(now, timings[2])!;
      expect(Math.abs(p.offset - trueOffset(s, now + 1200, 600, 0))).toBeLessThan(2);
    }
  });

  it("knows whether the block is closing in and when it next lines up", () => {
    const tm: Timing = { fallMs: 500, latencyMs: 300, carry: 0 };
    const pred = feed(SCENE, 0, 4000);
    // Away from the swing peaks and centre crossings, where "closing in" is undefined.
    for (const now of [4050, 4320, 4560, 4900]) {
      const p = pred.predict(now, tm)!;
      const rel = (dt: number) => trueOffset(SCENE, p.releaseT + dt, tm.fallMs, tm.carry);
      expect(p.approaching).toBe(Math.abs(rel(20)) < Math.abs(rel(0)));
      expect(p.nextCenterMs).not.toBeNull();
      expect(Math.abs(rel(p.nextCenterMs!))).toBeLessThan(1);
    }
  });

  it("needs a few observations first", () => {
    const p = new Predictor();
    p.push({ t: 0, blockX: 100, towerX: 120 });
    expect(p.predict(0, { fallMs: 500, latencyMs: 0, carry: 0 })).toBeNull();
  });
});
