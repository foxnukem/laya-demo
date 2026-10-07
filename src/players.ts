// Swappable deciders. All see the same prediction, state and question, so bench numbers compare directly.
import type { SystemOneResult } from "laya-ts";
import { Rolling } from "./loop";
import type { Prediction } from "./predictor";
import { ACTIONS, type Action, type GameState, type Questions } from "./prompt";

export interface DecisionInput {
  prediction: Prediction; // looks ahead by the key delay plus the player's expected latency
  state: GameState;
  question: Questions;
  tolerancePx: number;
  deadline?: number; // clock time after which an answer is stale
  predictNow?: () => Prediction | null; // fresh, no player latency: for a fallback decided on the spot
}

export interface Decision {
  action: Action;
  player: string; // who actually decided ("heuristic" when Laya fell back)
  confidence?: number;
  latencyMs?: number;
  fallback?: string; // why the fallback was used
}

export interface Player {
  readonly name: string;
  readonly latency?: Rolling; // a player that thinks (Laya) reports its own answer times
  decide(input: DecisionInput): Promise<Decision>;
}

/** Drop when the predicted landing is within tolerance and the block is closing in on the center. */
export function heuristicAction(p: Prediction, tolerancePx: number): Action {
  return Math.abs(p.offset) <= tolerancePx && p.approaching ? "drop" : "wait";
}

export class HeuristicPlayer implements Player {
  readonly name = "heuristic";
  async decide({ prediction, tolerancePx }: DecisionInput): Promise<Decision> {
    return { action: heuristicAction(prediction, tolerancePx), player: this.name };
  }
}

/** Mulberry32: tiny seeded PRNG so random runs are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RandomPlayer implements Player {
  readonly name = "random";
  private next: () => number;
  /** dropRate: chance of `drop` per decision. */
  constructor(readonly dropRate = 0.05, seed = Date.now()) {
    this.next = rng(seed);
  }
  async decide(): Promise<Decision> {
    return { action: this.next() < this.dropRate ? "drop" : "wait", player: this.name };
  }
}

// ---- Laya ---------------------------------------------------------------------------

/** One forward pass of the Laya model; `ms` is the round trip as the page sees it. */
export interface LayaBackend {
  readonly ready?: boolean; // false while the model is still loading
  ask(state: GameState, question: Questions): Promise<{ result: SystemOneResult; ms: number }>;
}

export type FallbackReason = "not loaded" | "busy" | "late" | "error" | "invalid" | "low confidence";

const LATE = Symbol("late");

/**
 * Laya decides; the heuristic stands in while the model loads, when it is still busy with an earlier question, answers
 * after the deadline, throws, returns something other than drop/wait, or is less sure than `minConfidence`
 * (answer_confidence: the probability on its chosen option, 0.5..1 for two options).
 */
export class LayaPlayer implements Player {
  readonly name = "laya";
  readonly latency = new Rolling(100);
  readonly fallbacks: Record<FallbackReason, number> = {
    "not loaded": 0, busy: 0, late: 0, error: 0, invalid: 0, "low confidence": 0,
  };
  firstAnswer: SystemOneResult | null = null;
  private pending: Promise<unknown> | null = null;

  constructor(
    public backend: LayaBackend, // swapped when the model is (re)loaded
    private minConfidence: () => number,
    private clock: () => number = () => performance.now(),
  ) {}

  async decide(input: DecisionInput): Promise<Decision> {
    const fallback = (reason: FallbackReason, confidence?: number): Decision => {
      this.fallbacks[reason]++;
      const p = input.predictNow?.() ?? input.prediction;
      return { action: heuristicAction(p, input.tolerancePx), player: "heuristic", fallback: reason, confidence };
    };
    if (this.backend.ready === false) return fallback("not loaded");
    // The worker answers one question at a time; queueing more would only make them later.
    if (this.pending) return fallback("busy");
    const req = this.backend.ask(input.state, input.question).then((r) => {
      this.latency.push(r.ms);
      this.firstAnswer ??= r.result;
      return r;
    });
    const tracked = req.finally(() => (this.pending = null)).catch(() => undefined);
    this.pending = tracked;
    const waitMs = input.deadline === undefined ? Infinity : Math.max(0, input.deadline - this.clock());
    let r: Awaited<typeof req> | typeof LATE;
    try {
      r = await (Number.isFinite(waitMs)
        ? Promise.race([req, new Promise<typeof LATE>((res) => setTimeout(() => res(LATE), waitMs))])
        : req);
    } catch {
      return fallback("error");
    }
    if (r === LATE) return fallback("late");
    const a = r.result.answers?.action;
    if (!a || a.type !== "choice" || !ACTIONS.includes(a.choice as Action)) return fallback("invalid");
    const conf = a.answer_confidence;
    if (!(conf >= this.minConfidence())) return fallback("low confidence", conf);
    return { action: a.choice as Action, player: this.name, confidence: conf, latencyMs: r.ms };
  }
}
