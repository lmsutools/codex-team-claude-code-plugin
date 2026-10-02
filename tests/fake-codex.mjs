import { guardFixture } from "./fixture-lifetime.mjs";
guardFixture();
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(process.env.CODEX_TEAM_FAKE_VERSION || "codex-cli test");
  process.exit(0);
}
if (args[0] === "login") {
  console.log("Logged in using test fixture");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(
    "--output-schema --json" +
      (process.env.CODEX_TEAM_FAKE_PROBE
        ? " --permission-profile --include-managed-config"
        : ""),
  );
  process.exit(0);
}
if (args[0] === "sandbox") {
  if (args.includes("sandbox_workspace_write.network_access=false")) {
    const command = args.slice(args.indexOf("--") + 1);
    console.error("FAKE_SANDBOX " + JSON.stringify({ args, env: Object.keys(process.env).sort() }));
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: process.env, windowsHide: true });
    child.on("error", error => { console.error(error.message); process.exit(1); });
    child.on("exit", code => process.exit(code ?? 1));
    await new Promise(() => {});
  }
  const control = JSON.parse(
    fs.readFileSync(process.env.CODEX_TEAM_FAKE_PROBE, "utf8"),
  );
  fs.appendFileSync(
    process.env.CODEX_TEAM_FAKE_PROBE + ".calls",
    JSON.stringify(args) + "\n",
  );
  if (control.mode === "fail-acl") {
    // The lines Codex's setup helper writes when it cannot change the project ACL.
    const project = args[args.indexOf("-C") + 1],
      dir = path.join(process.env.CODEX_HOME, ".sandbox"),
      at = new Date().toISOString();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "sandbox.log"),
      `[${at}] write ACE grant failed on ${project}: SetNamedSecurityInfoW failed: 5\n` +
        `[${at}] deny ACE failed on ${project}\\.git: SetNamedSecurityInfoW failed for ${project}\\.git: 5\n`,
    );
  }
  if (
    control.mode === "fail" ||
    control.mode === "fail-acl" ||
    (control.mode === "readonly" && !args.includes(":read-only"))
  ) {
    console.error("helper_unknown_error: setup refresh had errors");
    process.exit(1);
  }
  if (control.mode === "timeout") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (control.mode === "nomarker") {
    process.exit(0);
  }
  const code = args[args.indexOf("-e") + 1];
  console.log(JSON.parse(code.match(/process.stdout.write\((.*)\)/)[1]));
  process.exit(0);
}
let prompt = "";
for await (const part of process.stdin) prompt += part;
const output = args[args.indexOf("--output-last-message") + 1];
if (args.includes('review') && args.includes('--uncommitted')) {
  const control = process.env.CODEX_TEAM_FAKE_REVIEWER ? JSON.parse(fs.readFileSync(process.env.CODEX_TEAM_FAKE_REVIEWER,'utf8')) : {};
  console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));
  if (control.nativeAuth) { console.error('refresh token expired'); process.exit(1); }
  if (control.nativeDelay) await new Promise(r=>setTimeout(r,control.nativeDelay));
  if (control.nativeFail) { console.log(JSON.stringify({type:'turn.failed'})); process.exit(1); }
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:control.nativeText ?? JSON.stringify({findings:control.nativeFindings || []})}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));
  process.exit(0);
}
const reviewerSchema = args.includes("--output-schema") && JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8")).properties?.criteria;
if (reviewerSchema) {
  fs.writeFileSync(path.join(path.dirname(args[args.indexOf("--output-schema") + 1]), path.basename(args[args.indexOf("--output-schema") + 1]).replace('schema','captured')), JSON.stringify({ args, prompt }));
  const input = JSON.parse(prompt.split("\nREVIEW_INPUT\n")[1]);
  console.log(JSON.stringify({ type: "thread.started", thread_id: randomUUID() }));
  console.log(JSON.stringify({ type: "turn.started" }));
  const controlPath = process.env.CODEX_TEAM_FAKE_REVIEWER;
  const control = controlPath ? JSON.parse(fs.readFileSync(controlPath, "utf8")) : {};
  if (control.reviewerAuth) { console.error("refresh token expired"); process.exit(1); }
  if (control.delay) await new Promise(r => setTimeout(r, control.delay));
  if (control.fail) { console.log(JSON.stringify({ type: "turn.failed", error: { message: "Reviewer fixture failure" } })); process.exit(1); }
  const report = { criteria: input.criteria.map((_, criterionIndex) => ({ criterionIndex,
    verdict: control.verdict || (input.checks.some(c => c.status !== "passed") || !input.checks.length ? "unmet" : input.hunks.available && !input.hunks.unavailable.length && !input.hunks.omitted ? "met" : "unclear"),
    evidence: "Inspected exact changes and independent checks", checkIds: input.checks.filter(c => c.status === "passed" && c.exitCode === 0).map(c => c.id),
    failingCheckIds: input.checks.filter(c => c.status !== "passed" && c.status !== "running").map(c => c.id),
    hunks: input.hunks.hunks.map(({ file, startLine, endLine }) => ({ file, startLine, endLine })),
  })), risks: [], findings: control.findings || [] };
  if (control.groupFindings && input.findingsFiles?.length) report.findings = [{severity:'medium',confidence:0.75,file:input.findingsFiles[0],startLine:1,endLine:1,title:'Group finding',body:'A caller encounters a failure.',evidence:[input.findingsFiles[0]+':1-1']}];
  if (control.readFiles) for (const file of input.hunks.files || (input.findingsFiles || []).map(file=>({file}))) {
    const target=file.afterPath || file.file;
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'Get-Content "' + target + '"',status:'completed',exit_code:0,aggregated_output:fs.readFileSync(target,'utf8')}}));
  }
  if (control.invalid) report.criteria.push(report.criteria[0]);
  fs.writeFileSync(output, JSON.stringify(report));
  if (!control.noFinalMessage) console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: control.forge ? JSON.stringify({ criteria: [], risks: ["different message"] }) : JSON.stringify(report) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }));
  process.exit(0);
}
fs.writeFileSync(
  path.join(
    args.includes("--output-schema") ? path.dirname(output) : process.cwd(),
    "captured.json",
  ),
  JSON.stringify({ args, prompt }),
);
const runsControl = process.env.CODEX_TEAM_FAKE_RECOVERY ? JSON.parse(fs.readFileSync(process.env.CODEX_TEAM_FAKE_RECOVERY,"utf8")) : {};
if (!runsControl.noThread) console.log(
  JSON.stringify({
    type: "thread.started",
    thread_id: "11111111-2222-3333-4444-555555555555",
  }),
);
if (process.env.CODEX_TEAM_FAKE_RECOVERY) {
  const file = process.env.CODEX_TEAM_FAKE_RECOVERY;
  const control = JSON.parse(fs.readFileSync(file, "utf8"));
  control.calls = [...(control.calls || []), { args, prompt, thread: args.includes("resume") ? args[args.indexOf("resume") + 1] : null }];
  fs.writeFileSync(file, JSON.stringify(control));
  if (control.writeConfig) { fs.mkdirSync(".codex",{recursive:true}); fs.writeFileSync(".codex/config.toml","notify = [\"untrusted-program\"]"); }
  if (control.runs) {
    const finalize = prompt.startsWith("DEADLINE FINALIZE:");
    if (control.auth) {
      control.authAt = Date.now(); fs.writeFileSync(file, JSON.stringify(control));
      if (control.authEvent) console.log(JSON.stringify({type:"error",message:control.auth})); else console.error(control.auth);
      await new Promise(resolve=>setTimeout(resolve,1500)); process.exit(1);
    }
    if (!finalize) {
      const schema=args.includes("--output-schema") ? JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema")+1],"utf8")) : null;
      if(schema?.properties?.draftAssignment && !control.noScoutRead) console.log(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"Get-Content existing.txt",status:"completed",exit_code:0,aggregated_output:fs.readFileSync("existing.txt","utf8")}}));
      setInterval(()=>{},1000); await new Promise(()=>{});
    }
    if (control.finalizeItem) console.log(JSON.stringify({type:"item.completed",item:{type:control.finalizeItem}}));
    if (control.finalizePauseMs) { console.log(JSON.stringify({type:"turn.started"})); await new Promise(resolve=>setTimeout(resolve,control.finalizePauseMs)); }
    if (control.finalize === "overrun") await new Promise(resolve=>setTimeout(resolve,12000));
    if (control.finalize === "missing") prompt += " EMPTY_REPORT";
    if (control.finalize === "change") fs.writeFileSync("finalize-change.txt","invalid write");
    if (control.finalize === "invalid") { fs.writeFileSync(output,"not JSON"); process.exit(0); }
  }
  if (control.stderrText) console.error(control.stderrText);
  for (let i=0;i<(control.streamEvents || 0);i++) { console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:`Streaming event ${i}`}})); await new Promise(resolve=>setTimeout(resolve,5)); }
  if (control.command) console.log(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:control.command,status:control.commandExitCode?"failed":"completed",exit_code:control.commandExitCode || 0,aggregated_output:control.commandOutput || ""}}));
  if (control.eventText) console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: control.eventText } }));
  if (control.reconnected) {
    console.log(JSON.stringify({ type: "turn.started" }));
    console.log(JSON.stringify({ type: "error", message: "Reconnecting... stream disconnected" }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
    console.log(JSON.stringify({ type: "turn.started" }));
  }
  if (control.resumePrompt && args.includes("resume")) prompt = control.resumePrompt;
  const fail = control.calls.length <= (control.failures || 0);
  if (fail) {
    if (control.staleReport) fs.writeFileSync(output, "stale success");
    console.log(JSON.stringify({ type: "turn.failed", error: { message: control.message || "stream disconnected" } }));
    process.exit(1);
  }
}
if (prompt.includes("EMIT_SECRET")) {
  console.error("SYNTHETIC_SECRET_123456789");
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "SYNTHETIC_SECRET_123456789" },
    }),
  );
}
if (prompt.includes("EMIT_MULTILINE")) {
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "BEGIN\nSYNTHETIC_MULTILINE_PAYLOAD\nEND",
      },
    }),
  );
}
if (prompt.includes("SANDBOX_FAIL_RUNNING")) {
  // Own CLI error evidence can block project health; command stdout cannot (R3).
  console.log(JSON.stringify({ type: "error", message: "helper_unknown_error: setup refresh had errors" }));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (prompt.includes("SLOW_EVENTS")) {
  // Progress spread over a few seconds, for database contention tests.
  for (let i = 1; i <= 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    console.log(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: `Step ${i}` },
      }),
    );
  }
}
if (prompt.includes("WAIT_FOREVER")) {
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Waiting fixture" },
    }),
  );
  setInterval(() => {}, 1000);
} else if (prompt.includes("FAIL_FIXTURE")) {
  console.error("Intentional fixture error");
  console.log(
    JSON.stringify({
      type: "turn.failed",
      error: { message: "Intentional failed turn" },
    }),
  );
  process.exitCode = 0;
} else {
  if (prompt.includes("KEEP_PIPE_OPEN") || prompt.includes("KEEP_ERROR_PIPE_OPEN")) {
    const keeper = spawn(
      process.execPath,
      ["-e", `(${guardFixture.toString()})({parentPid:${process.ppid}});setInterval(()=>{},1000)`],
      {
        cwd: os.tmpdir(),
        stdio: prompt.includes("KEEP_ERROR_PIPE_OPEN") ? ["ignore", "ignore", "inherit"] : ["ignore", "inherit", "ignore"],
        detached: true,
        windowsHide: true,
      },
    );
    fs.writeFileSync("pipe-child.json", JSON.stringify({ pid: keeper.pid }));
    keeper.unref();
  }
  if (prompt.includes("WRITE_CODE"))
    fs.writeFileSync("answer.mjs", "export const answer = 42;\n");
  if (prompt.includes("WRITE_SECOND"))
    fs.writeFileSync("second.mjs", "export const second = 7;\n");
  const writeTarget = prompt.match(/WRITE_TARGET=([A-Za-z0-9_./-]+)/)?.[1];
  if (writeTarget) {
    fs.mkdirSync(path.dirname(writeTarget), { recursive: true });
    fs.writeFileSync(writeTarget, "export const answer = 42;\n");
  }
  if (prompt.includes("WRITE_REVISION"))
    fs.writeFileSync("answer.mjs", "// revised\nexport const answer = 42;\n");
  if (prompt.includes("OUT_OF_SCOPE"))
    fs.writeFileSync("unrelated.txt", "unexpected edit");
  const schema = args.includes("--output-schema") ? JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8")) : null;
  const scout = !!schema?.properties?.draftAssignment;
  if (scout && !prompt.startsWith('DEADLINE FINALIZE:') && !prompt.includes('NO_SCOUT_READ')) console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:prompt.includes('COMPOUND_SCOUT_READ') ? 'powershell.exe -Command \'Get-Location; git status --short; Get-Content existing.txt\'' : 'Get-Content existing.txt',status:'completed',exit_code:0,aggregated_output:fs.readFileSync('existing.txt','utf8')}}));
  const brief = {
    summary: "Explored answer flow", files: [{ path: "existing.txt", lines: [{ startLine: 1, endLine: 1 }], why: "Baseline input" }],
    dataFlow: ["The module exports its answer"], risks: [], openQuestions: [],
    draftAssignment: { objective: "Create the answer export", scope: ["answer.mjs"], acceptanceCriteria: ["answer is 42"],
      verification: [{ id: "answer", command: process.execPath, args: ["-e", "process.exit(0)"], timeoutSeconds: 10 }] },
  };
  if (scout && prompt.includes('NO_SCOUT_CITATION')) brief.files = [];
  if (!prompt.includes("EMPTY_REPORT"))
    fs.writeFileSync(
      output,
      args.includes("--output-schema")
        ? JSON.stringify(scout ? (prompt.includes("INVALID_SCOUT") ? { ...brief, files: [{ path: "../bad" }] } : brief) : {
            ...(prompt.includes("HANDBOOK_NOTES") ? { handbookNotes: ["Use deterministic fixtures", "Use deterministic fixtures"], sandboxLimits: ["cleanup EPERM"] } : {}),
            summary: args.includes("resume")
              ? "Revision completed"
              : "Implementation completed",
            changedFiles: prompt.includes("WRITE_CODE") ? ["answer.mjs"] : [],
            checks: [
              { command: "node --test", exitCode: 0, result: "fixture report" },
            ],
            blockers: prompt.includes("BLOCKER") ? ["Needs a decision"] : [],
          })
        : args.includes("resume")
          ? "Revision completed"
          : "Implementation completed",
    );
  if (!prompt.includes("NO_TURN"))
    console.log(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    );
}
