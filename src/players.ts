// Swappable deciders. All see the same prediction, state and question, so bench numbers compare directly.
import type { Prediction } from "./predictor";
import type { Action, GameState, Questions } from "./prompt";

export interface DecisionInput {
  prediction: Prediction;
  state: GameState;
  question: Questions;
  tolerancePx: number;
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
