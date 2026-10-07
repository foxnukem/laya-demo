// laya-ts is not on npm and has no laya-ts-v* tags yet, so build it from a pinned commit
// and pack it into vendor/. The tarball is committed; rerun only to upgrade deliberately.
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMIT = "a4a8921afebfd852bba0000475cfb6ab737a124c";
const vendor = new URL("../vendor/", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "laya-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("git", ["init", "-q"], work);
run("git", ["fetch", "-q", "--depth", "1", "https://github.com/NandhaKishorM/laya.git", COMMIT], work);
run("git", ["checkout", "-q", "FETCH_HEAD"], work);
const pkg = join(work, "laya-ts");
run("npm", ["install", "--no-audit", "--no-fund"], pkg);
run("npm", ["pack", "--pack-destination", vendor], pkg);

const packed = readdirSync(vendor).find((f) => /^laya-ts-.*\.tgz$/.test(f) && !f.includes("-" + COMMIT.slice(0, 7)));
const target = packed.replace(/\.tgz$/, `-${COMMIT.slice(0, 7)}.tgz`);
renameSync(join(vendor, packed), join(vendor, target));
rmSync(work, { recursive: true, force: true });
console.log(`build-laya-ts: vendor/${target} (update package.json if the name changed)`);
