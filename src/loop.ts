// Per-frame pipeline (detect -> predict) and drop tracking (key -> block starts falling -> lands or misses).
// DOM-free so it runs in Node tests; main.ts feeds it captured frames and key presses.
import { center, detect, type Detection, type Frame, type PerceptionConfig } from "./perception";
import { Predictor, solve3, type Prediction, type SineFit, type Timing } from "./predictor";
import type { Decision, DecisionInput, Player } from "./players";
import type { Action, GameState, Questions } from "./prompt";

export type DropSource = "user" | "agent" | "test";
export type DropStatus = "landed" | "missed" | "nostart" | "lost";

export interface DropSample {
  source: DropSource;
  status: DropStatus;
  tKey: number;
  tStart: number | null; // block left the hook, from its height (display only: imprecise for a fall from rest)
  tLand: number | null;
  swing: SineFit | null; // the block's swing fit at key time
  landX: number | null;
  towerX: number | null; // tower center at landing
  offset: number | null; // landX - towerX
  predicted: number | null; // predicted offset at key time
  error: number | null; // predicted - offset
}

export interface TrackerOptions {
  startDy: number; // px below its hanging y that counts as falling
  settleFrames: number; // frames without downward motion that count as landed
  startTimeoutMs: number; // key that never released a block (menus, pause)
  fallTimeoutMs: number;
  lostFrames: number; // frames without a block during the fall
}

export const DEFAULT_TRACKER: TrackerOptions = {
  startDy: 3,
  settleFrames: 2,
  startTimeoutMs: 1500,
  fallTimeoutMs: 4000,
  lostFrames: 15,
};

type Armed = {
  phase: "armed" | "falling";
  source: DropSource;
  tKey: number;
  predicted: number | null;
  fit: SineFit | null;
  hangY: number | null;
  towerY: number | null; // top of the tower before this drop
  towerX: number | null;
  tStart: number | null;
  path: [t: number, y: number][]; // block top while falling
  blockH: number;
  lastY: number;
  still: number;
  missing: number;
};

/** Least-squares y = a + b·τ + c·τ² over the fall (τ relative to its first frame); covers both
 * a constant-speed fall (c ≈ 0) and one accelerating from rest. `at(y, lo, hi)` solves for the time. */
export function fallCurve(path: [number, number][]) {
  if (path.length < 3) return null;
  const t0 = path[0][0];
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const v = [0, 0, 0];
  for (const [t, y] of path) {
    const f = [1, t - t0, (t - t0) ** 2];
    for (let r = 0; r < 3; r++) {
      v[r] += f[r] * y;
      for (let c = 0; c < 3; c++) m[r][c] += f[r] * f[c];
    }
  }
  const sol = solve3(m, v);
  if (!sol) return null;
  const [a, b, c] = sol;
  return {
    at(y: number, lo: number, hi: number): number | null {
      const roots =
        Math.abs(c) < 1e-9
          ? Math.abs(b) < 1e-9 ? [] : [(y - a) / b]
          : (() => {
              const d = b * b - 4 * c * (a - y);
              // Just misses y (a fall from rest, plus pixel rounding): take the vertex.
              if (d < 0) return [-b / (2 * c)];
              const q = Math.sqrt(d);
              return [(-b - q) / (2 * c), (-b + q) / (2 * c)];
            })();
      const ok = roots.map((r) => r + t0).filter((t) => t >= lo && t <= hi);
      // Two crossings straddle the vertex of a fall from rest that rounding dipped past y: the vertex is the start.
      return ok.length === 2 ? (ok[0] + ok[1]) / 2 : ok.length ? ok[0] : null;
    },
  };
}

export class DropTracker {
  private s: Armed | null = null;

  constructor(private opts: TrackerOptions = DEFAULT_TRACKER) {}

  get active() {
    return this.s !== null;
  }

  /** A drop key reached the game. Ignored while a drop is already being tracked. */
  key(t: number, source: DropSource, predicted: number | null, fit: SineFit | null, last: Detection | null): boolean {
    if (this.s) return false;
    this.s = {
      phase: "armed", source, tKey: t, predicted, fit,
      hangY: last?.block?.y ?? null,
      towerY: last?.towerTop?.y ?? null,
      towerX: last?.towerTop ? center(last.towerTop) : null,
      tStart: null, path: [], blockH: last?.block?.h ?? 0, lastY: -Infinity, still: 0, missing: 0,
    };
    return true;
  }

