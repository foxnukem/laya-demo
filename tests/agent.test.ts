import { describe, expect, it } from "vitest";
import { AgentRunner, outcome, Stats, type DropSample } from "../src/loop";
import type { Decision, DecisionInput, Player } from "../src/players";
import { Predictor } from "../src/predictor";

const sample = (status: DropSample["status"], offset: number | null, source: DropSample["source"] = "agent"): DropSample => ({
  source, status, tKey: 0, tStart: 50, tLand: 600, swing: null,
  landX: offset === null ? null : 120 + offset, towerX: 120, offset, predicted: null, error: null,
});

describe("drop outcomes", () => {
  it.each([
    ["landed", 0, "perfect"],
    ["landed", -5, "perfect"],
    ["landed", 5.5, "placed"],
    ["missed", 40, "missed"],
    ["lost", null, "lost"],
    ["nostart", null, null],
  ] as const)("%s at %s px -> %s", (status, offset, expected) => {
    expect(outcome(sample(status, offset), 5)).toBe(expected);
  });
});

describe("stats", () => {
  it("counts drops and averages offsets over placed blocks", () => {
    const s = new Stats();
    for (const [st, off] of [["landed", 2], ["landed", -8], ["missed", 50], ["nostart", null], ["landed", 0]] as const) {
      s.record(sample(st, off), 5);
    }
    expect(s.summary(0)).toMatchObject({ drops: 4, placed: 3, perfect: 2, missed: 1, lost: 0 });
    expect(s.summary(0).meanAbsOffset).toBeCloseTo(10 / 3, 6);
  });

  it("measures decisions per second only while the agent is in control", () => {
    const s = new Stats();
    s.setActive(true, 0);
    s.decisions = 10;
    s.setActive(false, 2000);
    s.setActive(false, 9000); // idempotent
    s.setActive(true, 10_000);
    expect(s.summary(12_000).decisionsPerSec).toBeCloseTo(10 / 4, 6);
  });
});

/** A player that answers after `ms` of fake time. */
function slowPlayer(clock: { t: number }, ms: number, action: Decision["action"] = "drop"): Player {
  return {
    name: "slow",
    decide: async () => {
      clock.t += ms;
      return { action, player: "slow" };
    },
  };
}

const input = {} as DecisionInput;

describe("agent runner", () => {
  it("keeps at most one decision in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const player: Player = { name: "gated", decide: async () => (await gate, { action: "wait", player: "gated" }) };
    const a = new AgentRunner(player, new Stats());
    const first = a.decide(input);
    expect(a.busy).toBe(true);
    expect(await a.decide(input)).toBeNull();
    release();
    expect((await first)?.decision.action).toBe("wait");
    expect(a.busy).toBe(false);
  });

  it("learns its latency and flags answers past their deadline as stale", async () => {
    const clock = { t: 0 };
    const stats = new Stats();
    const a = new AgentRunner(slowPlayer(clock, 40), stats, { slackMs: 100, minHistoryMs: 0 }, () => clock.t);
    expect((await a.decide(input))?.stale).toBe(false); // 40 ms <= 0 expected + 100 slack
    expect(a.expectedLatencyMs).toBe(40);
    a.player = slowPlayer(clock, 300);
    expect(await a.decide(input)).toMatchObject({ stale: true, latencyMs: 300 }); // 300 > 40 + 100
    a.player = slowPlayer(clock, 200);
    expect((await a.decide(input))?.stale).toBe(false); // expected is now (40 + 300) / 2 = 170
    expect(stats.decisions).toBe(3);
    expect(stats.stale).toBe(1);
  });

  it("survives a player that throws", async () => {
    const stats = new Stats();
    const a = new AgentRunner({ name: "broken", decide: async () => { throw new Error("boom"); } }, stats);
    expect(await a.decide(input)).toBeNull();
    expect(a.busy).toBe(false);
    expect(stats.errors).toBe(1);
  });
});

describe("swing history", () => {
  it("reports how much time it covers", () => {
    const p = new Predictor();
    expect(p.spanMs).toBe(0);
    for (let t = 500; t <= 2000; t += 100) p.push({ t, blockX: 100, towerX: 120 });
    expect(p.spanMs).toBe(1500);
  });
});
