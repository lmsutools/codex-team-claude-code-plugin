import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { fixture, rollout, sample, at } from "./observer-fixture.mjs";
import {
  codexJobs,
  formatShare,
  formatTokens,
  readTranscript,
  render,
  shouldShow,
  splitBar,
  subagentTranscripts,
  summarize,
  tokenSummary,
} from "../scripts/tokens.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-tokens-"));
const hook = fileURLToPath(new URL("../scripts/token-summary.mjs", import.meta.url));
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const line = (entry) => JSON.stringify(entry);
const prompt = (at, content, extra = {}) =>
  line({ type: "user", timestamp: at, message: { role: "user", content }, ...extra });
const toolResult = (at) =>
  line({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
// Claude Code writes one line per content block, each repeating the call's usage.
const call = (id, at, usage, blocks = 2) =>
  Array.from({ length: blocks }, () =>
    line({ type: "assistant", timestamp: at, requestId: "req_" + id, message: { id, role: "assistant", usage } }),
  );
const usage = (input, cacheRead, output, extra = {}) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
  output_tokens: output,
  ...extra,
});

function transcriptText() {
  return [
    prompt("2026-09-27T10:00:00Z", "Build it"),
    ...call("m1", "2026-09-27T10:00:01Z", usage(10, 1000, 100)),
    toolResult("2026-09-27T10:00:02Z"),
    ...call("m2", "2026-09-27T10:00:03Z", usage(5, 2000, 50)),
    prompt("2026-09-27T11:00:00Z", "<task-notification>done</task-notification>"),
    prompt("2026-09-27T11:00:00Z", [{ type: "text", text: "caveat" }], { isMeta: true }),
    ...call("m3", "2026-09-27T11:00:01Z", usage(1, 3000, 30, {
      cache_creation_input_tokens: 400,
      output_tokens_details: { thinking_tokens: 12 },
    })),
    toolResult("2026-09-27T11:00:02Z"),
    ...call("m4", "2026-09-27T11:00:03Z", usage(2, 3100, 20), 3),
  ].join("\n");
}

test("model calls count once, and tool results or meta entries never start a response", () => {
  const transcript = readTranscript(transcriptText());
  assert.equal(transcript.firstAt, "2026-09-27T10:00:00Z");
  assert.equal(transcript.calls.length, 4);
  assert.equal(transcript.replyFrom, 0);
  assert.equal(transcript.replyStartAt, "2026-09-27T10:00:00Z");
  assert.deepEqual(transcript.calls[2].usage, { input: 3401, cached: 3000, output: 30, reasoning: 12 });
});

test("the summary splits session and reply, including subagents by time and Codex by completion", () => {
  const transcript = readTranscript(transcriptText());
  const subagent = readTranscript([
    ...call("s1", "2026-09-27T10:30:00Z", usage(0, 500, 10)),
    ...call("s2", "2026-09-27T11:00:05Z", usage(0, 700, 20)),
  ].join("\n"));
  const hour = (h) => Date.parse(`2026-09-27T${h}:00:00Z`);
  const summary = summarize({
    transcript,
    subagents: [subagent],
    jobs: [
      { status: "accepted", startedAt: hour("09"), doneAt: hour("09"), usage: { input_tokens: 99 } }, // Explicitly attributed older job: session total only
      { status: "verified", startedAt: hour("10"), doneAt: hour("10") + 60000, usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 70, reasoning_output_tokens: 20 } },
      { status: "accepted", startedAt: hour("10"), doneAt: hour("11") + 60000, usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 30, reasoning_output_tokens: 5 } },
      { status: "running", startedAt: hour("11"), doneAt: null, usage: null },
    ],
  });
  assert.equal(summary.lead.session.calls, 6);
  assert.equal(summary.lead.reply.calls, 6);
  assert.equal(summary.lead.reply.input, 1010 + 2005 + 3401 + 3102 + 500 + 700);
  assert.equal(summary.contributor.sessionJobs, 4);
  assert.equal(summary.contributor.running, 1);
  assert.deepEqual(summary.contributor.session, { calls: 3, input: 1599, cached: 1300, output: 100, reasoning: 25 });
  assert.deepEqual(summary.contributor.reply, { calls: 2, input: 1500, cached: 1300, output: 100, reasoning: 25 });
});

