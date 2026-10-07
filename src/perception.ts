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

export interface Template {
  w: number;
  h: number;
  rgb: Float32Array; // w*h*3
  mask: Uint8Array; // w*h, 1 = pixel counts
}

export interface PerceptionConfig {
  block: Template;
  tower: Template;
  sky: RGB[];
  skyTolerance: number; // max per-channel distance to a sky sample
  maxScore: number; // matches worse than this are rejected
  step: number; // coarse search stride in px
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

/** Cut a template out of a frame; sky pixels are masked out. */
export function makeTemplate(frame: Frame, box: Box, sky: RGB[], skyTolerance: number): Template {
  const { w, h } = box;
  const rgb = new Float32Array(w * h * 3);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((box.y + y) * frame.width + box.x + x) * 4;
      const j = y * w + x;
      const [r, g, b] = [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
      rgb.set([r, g, b], j * 3);
      mask[j] = isSky(r, g, b, sky, skyTolerance) ? 0 : 1;
    }
  }
  return { w, h, rgb, mask };
}

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

/**
 * Coarse grid search with a subsampled template, then a full-resolution refine around each hit.
 * With `solid` (see solidIntegral), windows holding under half the template's non-sky pixels are skipped.
 */
export function matchTemplate(frame: Frame, t: Template, maxScore: number, step = 4, solid?: Int32Array): Match[] {
  const xMax = frame.width - t.w;
  const yMax = frame.height - t.h;
  if (xMax < 0 || yMax < 0) return [];
  const minSolid = maskedChannels(t, 1) / 3 / 2;
  const coarse: Match[] = [];
  const coarseCut = maxScore * 1.5;
  for (let y = 0; y <= yMax; y += step) {
    for (let x = 0; x <= xMax; x += step) {
      if (solid && solidIn(solid, frame.width, x, y, t.w, t.h) < minSolid) continue;
      const s = score(frame, t, x, y, 2, coarseCut);
      if (s <= coarseCut) coarse.push({ x, y, w: t.w, h: t.h, score: s });
    }
  }
  const refined: Match[] = [];
  for (const c of nms(coarse, 0.5)) {
    let best: Match = { ...c, score: Infinity };
    for (let y = Math.max(0, c.y - step); y <= Math.min(yMax, c.y + step); y++) {
      for (let x = Math.max(0, c.x - step); x <= Math.min(xMax, c.x + step); x++) {
        const s = score(frame, t, x, y, 1, Math.min(best.score, maxScore));
        if (s < best.score) best = { x, y, w: t.w, h: t.h, score: s };
      }
    }
    if (best.score <= maxScore) refined.push(best);
  }
  return nms(refined);
}

/** Hanging block = topmost block match; tower top = topmost tower match below it. */
export function detect(frame: Frame, cfg: PerceptionConfig): Detection {
  const solid = solidIntegral(frame, cfg.sky, cfg.skyTolerance);
  const blocks = matchTemplate(frame, cfg.block, cfg.maxScore, cfg.step, solid).sort((a, b) => a.y - b.y);
  const block = blocks[0] ?? null;
  const below = block ? block.y + block.h / 2 : -Infinity;
  const towers = matchTemplate(frame, cfg.tower, cfg.maxScore, cfg.step, solid)
    .filter((m) => m.y > below)
    .sort((a, b) => a.y - b.y);
  return { block, towerTop: towers[0] ?? null };
}
