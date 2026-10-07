// Rendering only: the live vision canvas with its overlay, the drop table, small formatters.
import { center, type Box, type Frame } from "./perception";
import type { DropSample, Step } from "./loop";
import { side } from "./prompt";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const fmt = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined || Number.isNaN(x) ? "–" : x.toFixed(digits);

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Mirror of the game canvas with detection boxes, the tower center line and the predicted landing point. */
export function drawVision(canvas: HTMLCanvasElement, frame: Frame, step: Step | null, tolerancePx: number) {
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  const g = canvas.getContext("2d")!;
  g.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  if (!step) return;
  const box = (b: Box, color: string, dash: number[] = []) => {
    g.setLineDash(dash);
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    g.setLineDash([]);
  };
  const { det, prediction: p } = step;
  const top = det.towerTop;
  // Red on the hook; dashed amber while a drop is being tracked.
  if (det.block) box(det.block, step.hanging ? css("--block") : css("--warn"), step.hanging ? [] : [2, 2]);
  if (!top) return;
  box(top, css("--tower"));
  const cx = Math.round(center(top)) + 0.5;
  g.strokeStyle = css("--tower");
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(cx, 0);
  g.lineTo(cx, top.y);
  g.stroke();
  g.setLineDash([]);
  if (!p) return;
  // Tolerance band at the tower top, and where the block would land if the key went down now.
  const tx = p.towerX;
  g.fillStyle = css("--band");
  g.fillRect(tx - tolerancePx, top.y - 3, tolerancePx * 2, 3);
  const good = Math.abs(p.offset) <= tolerancePx;
  g.fillStyle = good ? css("--good") : css("--warn");
  g.beginPath();
  g.moveTo(p.landX, top.y - 1);
  g.lineTo(p.landX - 4, top.y - 8);
  g.lineTo(p.landX + 4, top.y - 8);
  g.closePath();
  g.fill();
}

export function predictionText(step: Step | null): string {
  const p = step?.prediction;
  if (!step || !step.det.block) return "no block";
  if (!step.hanging) return "drop in progress";
  if (!p) return "learning the swing…";
  const period = p.periodMs ? `${fmt(p.periodMs)} ms swing` : "still block";
  return `if dropped now: lands ${side(p.offset)} · ${period} · look-ahead ${fmt(p.landT - p.t)} ms`;
}

const cls = (e: number | null, tol: number) => (e === null ? "" : Math.abs(e) <= tol ? "good" : "bad");

/** Last 20 drops; `now` is the error replayed with the timing currently in use. */
export function renderDrops(tbody: HTMLElement, samples: DropSample[], tolerancePx: number, now: (s: DropSample) => number | null) {
  const rows = samples.slice(-20).reverse().map((s) => {
    const n = now(s);
    return `<tr>
      <td>${s.source}</td><td>${s.status}</td>
      <td>${fmt(s.tLand === null ? null : s.tLand - s.tKey)}</td>
      <td>${fmt(s.offset, 1)}</td>
      <td class="${cls(s.error, tolerancePx)}">${fmt(s.error, 1)}</td>
      <td class="${cls(n, tolerancePx)}">${fmt(n, 1)}</td></tr>`;
  });
  tbody.innerHTML = rows.join("") || `<tr><td colspan="6" class="muted">no drops yet</td></tr>`;
}

/** How many errors are within `tolerancePx`, and their mean magnitude. */
export function accuracy(errors: (number | null)[], tolerancePx: number) {
  const scored = errors.filter((e): e is number => e !== null);
  const within = scored.filter((e) => Math.abs(e) <= tolerancePx).length;
  const meanAbs = scored.reduce((a, e) => a + Math.abs(e), 0) / Math.max(1, scored.length);
  return { scored: scored.length, within, meanAbs: scored.length ? meanAbs : NaN };
}

export function download(name: string, text: string, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
