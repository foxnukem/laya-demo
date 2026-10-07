// Frame -> boxes of the hanging block and the tower top, by template matching on RGB.
// Pixels of a template that match the sky are ignored, so the rope and background never count.

export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, like ImageData
}

export type RGB = [number, number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Match extends Box {
  score: number; // mean absolute difference per channel, 0 (identical) .. 255
}

/** Raw pixels cut from a frame; the sky mask is applied when it becomes a Template. */
export interface Patch {
  w: number;
  h: number;
  rgb: Uint8Array; // w*h*3
}

export interface Template {
  w: number;
  h: number;
  rgb: Uint8Array; // w*h*3
  mask: Uint8Array; // w*h, 1 = pixel counts
}

export interface PerceptionConfig {
  block: Template[]; // several samples cover size and lighting changes as the camera climbs
  tower: Template[];
  sky: RGB[];
  skyTolerance: number; // max per-channel distance to a sky sample
  maxScore: number; // matches worse than this are rejected
  step: number; // coarse level: k×k pooling, so also the coarse stride in px
}

export interface Detection {
  block: Match | null;
  towerTop: Match | null;
}

export const center = (b: Box) => b.x + b.w / 2;

export function isSky(r: number, g: number, b: number, sky: RGB[], tol: number): boolean {
  for (const s of sky) {
    if (Math.abs(r - s[0]) <= tol && Math.abs(g - s[1]) <= tol && Math.abs(b - s[2]) <= tol) return true;
  }
  return false;
}

export function cutPatch(frame: Frame, box: Box): Patch {
  const { w, h } = box;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((box.y + y) * frame.width + box.x + x) * 4;
      rgb.set(frame.data.subarray(i, i + 3), (y * w + x) * 3);
    }
  }
  return { w, h, rgb };
}

export function toTemplate(p: Patch, sky: RGB[], skyTolerance: number): Template {
  const mask = new Uint8Array(p.w * p.h);
  for (let j = 0; j < mask.length; j++) {
    mask[j] = isSky(p.rgb[j * 3], p.rgb[j * 3 + 1], p.rgb[j * 3 + 2], sky, skyTolerance) ? 0 : 1;
  }
  return { w: p.w, h: p.h, rgb: p.rgb, mask };
}

/** Cut a template out of a frame; sky pixels are masked out. */
export const makeTemplate = (frame: Frame, box: Box, sky: RGB[], skyTolerance: number): Template =>
  toTemplate(cutPatch(frame, box), sky, skyTolerance);

const counts = new WeakMap<Template, number[]>();
/** Channel values a subsampled pass over the mask compares; the denominator of the final score. */
function maskedChannels(t: Template, sub: number): number {
  let c = counts.get(t);
  if (!c) counts.set(t, (c = []));
  if (c[sub] === undefined) {
    let n = 0;
    for (let y = 0; y < t.h; y += sub) for (let x = 0; x < t.w; x += sub) n += t.mask[y * t.w + x] * 3;
    c[sub] = n;
  }
  return c[sub];
}

function score(frame: Frame, t: Template, ox: number, oy: number, sub: number, cutoff: number): number {
  const total = maskedChannels(t, sub);
  let sum = 0;
  let n = 0;
  const { data, width } = frame;
  for (let y = 0; y < t.h; y += sub) {
    const row = (oy + y) * width + ox;
    for (let x = 0; x < t.w; x += sub) {
      const j = y * t.w + x;
      if (!t.mask[j]) continue;
      const i = (row + x) * 4;
      sum += Math.abs(data[i] - t.rgb[j * 3]) + Math.abs(data[i + 1] - t.rgb[j * 3 + 1]) + Math.abs(data[i + 2] - t.rgb[j * 3 + 2]);
      n += 3;
    }
    // Early exit once even a perfect rest of the template can't beat the cutoff.
    if (sum > cutoff * total) return Infinity;
  }
  return n ? sum / n : Infinity;
}

const iou = (a: Box, b: Box) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
};

