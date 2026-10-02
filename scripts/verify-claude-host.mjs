import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const plugin = fileURLToPath(new URL("../", import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-host-"));
const destination = path.resolve(process.argv[2]);
const cli = process.argv[3] || "claude";
const prompt =
  "This is a read-only plugin transport smoke test. Call the codex-team plugin's codex_profile tool exactly once with action=read and cwd=" +
  JSON.stringify(fixture) +
  ". Report its returned compatibleWith value. Do not run a worker, other tools, shell commands, code changes, or browser actions.";
const args = [
  "--print",
  "--plugin-dir",
  plugin,
  "--permission-mode",
  "dontAsk",
  "--tools",
  "",
  "--allowedTools",
  "mcp__plugin_codex-team_codex-worker__codex_profile",
  "--max-budget-usd",
  "0.50",
  "--no-session-persistence",
  "--output-format",
  "stream-json",
  "--verbose",
  prompt,
];
const child = spawn(cli, args, {
  cwd: fixture,
  windowsHide: true,
  env: { ...process.env, CODEX_TEAM_STATE: path.join(fixture, "state") },
});
let output = "",
  error = "";
child.stdout.on("data", (v) => (output += v));
child.stderr.on("data", (v) => (error += v));
const timer = setTimeout(() => child.kill(), 120000);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
clearTimeout(timer);
const events = output
  .split(/\r?\n/)
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const init = events.find((e) => e.type === "system" && e.subtype === "init");
const calls = events
  .flatMap((e) => e.message?.content || [])
  .filter((c) => c.type === "tool_use")
  .map((c) => ({ name: c.name, input: c.input }));
const responses = events
  .flatMap((e) => e.message?.content || [])
  .filter((c) => c.type === "tool_result");
const result = events.findLast((e) => e.type === "result");
const inventory = (init?.tools || []).filter(
  (t) => t.includes("codex-team") && t.includes("codex_"),
);
const evidence = {
  at: new Date().toISOString(),
  fixture,
  exitCode: code,
  pluginVersion: JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url)),
  ).version,
  inventory,
  calls,
  responses,
  result,
  stderr: error.slice(-4000),
  passed:
    code === 0 &&
    inventory.length === 14 &&
    calls.length === 1 &&
    calls[0].name.endsWith("codex_profile") &&
    responses.some((r) => JSON.stringify(r.content).includes("1.1.1")),
};
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + "\n");
console.log(
  JSON.stringify({
    passed: evidence.passed,
    inventory: inventory.length,
    calls: calls.map((c) => c.name),
    exitCode: code,
    evidence: destination,
  }),
);
if (!evidence.passed) process.exitCode = 1;
