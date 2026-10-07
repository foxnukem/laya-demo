import { describe, expect, it } from "vitest";
import { center, detect, makeTemplate, matchTemplate, type PerceptionConfig } from "../src/perception";
import { blockBox, blockCenter, drawScene, SCENE, SKY_BOTTOM, SKY_TOP, towerCenter, towerTopBox, type Scene } from "./synth";

const SKY = [SKY_TOP, SKY_BOTTOM];

function config(s: Scene): PerceptionConfig {
  const f = drawScene(s, 0);
  return {
    block: [makeTemplate(f, blockBox(s, 0), SKY, 20)],
    tower: [makeTemplate(f, towerTopBox(s, 0), SKY, 20)],
    sky: SKY,
    skyTolerance: 20,
    maxScore: 30,
    step: 4,
  };
}

const times = Array.from({ length: 24 }, (_, i) => i * 137);

describe("perception", () => {
  it("masks sky pixels out of a template", () => {
    const s = { ...SCENE, swingAmp: 0 };
    const f = drawScene(s, 0);
    const b = blockBox(s, 0);
    const padded = makeTemplate(f, { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }, SKY, 20);
    const solid = padded.mask.reduce((n, m) => n + m, 0);
    // Block pixels plus the 4 rope pixels above it; the sky border is masked.
    expect(solid).toBe(b.w * b.h + 4);
  });

  it("finds the swinging block and the tower top in every frame", () => {
    const cfg = config(SCENE);
    for (const t of times) {
      const d = detect(drawScene(SCENE, t), cfg);
      expect(d.block, `block at t=${t}`).not.toBeNull();
      expect(d.towerTop, `tower at t=${t}`).not.toBeNull();
      expect(Math.abs(center(d.block!) - blockCenter(SCENE, t))).toBeLessThanOrEqual(1);
      expect(d.block!.y).toBe(SCENE.blockTop);
      expect(Math.abs(center(d.towerTop!) - towerCenter(SCENE, t))).toBeLessThanOrEqual(1);
      expect(d.towerTop!.y).toBe(SCENE.towerTop);
    }
  });

  it("tracks a swaying tower under pixel noise", () => {
    const s: Scene = { ...SCENE, swayAmp: 12, noise: 10, seed: 7 };
    const cfg = config({ ...s, noise: 0 });
    for (const t of times) {
      const d = detect(drawScene(s, t), cfg);
      expect(Math.abs(center(d.block!) - blockCenter(s, t))).toBeLessThanOrEqual(1);
      expect(Math.abs(center(d.towerTop!) - towerCenter(s, t))).toBeLessThanOrEqual(1);
    }
  });

  it("reports nothing when the block is absent", () => {
    const cfg = config(SCENE);
    const empty = drawScene({ ...SCENE, towerBlocks: 0, blockTop: -100 }, 0);
    expect(matchTemplate(empty, cfg.block[0], cfg.maxScore)).toEqual([]);
    expect(detect(empty, cfg)).toEqual({ block: null, towerTop: null });
  });

  it("stays within the 15 ms frame budget", () => {
    const cfg = config(SCENE);
    const frames = times.map((t) => drawScene(SCENE, t));
    detect(frames[0], cfg); // warm-up
    const t0 = performance.now();
    for (const f of frames) detect(f, cfg);
    expect((performance.now() - t0) / frames.length).toBeLessThan(15);
  });
});
