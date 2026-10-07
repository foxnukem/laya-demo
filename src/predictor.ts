// Where would the block land if the drop key were pressed now?
// The block swings like a pendulum and the tower sways, so both are fitted as x(t) = c + a·sin(ωt) + b·cos(ωt)
// over the recent history and projected ahead by latency + fall time; a straight-line fit would be useless
// over the ~1.2 s + fall look-ahead that Laya needs.

export interface Observation {
  t: number; // ms, performance.now()
  blockX: number; // block center
  towerX: number; // tower top center
}

export interface SineFit {
  c: number;
  a: number;
  b: number;
  omega: number; // rad/ms; 0 = constant
  rmse: number;
}

export interface Timing {
  fallMs: number; // key reaches the game -> block lands
  latencyMs: number; // decision asked -> key reaches the game (inference + key delivery)
  carry: number; // share of the block's horizontal speed kept while falling, 0..1
}

export interface Prediction {
  t: number; // when the prediction was made
  releaseT: number;
  landT: number;
  blockX: number; // block center at release
  blockVx: number; // px/s at release
  towerX: number; // tower center at landing
  towerVx: number; // px/s at landing
  landX: number;
  offset: number; // landX - towerX; < 0 = left of the tower center
  approaching: boolean; // the relative offset is shrinking at release
  nextCenterMs: number | null; // time until the relative offset next crosses 0, if within one period
  periodMs: number | null;
  swingAmp: number;
  swayAmp: number;
}

export const evalSine = (f: SineFit, t: number) => f.c + f.a * Math.sin(f.omega * t) + f.b * Math.cos(f.omega * t);
/** d/dt in px/ms. */
export const slopeSine = (f: SineFit, t: number) => f.omega * (f.a * Math.cos(f.omega * t) - f.b * Math.sin(f.omega * t));
export const amplitude = (f: SineFit) => Math.hypot(f.a, f.b);

export function solve3(m: number[][], v: number[]): number[] | null {
  // Gaussian elimination with partial pivoting, 3x3.
  const a = m.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-9) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

function fitAt(ts: number[], xs: number[], omega: number): SineFit | null {
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const v = [0, 0, 0];
  for (let i = 0; i < ts.length; i++) {
    const f = [1, Math.sin(omega * ts[i]), Math.cos(omega * ts[i])];
    for (let r = 0; r < 3; r++) {
      v[r] += f[r] * xs[i];
      for (let c = 0; c < 3; c++) m[r][c] += f[r] * f[c];
    }
  }
  const s = solve3(m, v);
  if (!s) return null;
  const fit = { c: s[0], a: s[1], b: s[2], omega, rmse: 0 };
  let e = 0;
  for (let i = 0; i < ts.length; i++) e += (evalSine(fit, ts[i]) - xs[i]) ** 2;
  fit.rmse = Math.sqrt(e / ts.length);
  return fit;
}

export interface FitOptions {
  minPeriodMs: number;
  maxPeriodMs: number;
  steps: number;
}

export const DEFAULT_FIT: FitOptions = { minPeriodMs: 600, maxPeriodMs: 8000, steps: 160 };

