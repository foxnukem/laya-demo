// Calibration: box the hanging block and the tower top on a frozen frame, sample the sky,
// and turn recorded drops into timing (fall time, key latency, carry).
import { cutPatch, detect, type Box, type Detection, type Frame, type RGB } from "./perception";
import type { DropSample } from "./loop";
import { evalSine, slopeSine } from "./predictor";
import { perceptionConfig, type Calibration, type TimingCalibration } from "./storage";

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const isUser = (s: DropSample) => s.source === "user";

/**
 * Timing that best reproduces where blocks actually landed. For a key at tKey with effective latency L,
 * the block lands at swing(tKey + L) + carry · swing'(tKey + L) · (tLand − tKey − L); L is fitted per key
 * source (user vs. synthetic), carry jointly, by grid search on the landing-x error. Release times read off
 * the block's height are too coarse for this (a fall from rest moves < 1 px in its first ~40 ms).
 * Drops without a swing fit only contribute their measured key → land time.
 */
export function estimateTiming(samples: DropSample[], prev: TimingCalibration): TimingCalibration {
  const landed = samples.filter((s) => s.status === "landed" && s.tLand !== null && s.landX !== null);
  const fitted = landed.filter((s) => s.swing && s.swing.omega > 0);
  const groups = [fitted.filter(isUser), fitted.filter((s) => !isUser(s))];

  const err = (s: DropSample, L: number, carry: number) => {
    const t = s.tKey + L;
    const x = evalSine(s.swing!, t) + carry * slopeSine(s.swing!, t) * (s.tLand! - t);
    return (x - s.landX!) ** 2;
  };
  const bestL = (g: DropSample[], carry: number) => {
    let best = { L: NaN, e: 0 };
    if (!g.length) return best;
    best.e = Infinity;
    for (let L = 0; L <= 400; L += 2) {
      const e = g.reduce((a, s) => a + err(s, L, carry), 0);
      if (e < best.e) best = { L, e };
    }
    return best;
  };
  let fit = { carry: prev.carry, L: [NaN, NaN] };
  if (fitted.length) {
    let bestE = Infinity;
    for (let c = 0; c <= 50; c++) {
      const carry = c / 50;
      const [u, k] = groups.map((g) => bestL(g, carry));
      if (u.e + k.e < bestE) [bestE, fit] = [u.e + k.e, { carry, L: [u.L, k.L] }];
    }
  }
  const [userL, keyL] = fit.L;
  const latencyOf = (s: DropSample) => (isUser(s) ? userL : keyL);
  const falls = landed.map((s) => {
    const L = latencyOf(s);
    return s.tLand! - s.tKey - (Number.isNaN(L) ? (isUser(s) ? prev.userLatencyMs : prev.keyLatencyMs) : L);
  });
  return {
    fallMs: falls.length ? median(falls) : prev.fallMs,
    userLatencyMs: Number.isNaN(userL) ? prev.userLatencyMs : userL,
    keyLatencyMs: Number.isNaN(keyL) ? prev.keyLatencyMs : keyL,
    // Without real sideways motion the carry is unidentifiable; keep the previous one.
    carry: fitted.length >= 2 ? fit.carry : prev.carry,
    samples: landed.length,
  };
}

/**
 * Prediction error this drop would have had with timing `tm` (predicted − actual landing, px), replayed
 * from its swing fit at key time. Tower sway is taken as observed, so this isolates the timing.
 */
export function replayError(s: DropSample, tm: TimingCalibration): number | null {
  if (s.status !== "landed" || !s.swing || s.landX === null) return null;
  const t = s.tKey + (isUser(s) ? tm.userLatencyMs : tm.keyLatencyMs);
  return evalSine(s.swing, t) + tm.carry * slopeSine(s.swing, t) * tm.fallMs - s.landX;
}

/** Mean colour of the 3×3 around (x, y). */
export function sampleColor(f: Frame, x: number, y: number): RGB {
  const sum = [0, 0, 0];
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = Math.min(f.width - 1, Math.max(0, x + dx));
      const py = Math.min(f.height - 1, Math.max(0, y + dy));
      const i = (py * f.width + px) * 4;
      for (let c = 0; c < 3; c++) sum[c] += f.data[i + c];
      n++;
    }
  }
  return sum.map((v) => Math.round(v / n)) as RGB;
}

/** Add a sky sample unless an existing one is within `tol` on every channel. */
export function addSky(sky: RGB[], c: RGB, tol = 4): RGB[] {
  return sky.some((s) => s.every((v, i) => Math.abs(v - c[i]) <= tol)) ? sky : [...sky, c];
}

export type Tool = "block" | "tower" | "sky";

const COLORS = { block: "#ff3b30", tower: "#34c759", sky: "#0a84ff" };

/** The frozen-frame canvas: drag to box a template, click to sample sky. */
export class Calibrator {
  frozen: Frame | null = null;
  tool: Tool = "block";
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private ctx: CanvasRenderingContext2D;

  constructor(
    private canvas: HTMLCanvasElement,
    private cal: () => Calibration,
    private changed: () => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("mousedown", (e) => {
      if (!this.frozen) return;
      const [x, y] = this.toFrame(e);
      this.drag = { x0: x, y0: y, x1: x, y1: y };
    });
    canvas.addEventListener("mousemove", (e) => {
      if (!this.drag) return;
      [this.drag.x1, this.drag.y1] = this.toFrame(e);
      this.draw();
    });
    window.addEventListener("mouseup", () => {
      if (this.drag) this.finish();
    });
  }

  private toFrame(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.canvas.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.canvas.height);
    return [Math.min(this.canvas.width - 1, Math.max(0, x)), Math.min(this.canvas.height - 1, Math.max(0, y))];
  }

  private dragBox(): Box | null {
    if (!this.drag) return null;
    const { x0, y0, x1, y1 } = this.drag;
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 };
  }

  private finish() {
    const box = this.dragBox();
    this.drag = null;
    const f = this.frozen;
    if (!box || !f) return;
    const cal = this.cal();
    if (this.tool === "sky") {
      cal.sky = addSky(cal.sky, sampleColor(f, box.x + (box.w >> 1), box.y + (box.h >> 1)));
    } else if (box.w >= 4 && box.h >= 4) {
      cal[this.tool].push(cutPatch(f, box));
    }
    this.changed();
    this.draw();
  }

  freeze(frame: Frame) {
    this.frozen = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
    this.canvas.width = frame.width;
    this.canvas.height = frame.height;
    this.draw();
  }

  /** Detection on the frozen frame with the current calibration. */
  check(): Detection | null {
    const cal = this.cal();
    if (!this.frozen || !cal.block.length || !cal.tower.length) return null;
    return detect(this.frozen, perceptionConfig(cal));
  }

  draw() {
    const f = this.frozen;
    const g = this.ctx;
    if (!f) return;
    g.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
    const det = this.check();
    const stroke = (b: Box, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    };
    if (det?.block) stroke(det.block, COLORS.block);
    if (det?.towerTop) stroke(det.towerTop, COLORS.tower);
    const d = this.dragBox();
    if (d) {
      g.setLineDash([2, 2]);
      stroke(d, COLORS[this.tool]);
      g.setLineDash([]);
    }
  }
}
