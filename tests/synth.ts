// Synthetic Tower Bloxx-like scenes with known ground truth: sky gradient, a block swinging on a rope,
// a swaying tower of the same blocks. Erasable TS only, so plain Node can import it (scripts/make-fixtures.mjs).

export interface Scene {
  width: number;
  height: number;
  blockW: number;
  blockH: number;
  pivotX: number;
  blockTop: number; // y of the hanging block
  swingAmp: number; // px
  swingPeriodMs: number;
  swingPhase: number; // rad
  towerTop: number; // y of the top tower block
  towerBlocks: number;
  towerX: number; // rest center of the tower
  swayAmp: number;
  swayPeriodMs: number;
  noise: number; // max per-channel noise
  seed: number;
}

export const SCENE: Scene = {
  width: 240,
  height: 320,
  blockW: 32,
  blockH: 24,
  pivotX: 120,
  blockTop: 48,
  swingAmp: 60,
  swingPeriodMs: 2000,
  swingPhase: 0,
  towerTop: 200,
  towerBlocks: 5,
  towerX: 120,
  swayAmp: 0,
  swayPeriodMs: 3000,
  noise: 0,
  seed: 1,
};

export const SKY_TOP = [120, 180, 235] as [number, number, number];
export const SKY_BOTTOM = [150, 200, 245] as [number, number, number];
const BODY = [200, 80, 60];
const EDGE = [90, 30, 20];
const WINDOW = [240, 220, 120];
const ROPE = [60, 60, 60];

export const blockCenter = (s: Scene, t: number) =>
  s.pivotX + s.swingAmp * Math.sin((2 * Math.PI * t) / s.swingPeriodMs + s.swingPhase);
/** px/ms */
export const blockVelocity = (s: Scene, t: number) =>
  ((s.swingAmp * 2 * Math.PI) / s.swingPeriodMs) * Math.cos((2 * Math.PI * t) / s.swingPeriodMs + s.swingPhase);
export const towerCenter = (s: Scene, t: number) =>
  s.towerX + s.swayAmp * Math.sin((2 * Math.PI * t) / s.swayPeriodMs);

export function blockBox(s: Scene, t: number) {
  return { x: Math.round(blockCenter(s, t) - s.blockW / 2), y: s.blockTop, w: s.blockW, h: s.blockH };
}

export function towerTopBox(s: Scene, t: number) {
  return { x: Math.round(towerCenter(s, t) - s.blockW / 2), y: s.towerTop, w: s.blockW, h: s.blockH };
}

/** Landing offset (block center - tower center) for a key that reaches the game at releaseT. */
export function trueOffset(s: Scene, releaseT: number, fallMs: number, carry: number): number {
  const x = blockCenter(s, releaseT) + carry * blockVelocity(s, releaseT) * fallMs;
  return x - towerCenter(s, releaseT + fallMs);
}

function rng(seed: number) {
  let v = seed >>> 0;
  return () => {
    v = (Math.imul(v, 1664525) + 1013904223) >>> 0;
    return v / 4294967296;
  };
}

function drawBlock(data: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, w: number, h: number) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x0 + x;
      const py = y0 + y;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const edge = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
      const win = !edge && (x % 10 >= 4 && x % 10 < 9) && (y % 10 >= 4 && y % 10 < 9);
      const c = edge ? EDGE : win ? WINDOW : BODY;
      data.set(c, (py * width + px) * 4);
    }
  }
}

export function drawScene(s: Scene, t: number) {
  const { width, height } = s;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const k = y / (height - 1);
    const c = SKY_TOP.map((v, i) => Math.round(v + (SKY_BOTTOM[i] - v) * k));
    for (let x = 0; x < width; x++) data.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
  }
  const b = blockBox(s, t);
  // Rope from the pivot to the top center of the block.
  const bx = b.x + s.blockW / 2;
  for (let y = 0; y < b.y; y++) {
    const x = Math.round(s.pivotX + ((bx - s.pivotX) * y) / b.y);
    data.set(ROPE, (y * width + x) * 4);
  }
  drawBlock(data, width, height, b.x, b.y, s.blockW, s.blockH);
  const tb = towerTopBox(s, t);
  for (let i = 0; i < s.towerBlocks; i++) drawBlock(data, width, height, tb.x, tb.y + i * s.blockH, s.blockW, s.blockH);
  if (s.noise > 0) {
    const r = rng(s.seed + Math.round(t));
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) data[i + c] = data[i + c] + Math.round((r() * 2 - 1) * s.noise);
    }
  }
  return { width, height, data };
}

/** Ground-truth centers sampled at `fps` over `[t0, t0 + durationMs)`. */
export function swing(s: Scene, t0: number, durationMs: number, fps: number) {
  const out: { t: number; blockX: number; towerX: number }[] = [];
  for (let t = t0; t < t0 + durationMs; t += 1000 / fps) {
    out.push({ t, blockX: blockCenter(s, t), towerX: towerCenter(s, t) });
  }
  return out;
}
