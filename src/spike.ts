// M0 feasibility spike: answers the four questions on the page. Throwaway code.
import type { WorkerRequest, WorkerResponse } from "./laya.worker";

const $ = (id: string) => document.getElementById(id)!;
const frame = $("emu") as HTMLIFrameElement;
const APP_KEY = "tbl.appId";
const KEYCODES: Record<string, [string, number]> = { Digit5: ["5", 53], Enter: ["Enter", 13], ArrowUp: ["ArrowUp", 38] };

function show(id: string, cls: "ok" | "bad" | "wait", text: string) {
  const el = $(id);
  el.className = cls;
  el.textContent = text;
}

const win = () => frame.contentWindow as (Window & typeof globalThis & { cjFileBlob?: (p: string) => Promise<Blob | null> }) | null;
const display = () => win()?.document.getElementById("display") as HTMLCanvasElement | null;

// ---- 1. library and canvas ------------------------------------------------
let libraryApps: string[] = [];

function openLibrary() {
  frame.src = "/emu/";
}
function launch() {
  const app = localStorage.getItem(APP_KEY);
  if (app) frame.src = `/emu/run.html?app=${encodeURIComponent(app)}`;
  else show("q1", "bad", "No game launched from the library yet: open the library, add the game, click it.");
}
$("open-lib").onclick = openLibrary;
$("launch").onclick = launch;

async function readLibrary() {
  // The launcher keeps its list in CheerpJ's IndexedDB-backed /files/apps.list (see launcher.js loadGames).
  for (let i = 0; i < 120; i++) {
    const w = win();
    const main = w?.document.getElementById("main");
    if (w?.cjFileBlob && main && main.style.display !== "none") {
      const blob = await w.cjFileBlob("/files/apps.list");
      libraryApps = blob ? (await blob.text()).trim().split("\n").filter(Boolean) : [];
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const hashes: { t: number; h: number }[] = [];
function sampleCanvas() {
  const c = display();
  if (!c || !c.width) return;
  const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < data.length; i += 16) h = (h * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) | 0;
  const now = performance.now();
  hashes.push({ t: now, h });
  while (hashes.length && now - hashes[0].t > 5000) hashes.shift();
}

function reportQ1() {
  const w = win();
  const app = new URLSearchParams(w?.location.search ?? "").get("app");
  if (app && app !== localStorage.getItem(APP_KEY)) localStorage.setItem(APP_KEY, app);
  const c = display();
  const distinct = new Set(hashes.map((x) => x.h)).size;
  const lines = [
    `page: ${w?.location.pathname ?? "-"}${w?.location.search ?? ""}`,
    `library (apps.list): ${libraryApps.length ? libraryApps.join(", ") : "(open the library to read it)"}`,
    `stored app id: ${localStorage.getItem(APP_KEY) ?? "-"}`,
    `canvas: ${c && c.width ? `${c.width}×${c.height}` : "not running"}`,
    `getImageData distinct frames in last 5 s: ${distinct}`,
  ];
  const ok = !!(c && c.width && distinct > 1);
  show("q1", ok ? "ok" : "wait", lines.join("\n"));
}

// ---- 2. user keys ---------------------------------------------------------
const keyLog: string[] = [];
let outsideKeys = 0;

function hookFrame() {
  const w = win();
  if (!w) return;
  // Bubble phase on the frame's window, never cancelled: the emulator's display handler has run by then
  // and calls preventDefault on every key it gets, so defaultPrevented means "the game received it".
  w.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    keyLog.unshift(`${e.code.padEnd(10)} target=${(e.target as Element).id || (e.target as Element).tagName} reached-emulator=${e.defaultPrevented}`);
    keyLog.length = Math.min(keyLog.length, 6);
    reportQ2();
  });
  if (w.location.pathname.endsWith("/emu/") || w.location.pathname.endsWith("/index.html")) readLibrary();
}
frame.addEventListener("load", hookFrame);

window.addEventListener("keydown", (e) => {
  if (!e.isTrusted) return;
  outsideKeys++;
  reportQ2();
});

