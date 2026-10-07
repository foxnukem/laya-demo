// Prediction -> the state object and the two-option choice question every player sees.
import type { Prediction } from "./predictor";

export type Action = "drop" | "wait";
export const ACTIONS: readonly Action[] = ["drop", "wait"];

export interface GameState {
  landing_offset_px: number; // where the block lands if dropped now; < 0 = left of the tower center
  approaching_center: boolean;
  next_center_in_ms: number | null;
  block_speed_px_s: number;
  tower_sway_px_s: number;
  swing_period_ms: number | null;
  look_ahead_ms: number;
  tolerance_px: number;
  blocks_placed: number;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<Action, string>;
}

export type Questions = { action: ChoiceQuestion };

const r = (x: number) => Math.round(x);

export function side(offset: number): string {
  const px = Math.abs(r(offset));
  if (px === 0) return "on the tower center";
  return `${px} px ${offset < 0 ? "left" : "right"} of the tower center`;
}

export function buildState(p: Prediction, tolerancePx: number, blocksPlaced: number): GameState {
  return {
    landing_offset_px: r(p.offset),
    approaching_center: p.approaching,
    next_center_in_ms: p.nextCenterMs === null ? null : r(p.nextCenterMs),
    block_speed_px_s: r(p.blockVx),
    tower_sway_px_s: r(p.towerVx),
    swing_period_ms: p.periodMs === null ? null : r(p.periodMs),
    look_ahead_ms: r(p.landT - p.t),
    tolerance_px: tolerancePx,
    blocks_placed: blocksPlaced,
  };
}

export function buildQuestion(p: Prediction, tolerancePx: number): Questions {
  const wait =
    p.nextCenterMs === null
      ? "wait: hold the block for a better moment"
      : `wait: the block next lines up with the tower center in ${r(p.nextCenterMs)} ms`;
  return {
    action: {
      type: "choice",
      instructions: `Tower Bloxx: release the swinging block now, or wait? A drop within ${tolerancePx} px of the tower center is good.`,
      criteria: {
        drop: `drop: lands ${side(p.offset)}`,
        wait,
      },
    },
  };
}
