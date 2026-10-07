// App wiring: emulator frame, key routing, the vision loop, calibration and timing panels.
import { Calibrator, estimateTiming, replayError, type Tool } from "./calibrate";
import { capture, type Captured } from "./capture";
import { Emulator } from "./emulator";
import { agentMayAct, routeKey, setMode, type Effect, type KeyIn, type Mode } from "./input";
import { AgentRunner, Stats, Vision, type DropSample, type LogRow, type Step } from "./loop";
import { heuristicAction, HeuristicPlayer, RandomPlayer, type Player } from "./players";
import type { Prediction } from "./predictor";
import { buildQuestion, buildState } from "./prompt";
import { fromJSON, isCalibrated, loadConfig, perceptionConfig, saveConfig, timingFor, toJSON } from "./storage";
import { $, accuracy, download, drawVision, fmt, predictionText, renderDrops, renderStats } from "./ui";

const config = await loadConfig();
const emu = new Emulator($<HTMLIFrameElement>("emu"));
let mode: Mode = "manual";
let vision: Vision | null = null;
let frame: Captured | null = null;
let step: Step | null = null;
const drops: DropSample[] = [];
const stats = { agent: new Stats(), user: new Stats() };
const players: Record<string, Player> = { heuristic: new HeuristicPlayer(), random: new RandomPlayer(0.05) };
const agent = new AgentRunner(players.heuristic, stats.agent);
const log: LogRow[] = [];
const LOG_CAP = 200_000; // ~2 h of agent play at 30 decisions/s
const record = (row: LogRow) => {
  log.push(row);
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
};

// ---- config -----------------------------------------------------------------
let saveTimer = 0;
function configChanged() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveConfig(config), 300);
  rebuildVision();
  renderStatic();
}

function rebuildVision() {
  const cal = config.calibration;
  if (!isCalibrated(cal)) {
    vision = null;
    return;
  }
  const pc = perceptionConfig(cal);
  if (vision) vision.perception = pc;
  else vision = new Vision(pc, (src) => timingFor(config.timing, src === "user" ? "user" : "agent"));
}

// ---- keys ---------------------------------------------------------------------
const routerCfg = () => ({ hotkey: config.settings.hotkey, dropKey: config.settings.dropKey });

function apply(effects: Effect[]) {
  for (const e of effects) {
    if (e.kind === "userDrop") userDrop();
    if (e.kind === "mode") modeChanged(e.from, e.to);
  }
}

function modeChanged(from: Mode, to: Mode) {
  mode = to;
  stats.agent.setActive(to === "agent", performance.now());
  const el = $("mode");
  el.textContent = to === "paused" ? "paused (you took over)" : to;
  el.className = `mode ${to}`;
  const hk = $("hotkey-name").textContent;
  $("mode-hint").textContent = {
    manual: "You play. Press the hotkey or Start to hand over.",
    agent: "The agent plays. Press any key to take over; the hotkey stops it.",
    paused: `You have control. Press ${hk} or Start to give it back.`,
  }[to];
  ($("start") as HTMLButtonElement).textContent = to === "paused" ? "Resume agent" : "Start agent";
  if (from !== to) renderStatsPanel();
}

/** State, question and heuristic label for a prediction, as every player and every log row sees them. */
function framing(p: Prediction, placed: number) {
  const tol = config.settings.tolerancePx;
  return { state: buildState(p, tol, placed), question: buildQuestion(p, tol), label: heuristicAction(p, tol) };
}

function userDrop() {
  const p = vision?.keyPressed(performance.now(), "user");
  if (p) record({ t: performance.now(), kind: "user", player: "user", action: "drop", ...framing(p, stats.user.placed) });
}

function onKey(e: KeyboardEvent, origin: KeyIn["origin"]) {
  if (!e.isTrusted) return; // our own synthetic keys
  const t = e.target as HTMLElement | null;
  const editable = origin === "page" && !!t && (t.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName));
  const r = routeKey(mode, { type: e.type as KeyIn["type"], code: e.code, origin, editable, repeat: e.repeat }, routerCfg());
  mode = r.mode;
  if (r.delivery === "block") {
    e.preventDefault();
    e.stopImmediatePropagation();
  } else if (r.delivery === "redispatch") {
    emu.dispatch(e.type as "keydown" | "keyup", e.code, e.key);
  }
  apply(r.effects);
}

// Capture phase on the frame's window runs before the emulator's canvas listener, so the hotkey can be held back.
$("emu").addEventListener("load", () => {
  emu.syncAppId();
  const w = emu.window;
  if (!w) return;
  for (const type of ["keydown", "keyup"] as const) w.addEventListener(type, (e) => onKey(e, "game"), true);
});
for (const type of ["keydown", "keyup"] as const) window.addEventListener(type, (e) => onKey(e, "page"), true);