test("the summary appears only after long responses in sessions that used Codex, unless configured", () => {
  const base = (calls, sessionJobs, replyRuns = 0, running = 0) => ({
    lead: { reply: { calls } },
    contributor: { sessionJobs, running, reply: { calls: replyRuns } },
  });
  assert.equal(shouldShow(base(8, 1)), true);
  assert.equal(shouldShow(base(7, 1)), false);
  assert.equal(shouldShow(base(1, 1, 1)), true);
  assert.equal(shouldShow(base(1, 1, 0, 1)), true);
  assert.equal(shouldShow(base(20, 0)), false);
  assert.equal(shouldShow(base(20, 0), { mode: "always" }), true);
  assert.equal(shouldShow(base(0, 0), { mode: "always" }), false);
  assert.equal(shouldShow(base(20, 3), { mode: "off" }), false);
  assert.equal(shouldShow(base(3, 1), { minCalls: 3 }), true);
});

test("the split bar keeps its width, half-cell precision, and never hides a nonzero share", () => {
  for (const [lead, contributor] of [[1, 0], [0, 1], [1, 1], [97, 3], [1, 999999], [999999, 1], [0, 0]]) {
    assert.equal(splitBar(lead, contributor, 30).length, 30);
  }
  assert.equal(splitBar(1, 1, 10), "█████░░░░░");
  assert.equal(splitBar(3, 1, 10), "███████▌░░");
  assert.equal(splitBar(1, 0, 4), "████");
  assert.equal(splitBar(999999, 1, 4), "███▌");
  assert.equal(splitBar(1, 999999, 4), "▌░░░");
  assert.equal(splitBar(0, 0, 3), "···");
});

test("numbers read at a glance and shares never claim 0% or 100% for a nonzero part", () => {
  assert.deepEqual(
    [999, 6878, 31234, 1050453, 12566561, 521000000, 2.5e9].map(formatTokens),
    ["999", "6.88k", "31.2k", "1.05M", "12.6M", "521M", "2.50B"],
  );
  assert.equal(formatShare(0, 10), "0%");
  assert.equal(formatShare(1, 1000), "<1%");
  assert.equal(formatShare(999, 1000), ">99%");
  assert.equal(formatShare(10, 10), "100%");
  assert.equal(formatShare(33, 100), "33%");
});

test("the rendered summary labels last-task output, code, consumption and session totals", () => {
  const summary = summarize({
    transcript: readTranscript(transcriptText()),
    jobs: [{ status: "accepted", startedAt: Date.parse("2026-09-27T10:00:00Z"), doneAt: Date.parse("2026-09-27T11:30:00Z"), usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } }],
  });
  const text = render(summary);
  const lines = text.split("\n");
  assert.match(lines[0], /^╭─ Last task · output .*lead 200 · Codex 300$/);
  assert.ok(lines.slice(1).every(l=>l.startsWith("│")));
  assert.match(lines[1], /Code: Codex/);
  assert.match(lines[2], /Consumption: lead 9.72k · Codex 5.30k/);
  assert.match(lines[3], /Re-reads: lead 9.10k · Codex 4.00k/);
  assert.match(lines[4], /Session: output lead 200 .*Codex 300/);
  assert.ok(lines.length<=14 && lines.every(l=>l.length<=110));
});

test("a session without Codex shows a zero contributor share and an explicit no-jobs note", () => {
  const text = render(summarize({ transcript: readTranscript(transcriptText()) }));
  assert.match(text, /No Codex jobs/);
  assert.match(text.split("\n")[0], /lead 200 · Codex 0$/);
  assert.doesNotMatch(text, /Codex wrote/);
});

test("Codex jobs are read from the plugin's store without changing it, matching this project or a subfolder", () => {
  const state = path.join(root, "state");
  fs.mkdirSync(state, { recursive: true });
  const db = new DatabaseSync(path.join(state, "state.sqlite"));
  db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,created TEXT NOT NULL,state TEXT NOT NULL)");
  const project = path.join(root, "Project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  const insert = db.prepare("INSERT INTO jobs VALUES(?,?,?,?)");
  const job = (id, cwd, extra) =>
    insert.run(id, process.platform === "win32" ? cwd.toLowerCase() : cwd, "2026-09-27T10:00:00Z",
      JSON.stringify({ jobId: id, status: "accepted", startedAt: "2026-09-27T10:00:00Z", finishedAt: "2026-09-27T12:00:00Z", ...extra }));
  job("11111111-1111-1111-1111-111111111111", project, { usage: { input_tokens: 10 } });
  job("22222222-2222-2222-2222-222222222222", path.join(root, "Other"), { usage: { input_tokens: 20 } });
  db.close();
  const reportDir = path.join(state, "11111111-1111-1111-1111-111111111111");
  fs.mkdirSync(reportDir);
  fs.writeFileSync(path.join(reportDir, "report.txt"), "{}");
  const doneAt = new Date("2026-09-27T11:15:00Z");
  fs.utimesSync(path.join(reportDir, "report.txt"), doneAt, doneAt);
  const before = fs.readFileSync(path.join(state, "state.sqlite"));

  const jobs = codexJobs(state, path.join(project, "src"));
  assert.deepEqual(jobs.map((j) => j.id), ["11111111-1111-1111-1111-111111111111"]);
  assert.equal(jobs[0].doneAt, Date.parse("2026-09-27T12:00:00Z")); // State completion wins over mutable report mtime.
  assert.deepEqual(codexJobs(path.join(root, "missing"), project), []);
  assert.deepEqual(fs.readFileSync(path.join(state, "state.sqlite")), before);
});

