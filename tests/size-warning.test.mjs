/** Size advice must use only the provided response and the documented hook envelope. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { sizeWarning } from "../scripts/size-warning.mjs";
test("threshold, missing responses and structured responses", () => {
  const start = performance.now();
  assert.equal(sizeWarning({ transcript_path: "must-not-be-read" }), null);
  assert.equal(sizeWarning({ tool_response: "x".repeat(80000) }), null);
  const out = sizeWarning({ tool_response: { content: "x".repeat(80001) } });
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /re-read on every later call/);
  assert.ok(performance.now() - start < 50);
});
test("bad input fails open and default hooks have short timeouts and size warning is opt-in", () => {
  for (const script of ["size-warning", "session-start"]) {
    const run = spawnSync(process.execPath, ["--no-warnings", `scripts/${script}.mjs`], { input: "{bad", encoding: "utf8" });
    assert.equal(run.status, 0); assert.equal(run.stdout, "");
  }
  const { hooks } = JSON.parse(fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  assert.equal(hooks.PreToolUse[0].matcher, "Edit|Write|NotebookEdit|MultiEdit");
  assert.equal(hooks.SessionStart[0].matcher, "compact|clear|resume");
  assert.equal(hooks.PostToolUse, undefined);
  for (const event of ["Stop", "PreToolUse", "SessionStart"]) {
    assert.ok(hooks[event][0].hooks[0].timeout <= (event === "Stop" ? 15 : 2));
  }
});