/** Greedy non-max suppression, best score first. */
export function nms(matches: Match[], maxIou = 0.3): Match[] {
  const kept: Match[] = [];
  for (const m of [...matches].sort((a, b) => a.score - b.score)) {
    if (kept.every((k) => iou(k, m) <= maxIou)) kept.push(m);
  }
  return kept;
}

/** Summed-area table of non-sky pixels, (w+1)*(h+1); lets the search skip windows that are mostly sky. */
export function solidIntegral(frame: Frame, sky: RGB[], tol: number): Int32Array {
  const { width: w, height: h, data } = frame;
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      row += isSky(data[i], data[i + 1], data[i + 2], sky, tol) ? 0 : 1;
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  return sat;
}

const solidIn = (sat: Int32Array, w: number, x: number, y: number, bw: number, bh: number) =>
  sat[(y + bh) * (w + 1) + x + bw] - sat[y * (w + 1) + x + bw] - sat[(y + bh) * (w + 1) + x] + sat[y * (w + 1) + x];

/** k×k mean-pooled RGB: the coarse level of the search. A shift inside a cell barely changes it. */
export interface Pooled {
  w: number;
  h: number;
  k: number;
  rgb: Float32Array; // w*h*3
  valid: Uint8Array; // w*h, templates only: cell is mostly non-sky
}

export function poolFrame(f: Frame, k: number): Pooled {
  const w = Math.floor(f.width / k);
  const h = Math.floor(f.height / k);
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h * k; y++) {
    const row = Math.floor(y / k) * w;
    for (let x = 0; x < w * k; x++) {
      const i = (y * f.width + x) * 4;
      const j = (row + Math.floor(x / k)) * 3;
      rgb[j] += f.data[i];
      rgb[j + 1] += f.data[i + 1];
      rgb[j + 2] += f.data[i + 2];
    }
  }
  for (let j = 0; j < rgb.length; j++) rgb[j] /= k * k;
  return { w, h, k, rgb, valid: new Uint8Array(w * h).fill(1) };
}

const pooledTemplates = new WeakMap<Template, Pooled>();
function poolTemplate(t: Template, k: number): Pooled {
  const hit = pooledTemplates.get(t);
  if (hit && hit.k === k) return hit;
  const w = Math.floor(t.w / k);
  const h = Math.floor(t.h / k);
  const rgb = new Float32Array(w * h * 3);
  const valid = new Uint8Array(w * h);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = cy * k; y < (cy + 1) * k; y++) {
        for (let x = cx * k; x < (cx + 1) * k; x++) {
          const j = y * t.w + x;
          if (!t.mask[j]) continue;
          for (let c = 0; c < 3; c++) sum[c] += t.rgb[j * 3 + c];
          n++;
        }
      }
      const cell = cy * w + cx;
      valid[cell] = n * 2 >= k * k ? 1 : 0;
      for (let c = 0; c < 3; c++) rgb[cell * 3 + c] = n ? sum[c] / n : 0;
    }
  }
  const p = { w, h, k, rgb, valid };
  pooledTemplates.set(t, p);
  return p;
}

function coarseScore(f: Pooled, t: Pooled, cx: number, cy: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < t.h; y++) {
    for (let x = 0; x < t.w; x++) {
      const j = y * t.w + x;
      if (!t.valid[j]) continue;
      const i = ((cy + y) * f.w + cx + x) * 3;
      sum += Math.abs(f.rgb[i] - t.rgb[j * 3]) + Math.abs(f.rgb[i + 1] - t.rgb[j * 3 + 1]) + Math.abs(f.rgb[i + 2] - t.rgb[j * 3 + 2]);
      n += 3;
    }
  }
  return n ? sum / n : Infinity;
}

interface Search {
  frame: Frame;
  t: Template;
  maxScore: number;
  k: number;
  coarse: Match[]; // coarse hits after NMS, top to bottom
}

