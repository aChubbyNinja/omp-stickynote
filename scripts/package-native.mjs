import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Ship the companion itself: OMP/Bun may disable dependency lifecycle scripts.
// No compiler, installation hook, download, or elevated permission is needed on the target machine.
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The npm release must be built on Linux x64; other platforms can build the companion from source.");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
function run(command, args = []) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.signal ?? result.status}`);
  }
}

run(join(root, "native/bin/build"));
const binary = join(root, "native/build/omp-stickynote-overlay");
const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
if (result.error || result.status !== 0 || result.stdout.trim() !== `omp-stickynote-overlay ${version}`) {
  throw new Error("The native companion version does not match package.json; refusing to publish a stale binary.");
}
const directory = join(root, "native/prebuilt/linux-x64");
await mkdir(directory, { recursive: true });
const packaged = join(directory, "omp-stickynote-overlay");
await copyFile(binary, packaged);
await chmod(packaged, 0o755);
run("strip", ["--strip-unneeded", packaged]);
