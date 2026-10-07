import { describe, expect, it } from "vitest";
import { estimateTiming } from "../src/calibrate";
import { DropTracker, Vision, type DropSample } from "../src/loop";
import { makeTemplate, type Detection, type Match, type PerceptionConfig } from "../src/perception";
import { DEFAULT_CONFIG, fromJSON, toJSON, type AppConfig } from "../src/storage";
import { blockBox, drawScene, dropTruth, SCENE, SKY_BOTTOM, SKY_TOP, towerTopBox, type Drop, type Scene } from "./synth";

const SKY = [SKY_TOP, SKY_BOTTOM];
const FRAME_MS = 1000 / 30;

function perception(s: Scene): PerceptionConfig {
  const f = drawScene(s, 0);
  return {
    block: [makeTemplate(f, blockBox(s, 0), SKY, 20)],
    tower: [makeTemplate(f, towerTopBox(s, 0), SKY, 20)],
    sky: SKY, skyTolerance: 20, maxScore: 30, step: 4,
  };
}

/** Play a scene at 30 fps, press the drop key at drop.tKey, return the tracked sample. */
function play(s: Scene, drop: Drop) {
  const v = new Vision(perception(s), () => ({ fallMs: drop.fallMs, latencyMs: drop.latencyMs, carry: drop.carry }));
  let pressed = false;
  // ~1.5 swing periods of history before the key is enough to fit the swing.
  for (let k = Math.floor((drop.tKey - 3000) / FRAME_MS); k < 400; k++) {
    const t = k * FRAME_MS;
    if (!pressed && t >= drop.tKey) {
      v.keyPressed(drop.tKey, "test");
      pressed = true;
    }
    const step = v.step(drawScene(s, t, drop), t);
    if (step.completed) return step.completed;
  }
  throw new Error("drop never completed");
}

describe("drop tracking on rendered frames", () => {
  const base: Drop = { tKey: 4010, latencyMs: 80, fallMs: 500, carry: 0, respawnMs: 400, accelerate: true };
  // Key times chosen so each block lands on the tower; the synthetic scene can't show a miss.
  const cases: [string, Scene, Drop][] = [
    ["gravity fall", SCENE, base],
    ["constant-speed fall", SCENE, { ...base, accelerate: false, fallMs: 650 }],
    ["fall that keeps half the swing speed", SCENE, { ...base, carry: 0.5, tKey: 3790 }],
    ["swaying tower", { ...SCENE, swayAmp: 10, swayPeriodMs: 3100 }, { ...base, tKey: 3950, latencyMs: 120 }],
  ];

  for (const [name, s, drop] of cases) {
    it(name, () => {
      const d = play(s, drop);
      const truth = dropTruth(s, drop);
      expect(d.status).toBe("landed");
      expect(Math.abs(d.tStart! - truth.tStart)).toBeLessThan(12);
      expect(Math.abs(d.tLand! - truth.tLand)).toBeLessThan(20);
      expect(Math.abs(d.offset! - truth.offset)).toBeLessThan(1.5);
      // The prediction made at key time, with the right timing, lands where the block did.
      expect(Math.abs(d.error!)).toBeLessThan(2);
    });
  }
});

describe("timing estimate", () => {
  it("recovers fall time, latencies and carry from tracked drops", { timeout: 20_000 }, () => {
    const s = SCENE;
    const samples: DropSample[] = [];
    // Key times whose drops land on the tower (|offset| < 25 px) with this carry.
    for (const [i, tKey] of [3690, 3770, 3850, 4730, 4820].entries()) {
      const user: Drop = { tKey, latencyMs: 30, fallMs: 520, carry: 0.4, respawnMs: 400, accelerate: true };
      samples.push(play(s, user));
      samples[samples.length - 1].source = i < 3 ? "user" : "test";
    }
    // The "test" drops ran with the same 30 ms here, so both latencies should come out at ~30.
    const est = estimateTiming(samples, DEFAULT_CONFIG.timing);
    expect(est.samples).toBe(5);
    expect(est.fallMs).toBeGreaterThan(500);
    expect(est.fallMs).toBeLessThan(540);
    // Landing x is whole pixels, worth ±3-5 ms at swing speed; 10 ms is ~2 px of release position.
    expect(Math.abs(est.userLatencyMs - 30)).toBeLessThanOrEqual(10);
    expect(Math.abs(est.keyLatencyMs - 30)).toBeLessThanOrEqual(10);
    expect(Math.abs(est.carry - 0.4)).toBeLessThanOrEqual(0.06);
  });

  it("keeps the previous values when there is nothing to measure", () => {
    expect(estimateTiming([], DEFAULT_CONFIG.timing)).toEqual({ ...DEFAULT_CONFIG.timing, samples: 0 });
  });
});

describe("drop tracker outcomes", () => {
  const m = (x: number, y: number): Match => ({ x, y, w: 32, h: 24, score: 0 });
  const tower = m(104, 200);
  const at = (block: Match | null): Detection => ({ block, towerTop: tower });

  it("gives up on a key that released nothing", () => {
    const tr = new DropTracker();
    tr.key(0, "user", null, null, at(m(100, 48)));
    for (let t = 33; t < 1500; t += 33) expect(tr.frame(t, at(m(100, 48)))).toBeNull();
    expect(tr.frame(1600, at(m(100, 48)))?.status).toBe("nostart");
    expect(tr.active).toBe(false);
  });

  it("reports a miss when the block falls past the tower", () => {
    const tr = new DropTracker();
    tr.key(0, "agent", 60, null, at(m(170, 48)));
    let out = null;
    for (let k = 1; k < 40 && !out; k++) out = tr.frame(k * 33, at(m(170, 48 + k * 12)));
    expect(out).toMatchObject({ status: "missed", source: "agent" });
  });

  it("reports a block lost mid-fall", () => {
    const tr = new DropTracker();
    tr.key(0, "user", null, null, at(m(100, 48)));
    tr.frame(33, at(m(100, 60)));
    let out = null;
    for (let k = 2; k < 30 && !out; k++) out = tr.frame(k * 33, at(null));
    expect(out?.status).toBe("lost");
  });

  it("ignores a second key while a drop is in flight", () => {
    const tr = new DropTracker();
    expect(tr.key(0, "user", null, null, at(m(100, 48)))).toBe(true);
    expect(tr.key(10, "agent", null, null, at(m(100, 48)))).toBe(false);
  });
});

describe("config JSON", () => {
  it("round-trips templates and settings", () => {
    const f = drawScene(SCENE, 0);
    const c: AppConfig = structuredClone(DEFAULT_CONFIG);
    const b = blockBox(SCENE, 0);
    c.calibration.block.push({ w: b.w, h: b.h, rgb: makeTemplate(f, b, SKY, 20).rgb });
    c.calibration.sky = SKY;
    c.timing.fallMs = 512;
    c.settings.tolerancePx = 3;
    const back = fromJSON(toJSON(c));
    expect(back).toEqual(c);
  });

  it("fills missing fields with defaults and rejects foreign files", () => {
    expect(fromJSON(JSON.stringify({ version: 1 }))).toEqual(DEFAULT_CONFIG);
    expect(() => fromJSON(JSON.stringify({ hello: 1 }))).toThrow(/version 1/);
  });
});