  private done(status: DropStatus, tLand: number | null = null, landX: number | null = null): DropSample {
    const s = this.s!;
    this.s = null;
    // Frames only show the fall once it is a few px under way; the fitted fall curve pins down
    // when the block left the hook and when it touched the tower to well within a frame.
    // The touchdown frame shows the block already resting, so it stays out of the fit.
    const fit = fallCurve(status === "landed" ? s.path.slice(0, -1) : s.path);
    if (fit && s.hangY !== null && s.tStart !== null) {
      const t0 = fit.at(s.hangY, s.tKey - 20, s.tStart);
      if (t0 !== null) s.tStart = t0;
    }
    if (fit && status === "landed" && tLand !== null && s.towerY !== null && s.path.length >= 2) {
      const t1 = fit.at(s.towerY - s.blockH, s.path[s.path.length - 2][0], tLand);
      if (t1 !== null) tLand = t1;
    }
    const offset = landX !== null && s.towerX !== null ? landX - s.towerX : null;
    return {
      source: s.source, status, tKey: s.tKey, tStart: s.tStart, tLand,
      swing: s.fit,
      landX, towerX: s.towerX, offset, predicted: s.predicted,
      error: s.predicted !== null && offset !== null ? s.predicted - offset : null,
    };
  }

  frame(t: number, det: Detection): DropSample | null {
    const s = this.s;
    if (!s) return null;
    const o = this.opts;
    const b = det.block;

    if (s.phase === "armed") {
      if (t - s.tKey > o.startTimeoutMs) return this.done("nostart");
      if (det.towerTop) [s.towerY, s.towerX] = [det.towerTop.y, center(det.towerTop)];
      if (!b) return null;
      if (s.hangY !== null && b.y >= s.hangY + o.startDy) {
        s.phase = "falling";
        s.tStart = t;
        s.blockH = b.h;
        s.path.push([t, b.y]);
        s.lastY = b.y;
        return null;
      }
      // hangY stays as seen at key time, so a slow start can't drag the reference down with it.
      s.hangY ??= b.y;
      return null;
    }

    if (t - (s.tStart ?? s.tKey) > o.fallTimeoutMs) return this.done("lost");
    if (!b) return ++s.missing >= o.lostFrames ? this.done("lost") : null;
    s.missing = 0;
    s.path.push([t, b.y]);
    // While the block is above the tower, the tower-top detection is still the old top: keep it current (sway).
    if (det.towerTop && s.towerY !== null && Math.abs(det.towerTop.y - s.towerY) <= 4) s.towerX = center(det.towerTop);
    const overlaps = s.towerX !== null && Math.abs(center(b) - s.towerX) < b.w;
    if (s.towerY !== null && b.y + b.h >= s.towerY - 2) {
      if (overlaps) return this.done("landed", t, center(b));
      if (b.y > s.towerY + b.h) return this.done("missed", t, center(b));
    }
    s.still = b.y <= s.lastY + 1 ? s.still + 1 : 0;
    s.lastY = Math.max(s.lastY, b.y);
    if (s.still >= o.settleFrames && s.tStart !== null && t - s.tStart > 100) {
      return this.done(overlaps ? "landed" : "missed", t, center(b));
    }
    return null;
  }

  cancel() {
    this.s = null;
  }
}

export interface Step {
  t: number;
  det: Detection;
  hanging: boolean; // a block is on the hook and we are not tracking a drop
  prediction: Prediction | null;
  completed: DropSample | null;
  perceptionMs: number;
}

/** Rolling mean / p95 over the last `n` values. */
export class Rolling {
  private xs: number[] = [];
  constructor(private n = 120) {}
  push(x: number) {
    this.xs.push(x);
    if (this.xs.length > this.n) this.xs.shift();
  }
  get count() {
    return this.xs.length;
  }
  get mean() {
    return this.xs.length ? this.xs.reduce((a, b) => a + b, 0) / this.xs.length : NaN;
  }
  get p95() {
    if (!this.xs.length) return NaN;
    const s = [...this.xs].sort((a, b) => a - b);
    return s[Math.ceil(0.95 * s.length) - 1];
  }
}

export class Vision {
  readonly predictor = new Predictor();
  readonly tracker = new DropTracker();
  readonly perceptionMs = new Rolling();
  last: Detection | null = null;

  constructor(
    public perception: PerceptionConfig,
    public timing: (source: DropSource) => Timing,
  ) {}

  step(frame: Frame, t: number): Step {
    const t0 = performance.now();
    const det = detect(frame, this.perception);
    const perceptionMs = performance.now() - t0;
    this.perceptionMs.push(perceptionMs);
    this.last = det;

    let completed: DropSample | null = null;
    if (this.tracker.active) {
      completed = this.tracker.frame(t, det);
      // The next block swings independently of the last one's history.
      if (completed) this.predictor.reset();
    }
    // On the hook = clearly above the tower; a block that just landed sits right on it.
    const hanging = !this.tracker.active && !!det.block && !!det.towerTop && det.block.y + det.block.h < det.towerTop.y - 4;
    if (hanging) this.predictor.push({ t, blockX: center(det.block!), towerX: center(det.towerTop!) });
    const prediction = hanging ? this.predictor.predict(t, this.timing("user")) : null;
    return { t, det, hanging, prediction, completed, perceptionMs };
  }

