// App wiring: emulator frame, key routing, the vision loop, calibration and timing panels.
import { Calibrator, estimateTiming, type Tool } from "./calibrate";
import { capture, type Captured } from "./capture";
import { Emulator } from "./emulator";
import { routeKey, type Effect, type KeyIn, type Mode } from "./input";
import { Vision, type DropSample, type Step } from "./loop";
import { fromJSON, isCalibrated, loadConfig, perceptionConfig, saveConfig, timingFor, toJSON } from "./storage";
import { $, accuracy, download, drawVision, fmt, predictionText, renderDrops } from "./ui";

const config = await loadConfig();
const emu = new Emulator($<HTMLIFrameElement>("emu"));
let mode: Mode = "manual";
let vision: Vision | null = null;
let frame: Captured | null = null;
let step: Step | null = null;
const drops: DropSample[] = [];

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
    if (e.kind === "userDrop") vision?.keyPressed(performance.now(), "user");
    if (e.kind === "mode") $("mode").textContent = e.to;
  }
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
      if (step.completed.status !== "nostart") drops.push(step.completed);
      renderTiming();
    }
    drawVision($<HTMLCanvasElement>("vision"), frame, step, config.settings.tolerancePx);
    $("prediction").textContent = vision ? predictionText(step) : "calibrate first";
    const pm = vision?.perceptionMs;
    $("vision-perf").textContent = pm?.count ? `perception ${fmt(pm.mean, 1)} ms · p95 ${fmt(pm.p95, 1)} ms` : `${frame.width}×${frame.height}`;
  }
  $("game-status").textContent = canvas ? `${canvas.width}×${canvas.height} · app ${emu.storedAppId ?? "–"}` : "no game running";
  setTimeout(tick, 1000 / config.settings.visionFps);
}

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
$("apply-timing").onclick = () => {
  config.timing = estimateTiming(drops, config.timing);
  configChanged();
  renderTiming();
};
$("reset-drops").onclick = () => {
  drops.length = 0;
  renderTiming();
};

function renderTiming() {
  const tm = config.timing;
  const est = estimateTiming(drops, tm);
  const tol = config.settings.tolerancePx;
  $("timing-status").textContent = `in use: fall ${fmt(tm.fallMs)} ms · key ${fmt(tm.keyLatencyMs)} ms · user ${fmt(tm.userLatencyMs)} ms · carry ${fmt(tm.carry, 2)}`;
  $("timing-measured").textContent = `measured (${est.samples} landed): fall ${fmt(est.fallMs)} ms · key ${fmt(est.keyLatencyMs)} ms · user ${fmt(est.userLatencyMs)} ms · carry ${fmt(est.carry, 2)}`;
  const acc = accuracy(drops, tol);
  $("accuracy").textContent = `prediction within ${tol} px: ${acc.within}/${acc.scored} · mean |error| ${fmt(acc.meanAbs, 1)} px`;
  renderDrops($("drops"), drops, tol);
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
renderTiming();
if (!emu.launch()) emu.openLibrary();
tick();
