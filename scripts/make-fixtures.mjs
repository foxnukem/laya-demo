// Write the synthetic scenes the tests use to tests/fixtures/ for eyeballing: PNG frames plus the
// ground-truth swing sequences as JSON. Tests build the same scenes in memory from tests/synth.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { drawScene, SCENE, swing } from "../tests/synth.ts";

const out = new URL("../tests/fixtures/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, tail]);
};

function png({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const scenes = {
  still: SCENE,
  sway: { ...SCENE, swayAmp: 14, swayPeriodMs: 3100, swingPeriodMs: 1800, swingPhase: 1 },
  noisy: { ...SCENE, swayAmp: 12, noise: 10, seed: 7 },
};

for (const [name, s] of Object.entries(scenes)) {
  for (const t of [0, 500, 1000, 1500]) writeFileSync(`${out}${name}-${t}.png`, png(drawScene(s, t)));
  writeFileSync(`${out}${name}-swing.json`, JSON.stringify({ scene: s, fps: 30, samples: swing(s, 0, 4000, 30) }, null, 1));
}
console.log(`make-fixtures: wrote ${Object.keys(scenes).length} scenes to tests/fixtures/`);