/** Least-squares sine fit: grid search over the period, linear solve for offset and phase, then a local refine. */
export function fitSine(ts: number[], xs: number[], opts: FitOptions = DEFAULT_FIT): SineFit {
  const n = ts.length;
  const mean = xs.reduce((s, x) => s + x, 0) / Math.max(1, n);
  const flat: SineFit = {
    c: mean, a: 0, b: 0, omega: 0,
    rmse: Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n)),
  };
  if (n < 6) return flat;
  // Re-centre time for conditioning; the fit is shifted back below.
  const t0 = ts[n - 1];
  const rel = ts.map((t) => t - t0);
  // Log-spaced periods: equal relative resolution for slow and fast swings.
  const lo = Math.log(opts.minPeriodMs);
  const hi = Math.log(opts.maxPeriodMs);
  let best: SineFit | null = null;
  let bestK = 0;
  for (let k = 0; k <= opts.steps; k++) {
    const period = Math.exp(lo + ((hi - lo) * k) / opts.steps);
    const f = fitAt(rel, xs, (2 * Math.PI) / period);
    if (f && (!best || f.rmse < best.rmse)) [best, bestK] = [f, k];
  }
  if (!best) return flat;
  // Golden-section refine between the neighbouring grid periods.
  let a = Math.exp(lo + ((hi - lo) * Math.max(0, bestK - 1)) / opts.steps);
  let b = Math.exp(lo + ((hi - lo) * Math.min(opts.steps, bestK + 1)) / opts.steps);
  const g = (Math.sqrt(5) - 1) / 2;
  const at = (p: number) => fitAt(rel, xs, (2 * Math.PI) / p);
  for (let i = 0; i < 30; i++) {
    const p1 = b - g * (b - a);
    const p2 = a + g * (b - a);
    const f1 = at(p1);
    const f2 = at(p2);
    if ((f1?.rmse ?? Infinity) < (f2?.rmse ?? Infinity)) b = p2;
    else a = p1;
  }
  const refined = at((a + b) / 2);
  if (refined && refined.rmse < best.rmse) best = refined;
  // Sub-pixel wobble, or a sine that explains little more than a constant: treat the series as still.
  if (flat.rmse < 0.5 || best.rmse > 0.5 * flat.rmse) return flat;
  // Shift the phase back to absolute time: sin(ω(t - t0)) = sin(ωt)cos(ωt0) - cos(ωt)sin(ωt0).
  const w = best.omega;
  const cs = Math.cos(w * t0);
  const sn = Math.sin(w * t0);
  return { c: best.c, a: best.a * cs + best.b * sn, b: best.b * cs - best.a * sn, omega: w, rmse: best.rmse };
}

export interface PredictorOptions {
  windowMs: number; // history kept for fitting; ~2 swing periods
  fit: FitOptions;
}

export class Predictor {
  private obs: Observation[] = [];
  private fits: { block: SineFit; tower: SineFit } | null = null;

  constructor(private opts: PredictorOptions = { windowMs: 4000, fit: DEFAULT_FIT }) {}

  push(o: Observation) {
    this.obs.push(o);
    const cut = o.t - this.opts.windowMs;
    while (this.obs.length && this.obs[0].t < cut) this.obs.shift();
    this.fits = null;
  }

  /** Forget the history, e.g. after a drop when the next block appears. */
  reset() {
    this.obs = [];
    this.fits = null;
  }

  get size() {
    return this.obs.length;
  }

  fit() {
    if (!this.fits) {
      const ts = this.obs.map((o) => o.t);
      this.fits = {
        block: fitSine(ts, this.obs.map((o) => o.blockX), this.opts.fit),
        tower: fitSine(ts, this.obs.map((o) => o.towerX), this.opts.fit),
      };
    }
    return this.fits;
  }

  predict(now: number, timing: Timing): Prediction | null {
    if (this.obs.length < 6) return null;
    return predictLanding(this.fit().block, this.fit().tower, now, timing);
  }
}

export function predictLanding(block: SineFit, tower: SineFit, now: number, timing: Timing): Prediction {
  const releaseT = now + timing.latencyMs;
  const landT = releaseT + timing.fallMs;
  const blockX = evalSine(block, releaseT);
  const blockV = slopeSine(block, releaseT);
  const towerX = evalSine(tower, landT);
  const landX = blockX + timing.carry * blockV * timing.fallMs;
  const offset = landX - towerX;
  // Relative offset if released at time s instead; its slope tells whether the block is closing in.
  const rel = (s: number) =>
    evalSine(block, s) + timing.carry * slopeSine(block, s) * timing.fallMs - evalSine(tower, s + timing.fallMs);
  const dRel = (rel(releaseT + 1) - rel(releaseT - 1)) / 2;
  const periodMs = block.omega > 0 ? (2 * Math.PI) / block.omega : null;
  let nextCenterMs: number | null = null;
  if (periodMs) {
    const stepMs = periodMs / 200;
    let prev = rel(releaseT);
    for (let s = stepMs; s <= periodMs; s += stepMs) {
      const cur = rel(releaseT + s);
      if (Math.sign(cur) !== Math.sign(prev)) {
        nextCenterMs = s - (stepMs * Math.abs(cur)) / Math.abs(cur - prev);
        break;
      }
      prev = cur;
    }
  }
  return {
    t: now,
    releaseT,
    landT,
    blockX,
    blockVx: blockV * 1000,
    towerX,
    towerVx: slopeSine(tower, landT) * 1000,
    landX,
    offset,
    approaching: offset * dRel < 0,
    nextCenterMs,
    periodMs,
    swingAmp: amplitude(block),
    swayAmp: amplitude(tower),
  };
}