test("subagent transcripts are found next to the session transcript", () => {
  const dir = path.join(root, "projects");
  const sub = path.join(dir, "session-1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-a.jsonl"), "");
  fs.writeFileSync(path.join(sub, "agent-a.meta.json"), "{}");
  assert.deepEqual(subagentTranscripts(path.join(dir, "session-1.jsonl")), [path.join(sub, "agent-a.jsonl")]);
  assert.deepEqual(subagentTranscripts(path.join(dir, "none.jsonl")), []);
});

test("the Stop hook prints a systemMessage, honors off, and stays silent on bad input", () => {
  const transcriptPath = path.join(root, "hook-session.jsonl");
  fs.writeFileSync(transcriptPath, transcriptText());
  const env = { ...process.env, CODEX_TEAM_STATE: path.join(root, "empty-state") };
  const run = (input, extra = {}) =>
    spawnSync(process.execPath, ["--no-warnings", hook], { input, encoding: "utf8", env: { ...env, ...extra }, timeout: 15000 });
  const request = JSON.stringify({ transcript_path: transcriptPath, cwd: root, hook_event_name: "Stop" });

  const shown = run(request, { CODEX_TEAM_TOKENS: "always" });
  assert.equal(shown.status, 0);
  assert.match(JSON.parse(shown.stdout).systemMessage, /^╭─ Last task · output/);
  assert.equal(run(request, { CODEX_TEAM_TOKENS: "off" }).stdout, "");
  // No Codex in this session: the default mode stays quiet.
  assert.equal(run(request).stdout, "");
  const broken = run("{not json");
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, "");
  assert.equal(run(JSON.stringify({ transcript_path: path.join(root, "missing.jsonl") }), { CODEX_TEAM_TOKENS: "always" }).stdout, "");
  assert.equal(tokenSummary({}, { CODEX_TEAM_TOKENS: "always" }), null);
});

test("the plugin registers the hook for Stop", () => {
  const hooks = JSON.parse(fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const command = hooks.hooks.Stop[0].hooks[0].command;
  assert.match(command, /^node --no-warnings "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/token-summary\.mjs"$/);
});

test("live exec history includes reviewers exactly once in the last task", t => {
  const f = fixture(t);
  rollout(f.home, "implement", [sample(2, 100, 10), sample(5, 160, 20)]);
  rollout(f.home, "review", [sample(6, 50, 5)]);
  const a = { role: "implementation", attempt: 0, startedAt: at(1), threadId: "implement", freshThread: true };
  f.put({ execs: [a, a, { role: "reviewer", attempt: 0, startedAt: at(4), threadId: "review", freshThread: true }] });
  const transcript = readTranscript([prompt(at(0), "build"), prompt(at(4), "status")].join("\n"));
  const summary = summarize({ transcript, jobs: codexJobs(f.root, f.cwd), rolloutOptions: { home: f.home } });
  assert.equal(summary.contributor.session.input, 210);
  assert.equal(summary.contributor.reply.input, 210);
  assert.equal(summary.contributor.session.calls, 2);
  assert.match(render(summary), /rate window primary: 25% used \/ 300 min/);
  assert.match(render(summary), /Consumption:/);
});

test("lead edit alarm correlates successful results before usage deduplication", t => {
  const f = fixture(t); f.put();
  const tool = (id, name, file) => line({ type: "assistant", timestamp: at(2), message: { id: "same", usage: usage(10, 0, 1), content: [{ type: "tool_use", id, name, input: { file_path: file } }] } });
  const result = (id, error = false) => line({ type: "user", timestamp: at(3), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: error ? "denied" : "success" }] } });
  fs.writeFileSync(f.transcript, [prompt(at(0), "build"), tool("a", "Edit", "yes.ts"), tool("b", "Write", "denied.ts"), tool("c", "Write", "notes.md"), result("a"), result("b", true), result("c")].join("\n"));
  const text = tokenSummary({ transcript_path: f.transcript, cwd: f.cwd }, { CODEX_HOME: f.home }, f.root);
  assert.match(text, /Delegation alarm:.*yes.ts/); assert.doesNotMatch(text, /denied.ts|notes.md/);
  assert.equal(readTranscript(fs.readFileSync(f.transcript, "utf8")).calls.length, 1);
});