// ---- vision loop ----------------------------------------------------------------
function tick() {
  const canvas = emu.canvas;
  frame = canvas ? capture(canvas) : null;
  if (frame) {
    step = vision ? vision.step(frame, frame.t) : null;
    if (step?.completed) {
      const done = step.completed;
      if (done.status !== "nostart") drops.push(done);
      if (done.source !== "test") stats[done.source].record(done, config.settings.tolerancePx);
      renderStatsPanel();
      if (config.settings.autoTune && step.completed.status === "landed") {
        config.timing = estimateTiming(drops, config.timing);
        configChanged();
        syncTimingSliders();
      }
      renderTiming();
    }
    if (mode === "agent" && step) maybeDecide(step);
    drawVision($<HTMLCanvasElement>("vision"), frame, step, config.settings.tolerancePx);
    $("prediction").textContent = vision ? predictionText(step) : "calibrate first";
    const pm = vision?.perceptionMs;
    $("vision-perf").textContent = pm?.count ? `perception ${fmt(pm.mean, 1)} ms · p95 ${fmt(pm.p95, 1)} ms` : `${frame.width}×${frame.height}`;
  }
  $("game-status").textContent = canvas ? `${canvas.width}×${canvas.height} · app ${emu.storedAppId ?? "–"}` : "no game running";
  setTimeout(tick, 1000 / config.settings.visionFps);
}

// ---- agent ---------------------------------------------------------------------------
function maybeDecide(st: Step) {
  const v = vision;
  if (!v || !st.hanging || v.tracker.active || agent.busy || !v.ready(agent.opts.minHistoryMs)) return;
  // Look ahead by the key delay plus the player's own thinking time.
  const p = v.predictor.predict(performance.now(), timingFor(config.timing, "agent", agent.expectedLatencyMs));
  if (!p) return;
  const f = framing(p, stats.agent.placed);
  agent.decide({ prediction: p, state: f.state, question: f.question, tolerancePx: config.settings.tolerancePx }).then((ans) => {
    if (!ans) return;
    const d = ans.decision;
    record({
      t: performance.now(), kind: "agent", player: d.player, ...f, action: d.action,
      latencyMs: ans.latencyMs, stale: ans.stale, confidence: d.confidence, fallback: d.fallback,
    });
    // A late answer was made for a block that has moved on; a takeover may have happened meanwhile.
    if (ans.stale || d.action !== "drop" || !agentMayAct(mode) || v.tracker.active || !step?.hanging) return;
    const t = performance.now();
    if (!emu.dispatch("keydown", config.settings.dropKey)) return;
    v.keyPressed(t, "agent");
    setTimeout(() => emu.dispatch("keyup", config.settings.dropKey), 60);
  });
}

function renderStatsPanel() {
  const now = performance.now();
  renderStats($("stats"), [
    [`agent`, agent.player.name, stats.agent.summary(now)],
    ["you", "", stats.user.summary(now)],
  ]);
  $("log-count").textContent = `${log.length} log rows`;
}

$("start").onclick = () => {
  const r = setMode(mode, "agent");
  apply(r.effects);
};
$("stop").onclick = () => apply(setMode(mode, "manual").effects);
const playerSelect = $<HTMLSelectElement>("player");
playerSelect.onchange = () => {
  agent.player = players[playerSelect.value];
  renderStatsPanel();
};
$("reset-stats").onclick = () => {
  stats.agent = new Stats();
  stats.user = new Stats();
  agent.stats = stats.agent;
  stats.agent.setActive(mode === "agent", performance.now());
  renderStatsPanel();
};
setInterval(renderStatsPanel, 1000);

// ---- calibration -------------------------------------------------------------------
const calib = new Calibrator($<HTMLCanvasElement>("calib"), () => config.calibration, configChanged);

