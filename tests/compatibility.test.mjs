import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
test(
  "Windows full responses for legacy tools match the security-updated golden",
  { skip: process.platform !== "win32", timeout: 120000 },
  async () => {
    const harness = fileURLToPath(
      new URL("./compatibility-harness.mjs", import.meta.url),
    );
    const runtime = fileURLToPath(
      new URL("../scripts/runtime.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [harness, runtime], {
      windowsHide: true,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (v) => (stdout += v));
    child.stderr.on("data", (v) => (stderr += v));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, stderr);
    const golden = JSON.parse(
      fs.readFileSync(
        new URL("./legacy-v111.golden.json", import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(JSON.parse(stdout), golden);
  },
);