test("compaction resets largest-result meter and Stop handles a 30 MB transcript under 15 seconds", t => {
  const f = fixture(t);
  const text = [prompt(at(0), "build"), line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "old", content: "x".repeat(30 * 1024 * 1024) }] } }),
    line({ type: "system", subtype: "compact_boundary" }), ...call("new", at(5), usage(10, 20, 1)),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "current", content: "small" }] } })].join("\n");
  fs.writeFileSync(f.transcript, text);
  const start = performance.now();
  const out = tokenSummary({ transcript_path: f.transcript, cwd: f.cwd }, { CODEX_TEAM_TOKENS: "always", CODEX_HOME: f.home }, f.root);
  assert.ok(performance.now() - start < 15000);
  assert.equal(out, null); // A first-sight bounded tail cannot claim complete session totals.
});

test("a subagent count cap never presents partial session usage as complete", t => {
  const f = fixture(t), dir = path.join(f.transcript.replace(/\.jsonl$/, ""), "subagents");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 65; i++) fs.writeFileSync(path.join(dir, `agent-${i}.jsonl`), "");
  assert.equal(tokenSummary({ transcript_path: f.transcript, cwd: f.cwd }, { CODEX_TEAM_TOKENS: "always" }, f.root), null);
});

test("resumed live and finished execs replace usage without cross-process subtraction", t => {
  const f = fixture(t);
  rollout(f.home, "resumed", [sample(2, 5805867), sample(4, 174601), sample(6, 210000)]);
  const first = { role: "implementation", attempt: 0, startedAt: at(1), finishedAt: at(2), threadId: "resumed", usage: { input_tokens: 5805867 } };
  const revision = { role: "implementation", attempt: 1, startedAt: at(3), threadId: "resumed", rolloutBaseline: { input_tokens: 5805867 } };
  const transcript = readTranscript([prompt(at(0), "build"), prompt(at(5), "status")].join("\n"));
  f.put({ execs: [first, revision] });
  let summary = summarize({ transcript, jobs: codexJobs(f.root, f.cwd), rolloutOptions: { home: f.home } });
  assert.equal(summary.contributor.session.input, 6015867); assert.equal(summary.contributor.reply.input, 210000);
  f.put({ execs: [first, { ...revision, finishedAt: at(7), usage: { input_tokens: 220000 } }] });
  summary = summarize({ transcript, jobs: codexJobs(f.root, f.cwd), rolloutOptions: { home: f.home } });
  assert.equal(summary.contributor.session.input, 6025867); assert.equal(summary.contributor.reply.input, 220000);
  assert.ok(render(summary).includes(new Date(1790000000 * 1000).toLocaleString()));
});

test("alarm survives clear and stops classification after ten qualifying edits", async t => {
  const { successfulSourceEdits } = await import("../scripts/tokens.mjs");
  let classified = 0;
  successfulSourceEdits(Array(100).fill({ input: { path: "same.ts" } }), "fixture", null, () => { classified++; return "same.ts"; });
  assert.equal(classified, 10);
  const f = fixture(t), now = Date.now();
  const text = [prompt(new Date(now).toISOString(), "after clear"), line({ type: "assistant", timestamp: new Date(now).toISOString(), message: { content: [{ type: "tool_use", id: "edit", name: "Edit", input: { file_path: "memory.ts" } }] } }), line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "edit", content: "success" }] } })].join("\n");
  fs.writeFileSync(f.transcript, text);
  for (const state of [{ status: "running" }, { status: "accepted", finishedAt: new Date(now - 3600000).toISOString() }]) {
    f.put({ ...state, startedAt: new Date(now - 86400000).toISOString() });
    assert.match(tokenSummary({ cwd: f.cwd, transcript_path: f.transcript }, { CODEX_HOME: f.home }, f.root), /Delegation alarm:.*memory.ts/);
  }
});
