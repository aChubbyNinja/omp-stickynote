import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("sticky notes and live office dashboard render correctly in the real OMP runtime", () => {
  // npm prepends the dev dependency's Bun-only CLI; exercise the installed host.
  const hostPath = process.env.PATH?.split(delimiter)
    .filter(entry => !entry.endsWith(join("node_modules", ".bin"))).join(delimiter);
  const result = spawnSync(process.env.OMP_BIN || "omp", [
    "--mode", "rpc", "--no-session", "--no-title", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp",
    "--trusted-extension", fileURLToPath(new URL("./fixtures/note-contract.ts", import.meta.url)),
  ], { input: "", encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: hostPath, PI_FORCE_IMAGE_PROTOCOL: "none" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