/** Coarse search on k×k pooled images (k = `step`); skips mostly-sky windows when `solid` is given. */
function search(frame: Frame, t: Template, maxScore: number, k: number, solid?: Int32Array, pooled?: Pooled): Search {
  const xMax = frame.width - t.w;
  const yMax = frame.height - t.h;
  const coarse: Match[] = [];
  if (xMax >= 0 && yMax >= 0) {
    const pf = pooled?.k === k ? pooled : poolFrame(frame, k);
    const pt = poolTemplate(t, k);
    const minSolid = maskedChannels(t, 1) / 3 / 2;
    // Pooling blurs edges against the background, so the coarse level gets a looser cut.
    const cut = maxScore * 2;
    for (let cy = 0; cy + pt.h <= pf.h; cy++) {
      for (let cx = 0; cx + pt.w <= pf.w; cx++) {
        const x = cx * k;
        const y = cy * k;
        if (x > xMax || y > yMax) continue;
        if (solid && solidIn(solid, frame.width, x, y, t.w, t.h) < minSolid) continue;
        const s = coarseScore(pf, pt, cx, cy);
        if (s <= cut) coarse.push({ x, y, w: t.w, h: t.h, score: s });
      }
    }
  }
  return { frame, t, maxScore, k, coarse: nms(coarse, 0.5).sort((a, b) => a.y - b.y) };
}

/** Two passes around a coarse hit: subsampled over ±k, then every pixel over ±2 around the best of those. */
function refine({ frame, t, maxScore, k }: Search, c: Box): Match | null {
  const xMax = frame.width - t.w;
  const yMax = frame.height - t.h;
  const around = (c: Box, r: number, sub: number, cut: number) => {
    let best: Match = { ...c, score: Infinity };
    for (let y = Math.max(0, c.y - r); y <= Math.min(yMax, c.y + r); y++) {
      for (let x = Math.max(0, c.x - r); x <= Math.min(xMax, c.x + r); x++) {
        const s = score(frame, t, x, y, sub, Math.min(best.score, cut));
        if (s < best.score) best = { x, y, w: t.w, h: t.h, score: s };
      }
    }
    return best;
  };
  const mid = around(c, k, 2, maxScore * 2);
  if (mid.score === Infinity) return null;
  const best = around(mid, 2, 1, maxScore);
  return best.score <= maxScore ? best : null;
}

/** All matches of a template, after non-max suppression. */
export function matchTemplate(
  frame: Frame, t: Template, maxScore: number, step = 4, solid?: Int32Array, pooled?: Pooled,
): Match[] {
  const s = search(frame, t, maxScore, step, solid, pooled);
  return nms(s.coarse.map((c) => refine(s, c)).filter((m): m is Match => m !== null));
}

/** The topmost match whose top is below `minY`: refines coarse hits top to bottom and stops at the first. */
export function matchTopmost(
  frame: Frame, t: Template, maxScore: number, step: number, minY: number, solid?: Int32Array, pooled?: Pooled,
): Match | null {
  const s = search(frame, t, maxScore, step, solid, pooled);
  for (const c of s.coarse) {
    if (c.y + step <= minY) continue;
    const m = refine(s, c);
    if (m && m.y > minY) return m;
  }
  return null;
}

const topmost = (frame: Frame, ts: Template[], cfg: PerceptionConfig, minY: number, solid: Int32Array, pooled: Pooled) =>
  ts
    .map((t) => matchTopmost(frame, t, cfg.maxScore, cfg.step, minY, solid, pooled))
    .filter((m): m is Match => m !== null)
    .sort((a, b) => a.y - b.y || a.score - b.score)[0] ?? null;

/** Hanging block = topmost block match; tower top = topmost tower match below its middle. */
export function detect(frame: Frame, cfg: PerceptionConfig): Detection {
  const solid = solidIntegral(frame, cfg.sky, cfg.skyTolerance);
  const pooled = poolFrame(frame, cfg.step);
  const block = topmost(frame, cfg.block, cfg, -Infinity, solid, pooled);
  const below = block ? block.y + block.h / 2 : -Infinity;
  return { block, towerTop: topmost(frame, cfg.tower, cfg, below, solid, pooled) };
}
