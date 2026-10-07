// Fetch the prebuilt freej2me-web `web/` directory (plus LICENSE) at a pinned commit into vendor/.
// The upstream repo commits its built jar under web/, so no Docker build is needed.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMIT = "c19416e75cbc15f9a27f7e967ee81cb108761e30";
const dest = new URL("../vendor/freej2me-web/", import.meta.url).pathname;
const stamp = join(dest, ".commit");

if (existsSync(stamp)) process.exit(0);

const url = `https://codeload.github.com/zb3/freej2me-web/tar.gz/${COMMIT}`;
console.log(`get-emulator: downloading freej2me-web@${COMMIT.slice(0, 7)}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`get-emulator: ${url} -> HTTP ${res.status}`);
const tgz = join(tmpdir(), `freej2me-web-${COMMIT}.tar.gz`);
writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const root = `freej2me-web-${COMMIT}`;
execFileSync("tar", ["-xzf", tgz, "-C", dest, "--strip-components=1", `${root}/web`, `${root}/LICENSE`]);
rmSync(tgz);
writeFileSync(stamp, COMMIT + "\n");
console.log(`get-emulator: ready in ${dest}`);
