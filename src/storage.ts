// App config (calibration, timing, settings): kept in IndexedDB, exported/imported as JSON.
import { toTemplate, type Patch, type PerceptionConfig, type RGB } from "./perception";
import type { Timing } from "./predictor";
import { DEFAULT_ROUTER } from "./input";

export interface Calibration {
  sky: RGB[];
  skyTolerance: number;
  maxScore: number;
  step: number;
  block: Patch[];
  tower: Patch[];
}

export interface TimingCalibration {
  fallMs: number; // block starts falling -> lands
  keyLatencyMs: number; // synthetic key dispatched -> block starts falling
  userLatencyMs: number; // user's key -> block starts falling
  carry: number;
  samples: number;
}

export interface Settings {
  dropKey: string;
  hotkey: string;
  tolerancePx: number; // a landing this close to the tower center counts as perfect
  visionFps: number;
  autoTune: boolean; // refit timing from all drops after each landing
}

export interface AppConfig {
  version: 1;
  calibration: Calibration;
  timing: TimingCalibration;
  settings: Settings;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  calibration: { sky: [], skyTolerance: 18, maxScore: 30, step: 4, block: [], tower: [] },
  timing: { fallMs: 600, keyLatencyMs: 50, userLatencyMs: 50, carry: 0, samples: 0 },
  settings: { dropKey: DEFAULT_ROUTER.dropKey, hotkey: DEFAULT_ROUTER.hotkey, tolerancePx: 5, visionFps: 30, autoTune: true },
};

export const isCalibrated = (c: Calibration) => c.sky.length > 0 && c.block.length > 0 && c.tower.length > 0;

export function perceptionConfig(c: Calibration): PerceptionConfig {
  return {
    block: c.block.map((p) => toTemplate(p, c.sky, c.skyTolerance)),
    tower: c.tower.map((p) => toTemplate(p, c.sky, c.skyTolerance)),
    sky: c.sky,
    skyTolerance: c.skyTolerance,
    maxScore: c.maxScore,
    step: c.step,
  };
}

/** Predictor timing for a decision whose key is sent `extraMs` from now (e.g. Laya's inference time). */
export const timingFor = (t: TimingCalibration, source: "user" | "agent", extraMs = 0): Timing => ({
  fallMs: t.fallMs,
  latencyMs: (source === "user" ? t.userLatencyMs : t.keyLatencyMs) + extraMs,
  carry: t.carry,
});

// ---- JSON -----------------------------------------------------------------

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

type PatchJSON = { w: number; h: number; rgb: string };
const patchToJSON = (p: Patch): PatchJSON => ({ w: p.w, h: p.h, rgb: b64(p.rgb) });
function patchFromJSON(p: PatchJSON): Patch {
  const rgb = unb64(p.rgb);
  if (rgb.length !== p.w * p.h * 3) throw new Error(`patch ${p.w}x${p.h} has ${rgb.length} bytes`);
  return { w: p.w, h: p.h, rgb };
}

export function toJSON(c: AppConfig): string {
  const cal = { ...c.calibration, block: c.calibration.block.map(patchToJSON), tower: c.calibration.tower.map(patchToJSON) };
  return JSON.stringify({ ...c, calibration: cal }, null, 1);
}

/** Parse an exported config; missing fields take their defaults. */
export function fromJSON(text: string): AppConfig {
  const raw = JSON.parse(text);
  if (raw?.version !== 1) throw new Error("not a tower-bloxx-laya config (version 1)");
  const cal = { ...DEFAULT_CONFIG.calibration, ...raw.calibration };
  return {
    version: 1,
    calibration: { ...cal, block: (cal.block ?? []).map(patchFromJSON), tower: (cal.tower ?? []).map(patchFromJSON) },
    timing: { ...DEFAULT_CONFIG.timing, ...raw.timing },
    settings: { ...DEFAULT_CONFIG.settings, ...raw.settings },
  };
}

// ---- IndexedDB --------------------------------------------------------------

const DB = "tower-bloxx-laya";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close()) as Promise<T>;
}

export async function loadConfig(): Promise<AppConfig> {
  const text = await kv<string | undefined>("readonly", (s) => s.get("config"));
  return text ? fromJSON(text) : structuredClone(DEFAULT_CONFIG);
}

export const saveConfig = (c: AppConfig) => kv<IDBValidKey>("readwrite", (s) => s.put(toJSON(c), "config"));