function reportQ2() {
  const reached = keyLog.filter((l) => l.endsWith("true")).length;
  show("q2", reached ? "ok" : "wait", [
    `observed in emulator frame (last ${keyLog.length}):`,
    ...keyLog,
    `keys pressed with focus outside the frame: ${outsideKeys}`,
    "Confirm by eye that menus respond.",
  ].join("\n"));
}

// ---- 3. synthetic keys ----------------------------------------------------
async function sendKey(code: string) {
  const w = win();
  const c = display();
  if (!w || !c) return show("q3", "bad", "emulator canvas not found (launch the game first)");
  const [key, keyCode] = KEYCODES[code];
  const fire = (type: string) => {
    const ev = new w.KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
    // keyCode is not settable through the init dict in Chrome.
    Object.defineProperty(ev, "keyCode", { get: () => keyCode });
    Object.defineProperty(ev, "which", { get: () => keyCode });
    c.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const t0 = performance.now();
  const before = hashes.at(-1)?.h;
  const down = fire("keydown");
  await new Promise((r) => setTimeout(r, 80));
  const up = fire("keyup");
  show("q3", down && up ? "ok" : "bad", [
    `${code}: keydown handled=${down}, keyup handled=${up} (dispatched on #display)`,
    `frame changed since send: (see next sample)`,
    "Did a block drop? Which key does it?",
  ].join("\n"));
  setTimeout(() => {
    const changed = hashes.at(-1)?.h !== before;
    $("q3").textContent += `\nframe changed within ${(performance.now() - t0) | 0} ms: ${changed}`;
  }, 300);
}
document.querySelectorAll<HTMLButtonElement>("button[data-key]").forEach((b) => {
  b.onclick = () => sendKey(b.dataset.key!);
});

// ---- 4. Laya in a worker --------------------------------------------------
const SAMPLE_STATE = {
  game: "Tower Bloxx",
  block_offset_px: -6,
  block_velocity_px_s: 42,
  tower_sway_px_s: 3,
  latency_ms: 120,
};
const SAMPLE_QUESTIONS = {
  action: {
    type: "choice",
    instructions: "Should the crane release the swinging block now?",
    criteria: {
      drop: "drop now: lands 2 px right of the tower center",
      wait: "wait: the block is still moving toward the center",
    },
  },
};

function runLaya() {
  const worker = new Worker(new URL("./laya.worker.ts", import.meta.url), { type: "module" });
  const send = (m: WorkerRequest) => worker.postMessage(m);
  const lines: string[] = [];
  const log = (s: string, cls: "ok" | "bad" | "wait" = "wait") => { lines.push(s); show("q4", cls, lines.join("\n")); };
  const lat: number[] = [];
  let sentAt = 0;
  let id = 0;
  const next = () => { sentAt = performance.now(); send({ type: "predict", id: ++id, state: SAMPLE_STATE, questions: SAMPLE_QUESTIONS }); };

  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const m = e.data;
    if (m.type === "progress") $("q4").textContent = lines.join("\n") + `\nloading ${m.file} (${m.done}/${m.total})`;
    else if (m.type === "loaded") { log(`loaded in ${(m.ms / 1000).toFixed(1)} s, backend: ${m.backend}`); next(); }
    else if (m.type === "error") log(`error: ${m.message}`, "bad");
    else if (m.type === "answer") {
      const rt = performance.now() - sentAt;
      if (id === 1) log(`warm-up (not counted): ${rt.toFixed(0)} ms\nraw answer: ${JSON.stringify(m.result.answers.action)}`);
      else lat.push(rt);
      if (lat.length < 20) return next();
      const s = [...lat].sort((a, b) => a - b);
      const mean = s.reduce((a, b) => a + b, 0) / s.length;
      log(`20 predictions (round trip): mean ${mean.toFixed(0)} ms, p95 ${s[Math.ceil(0.95 * s.length) - 1].toFixed(0)} ms\nbackend in use: ${m.backend}\nnavigator.gpu: ${"gpu" in navigator}`, "ok");
      worker.terminate();
    }
  };
  log("loading /models/laya …");
  send({ type: "load", url: `${location.origin}/models/laya` });
}
$("laya").onclick = runLaya;

// ---- boot -----------------------------------------------------------------
if (localStorage.getItem(APP_KEY)) launch();
else openLibrary();
setInterval(() => { sampleCanvas(); reportQ1(); }, 200);
