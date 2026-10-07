// Produce the split ONNX model laya-ts loads (encoder.onnx + head.onnx + tokenizer + config).
// No official split export is published on Hugging Face as of 2026-10-06 (convaiinnovations/* ship
// safetensors only; onnx-community/laya-ONNX is one fused graph), so export it once with laya's own
// script in the repo's conda env `master-autumn` (see ../../environment.yml).
import { existsSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMIT = "a4a8921afebfd852bba0000475cfb6ab737a124c";
const REPO = process.argv[2] ?? "convaiinnovations/laya";
const ENV = "master-autumn";
const dir = new URL("../public/models/laya/", import.meta.url).pathname;
const files = ["encoder.onnx", "head.onnx", "tokenizer.json", "rl_agent_config.json"];
const missing = () => files.filter((f) => !existsSync(dir + f));

if (missing().length) {
  const url = `https://raw.githubusercontent.com/NandhaKishorM/laya/${COMMIT}/laya-ts/scripts/export_onnx.py`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`get-model: ${url} -> HTTP ${res.status}`);
  const script = join(tmpdir(), `laya_export_onnx_${COMMIT.slice(0, 7)}.py`);
  writeFileSync(script, await res.text());
  console.log(`get-model: exporting ${REPO} with conda env ${ENV} (downloads ~850 MB once)`);
  execFileSync("conda", ["run", "--no-capture-output", "-n", ENV, "python", script, "--repo", REPO, "--out-dir", dir], {
    stdio: "inherit",
  });
}

if (missing().length) throw new Error(`get-model: still missing ${missing().join(", ")}`);
for (const f of [...files, "encoder.onnx.data", "head.onnx.data"].filter((f) => existsSync(dir + f))) console.log(`${f}  ${(statSync(dir + f).size / 1e6).toFixed(1)} MB`);
