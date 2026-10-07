// Emulator canvas -> pixels of the game area. The canvas is same-origin, so getImageData is allowed.
import type { Box, Frame } from "./perception";

export interface Captured extends Frame {
  t: number; // performance.now() at capture
}

let ctxCache = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

/** Whole canvas, or only `area` (e.g. to drop a HUD strip). */
export function capture(canvas: HTMLCanvasElement, area?: Box): Captured | null {
  let ctx = ctxCache.get(canvas);
  if (!ctx) {
    ctx = canvas.getContext("2d") ?? undefined;
    if (!ctx) return null;
    ctxCache.set(canvas, ctx);
  }
  const { x, y, w, h } = area ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  if (!w || !h) return null;
  const img = ctx.getImageData(x, y, w, h);
  return { width: img.width, height: img.height, data: img.data, t: performance.now() };
}

/** For tests or after the emulator reloads. */
export function resetCaptureCache() {
  ctxCache = new WeakMap();
}