$("freeze").onclick = () => frame && calib.freeze(frame);
document.querySelectorAll<HTMLInputElement>("input[name=tool]").forEach((r) => {
  r.onchange = () => (calib.tool = r.value as Tool);
});
$("undo").onclick = () => {
  // Removes the latest sample of the selected tool.
  config.calibration[calib.tool].pop();
  configChanged();
  calib.draw();
};
$("clear").onclick = () => {
  if (!confirm("Clear all calibration samples?")) return;
  Object.assign(config.calibration, { sky: [], block: [], tower: [] });
  configChanged();
  calib.draw();
};
// Sliders, not number fields: the emulator pulls keyboard focus back to its canvas.
const slider = (id: string, get: () => number, set: (v: number) => void) => {
  const el = $<HTMLInputElement>(id);
  const out = el.nextElementSibling as HTMLOutputElement;
  el.value = out.value = String(get());
  el.oninput = () => {
    set(Number(el.value));
    out.value = el.value;
    configChanged();
    calib.draw();
  };
};
slider("sky-tol", () => config.calibration.skyTolerance, (v) => (config.calibration.skyTolerance = v));
slider("max-score", () => config.calibration.maxScore, (v) => (config.calibration.maxScore = v));
slider("tolerance", () => config.settings.tolerancePx, (v) => (config.settings.tolerancePx = v));
slider("vision-fps", () => config.settings.visionFps, (v) => (config.settings.visionFps = v));
const dropKey = $<HTMLSelectElement>("drop-key");
dropKey.value = config.settings.dropKey;
dropKey.onchange = () => {
  config.settings.dropKey = dropKey.value;
  configChanged();
};

$("export").onclick = () => download("tower-bloxx.calibration.json", toJSON(config));
$("import").onclick = () => $("import-file").click();
$<HTMLInputElement>("import-file").onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    Object.assign(config, fromJSON(await file.text()));
    configChanged();
    calib.draw();
  } catch (err) {
    alert(`Import failed: ${(err as Error).message}`);
  }
};

// ---- timing ----------------------------------------------------------------------------
$("test-drop").onclick = async () => {
  if (!vision?.last?.block) return alert("No hanging block detected.");
  const t = performance.now();
  if (!emu.dispatch("keydown", config.settings.dropKey)) return alert("The emulator did not take the key.");
  vision.keyPressed(t, "test");
  await new Promise((r) => setTimeout(r, 60));
  emu.dispatch("keyup", config.settings.dropKey);
};
$("reset-drops").onclick = () => {
  drops.length = 0;
  renderTiming();
};
const autoTune = $<HTMLInputElement>("auto-tune");
autoTune.checked = config.settings.autoTune;
autoTune.onchange = () => {
  config.settings.autoTune = autoTune.checked;
  if (autoTune.checked) {
    config.timing = estimateTiming(drops, config.timing);
    syncTimingSliders();
  }
  configChanged();
  renderTiming();
};

// Moving a timing slider is a manual override, so it switches auto-tune off.
const timingSliders: [string, () => number, (v: number) => void][] = [
  ["fall-ms", () => config.timing.fallMs, (v) => (config.timing.fallMs = v)],
  ["carry", () => config.timing.carry, (v) => (config.timing.carry = v)],
  ["key-latency", () => config.timing.keyLatencyMs, (v) => (config.timing.keyLatencyMs = v)],
  ["user-latency", () => config.timing.userLatencyMs, (v) => (config.timing.userLatencyMs = v)],
];
for (const [id, , set] of timingSliders) {
  const el = $<HTMLInputElement>(id);
  el.oninput = () => {
    set(Number(el.value));
    config.settings.autoTune = autoTune.checked = false;
    syncTimingSliders();
    configChanged();
    renderTiming();
  };
}
function syncTimingSliders() {
  for (const [id, get] of timingSliders) {
    const el = $<HTMLInputElement>(id);
    el.value = String(get());
    (el.nextElementSibling as HTMLOutputElement).value = id === "carry" ? get().toFixed(2) : String(Math.round(get()));
  }
}

function renderTiming() {
  const tm = config.timing;
  const tol = config.settings.tolerancePx;
  $("timing-status").textContent = `${drops.filter((d) => d.status === "landed").length} landed drops · ${config.settings.autoTune ? "auto-tuned" : "manual"}`;
  const then = accuracy(drops.map((d) => d.error), tol);
  const now = accuracy(drops.map((d) => replayError(d, tm)), tol);
  $("accuracy").textContent =
    `within ${tol} px — at drop time: ${then.within}/${then.scored} (mean ${fmt(then.meanAbs, 1)} px)` +
    ` · replayed with these settings: ${now.within}/${now.scored} (mean ${fmt(now.meanAbs, 1)} px)`;
  renderDrops($("drops"), drops, tol, (d) => replayError(d, tm));
}

function renderStatic() {
  const cal = config.calibration;
  $("calib-status").textContent = `${cal.block.length} block · ${cal.tower.length} tower · ${cal.sky.length} sky samples`;
  $("hotkey-name").textContent = config.settings.hotkey === "Backquote" ? "`" : config.settings.hotkey;
}

// ---- boot ----------------------------------------------------------------------------------
$("open-lib").onclick = () => emu.openLibrary();
$("launch").onclick = () => emu.launch() || alert("Open the library, add Tower Bloxx and click it once.");
rebuildVision();
renderStatic();
syncTimingSliders();
renderTiming();
if (!emu.launch()) emu.openLibrary();
tick();