  /** Enough swing history to trust a decision. */
  ready(minHistoryMs: number) {
    return this.predictor.spanMs >= minHistoryMs;
  }

  /** A drop key reached the game at `t`; returns the prediction it was made with. */
  keyPressed(t: number, source: DropSource): Prediction | null {
    const p = this.predictor.predict(t, this.timing(source));
    this.tracker.key(t, source, p?.offset ?? null, this.predictor.size >= 6 ? this.predictor.fit().block : null, this.last);
    return p;
  }
}

// ---- outcomes and stats ------------------------------------------------------------

export type Outcome = "perfect" | "placed" | "missed" | "lost";

/** Perfect = landed within the tolerance of the tower center; a drop that released nothing is no outcome. */
export function outcome(s: DropSample, tolerancePx: number): Outcome | null {
  if (s.status === "nostart") return null;
  if (s.status === "missed") return "missed";
  if (s.status === "lost") return "lost";
  return s.offset !== null && Math.abs(s.offset) <= tolerancePx ? "perfect" : "placed";
}

export interface StatsSummary {
  drops: number;
  placed: number; // perfect included
  perfect: number;
  missed: number;
  lost: number;
  meanAbsOffset: number;
  decisions: number;
  decisionsPerSec: number;
  stale: number;
  errors: number;
}

export class Stats {
  drops = 0;
  placed = 0;
  perfect = 0;
  missed = 0;
  lost = 0;
  decisions = 0;
  stale = 0;
  errors = 0;
  private absOffset = 0;
  private activeMs = 0;
  private since: number | null = null;

  record(s: DropSample, tolerancePx: number) {
    const o = outcome(s, tolerancePx);
    if (!o) return;
    this.drops++;
    if (o === "perfect" || o === "placed") {
      this.placed++;
      this.absOffset += Math.abs(s.offset ?? 0);
    }
    if (o === "perfect") this.perfect++;
    if (o === "missed") this.missed++;
    if (o === "lost") this.lost++;
  }

  /** The clock for decisions/s runs only while the agent is in control. */
  setActive(on: boolean, now: number) {
    if (on && this.since === null) this.since = now;
    if (!on && this.since !== null) {
      this.activeMs += now - this.since;
      this.since = null;
    }
  }

  summary(now: number): StatsSummary {
    const ms = this.activeMs + (this.since === null ? 0 : now - this.since);
    return {
      drops: this.drops, placed: this.placed, perfect: this.perfect, missed: this.missed, lost: this.lost,
      meanAbsOffset: this.placed ? this.absOffset / this.placed : NaN,
      decisions: this.decisions,
      decisionsPerSec: ms > 0 ? (this.decisions * 1000) / ms : NaN,
      stale: this.stale,
      errors: this.errors,
    };
  }
}

// ---- agent: one decision in flight, each with a deadline -----------------------------

export interface AgentOptions {
  slackMs: number; // an answer later than its expected latency + slack is stale: its prediction no longer holds
  minHistoryMs: number; // swing history needed before deciding at all
}

export const DEFAULT_AGENT: AgentOptions = { slackMs: 100, minHistoryMs: 1200 };

export interface Answer {
  decision: Decision;
  latencyMs: number;
  stale: boolean;
}

export class AgentRunner {
  readonly latency = new Rolling(50);
  busy = false;

  constructor(
    public player: Player,
    public stats: Stats,
    public opts: AgentOptions = DEFAULT_AGENT,
    private clock: () => number = () => performance.now(),
  ) {}

  /** Look-ahead to add for this player's own thinking time. */
  get expectedLatencyMs() {
    return this.latency.count ? this.latency.mean : 0;
  }

  /** Ask the player; null while another decision is in flight or when the player threw. */
  async decide(input: DecisionInput): Promise<Answer | null> {
    if (this.busy) return null;
    this.busy = true;
    const t0 = this.clock();
    const deadline = t0 + this.expectedLatencyMs + this.opts.slackMs;
    try {
      const decision = await this.player.decide(input);
      const t1 = this.clock();
      const latencyMs = t1 - t0;
      this.latency.push(latencyMs);
      const stale = t1 > deadline;
      this.stats.decisions++;
      if (stale) this.stats.stale++;
      return { decision, latencyMs, stale };
    } catch {
      this.stats.errors++;
      return null;
    } finally {
      this.busy = false;
    }
  }
}

/** One training row: what was asked, what the heuristic would say, what was done. */
export interface LogRow {
  t: number;
  kind: "agent" | "user";
  player: string;
  state: GameState;
  question: Questions;
  label: Action; // heuristic
  action: Action;
  latencyMs?: number;
  stale?: boolean;
  confidence?: number;
  fallback?: string;
}
