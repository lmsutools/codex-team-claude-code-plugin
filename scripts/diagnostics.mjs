import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as S from "./store.mjs";
import { hash } from "./git.mjs";

const codexHome = () =>
  path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
export function readTail(file, limit = 65536, from = 0) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size,
      data = Buffer.alloc(Math.max(0, Math.min(size - from, limit)));
    fs.readSync(fd, data, 0, data.length, size - data.length);
    return data.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const redact = (text) =>
  String(text)
    .replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\/-]+)/gi, "[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
export function classifyFailure(text, {source = "stderr"} = {}) {
  // Tool output may be source code containing our own diagnostic fixtures.
  if (source === "command") {
    const ownError=String(text).trimStart().split(/\r?\n/,1)[0].slice(0,2048);
    if (!/^(?:(?:Error:|Error executing (?:command|tool):)\s*)?(?:helper_unknown_error:|(?:Windows )?sandbox(?:(?: error)?:|[^\r\n]{0,120}setup[^\r\n]{0,80}failed)|setup refresh had errors|runtime read\/execute validation failed)/i.test(ownError)) return null;
    text=ownError;
  }
  const ownAuth = source !== "command" && String(text).split(/\r?\n/).some(line => {
    // MCP and tool diagnostics share stderr with Codex when profiles are inherited.
    if (/\bmcp\b|mcp[_-]\w+|\btool(?:s|[_-]\w+)?\b|\bcommand(?:[_ -](?:output|execution))\b/i.test(line)) return false;
    if (/(?:refresh[ _-]?token[^\n]{0,100}(?:expired|revoked)|(?:expired|revoked)[^\n]{0,100}refresh[ _-]?token)|\bcodex login\b|not logged in/i.test(line)) return true;
    const unauthorized = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*[:=]?\s*401|status(?: code)?[ :=]*401|401 Unauthorized)\b/i.test(line);
    if (source === "event") return unauthorized || /login required/i.test(line);
    return unauthorized && /\bresponses\b|\bbackend(?:[\/ _-]api)?\b|unexpected status(?: code)?[ :=]*401/i.test(line);
  });
  if (ownAuth)
    return { kind: "auth_expired", category: "auth_expired", code: "auth_expired", message: "Codex authentication expired.", hint: "Run codex login, then explicitly resume the saved thread." };
  if (
    /setup refresh had errors|runtime read\/execute validation failed|helper_unknown_error[^\n]*setup|sandbox[^\n]{0,120}setup[^\n]{0,80}failed/i.test(
      text,
    )
  )
    return {
      category: "sandbox_setup",
      code: "sandbox_setup_failed",
      message:
        "Codex's sandbox could not initialize. Implementation is blocked by the runtime.",
    };
  return null;
}
export function versionHint(version, evidence) {
  return /\b0\.157\.\d+\b/.test(version || "") && /setup refresh had errors/i.test(JSON.stringify(evidence))
    ? "codex-cli 0.157.x setup refresh failed: pin a known-good CLI version through CODEX_TEAM_CODEX. Nothing was changed automatically." : null;
}
export function logFindings(text, cwd, source = null) {
  const findings = [],
    seen = new Set();
  const normalized = (value) =>
    value.replaceAll("\\\\", "\\").replaceAll("/", "\\").toLowerCase();
  const project = cwd && normalized(cwd).replace(/\\$/, "");
  // Newest first, so a repeated failure reports its latest occurrence.
  for (const line of text.split(/\r?\n/).reverse()) {
    // Summary arrays duplicate earlier errors and can conflate projects.
    if (line.includes("errors=[") || line.includes("completed with errors:"))
      continue;
    let kind;
    if (/runtime read\/execute validation failed/i.test(line))
      kind = "runtime_read_execute";
    else if (/write ACE (?:grant )?failed/i.test(line))
      kind = "project_write_acl";
    else if (/deny ACE failed/i.test(line) && /[\\/]\.git\b/i.test(line))
      kind = "git_protection_acl";
    if (!kind) continue;
    if (kind !== "runtime_read_execute" && project) {
      const at = normalized(line).indexOf(project);
      if (
        at < 0 ||
        !/^[\\:\s]?$/.test(
          normalized(line).slice(at + project.length, at + project.length + 1),
        )
      )
        continue;
    }
    const target = line.match(
      /runtime read\/execute access on (.*?): CreateFileW failed/i,
    )?.[1];
    const detail =
      kind === "runtime_read_execute"
        ? "Runtime read/execute validation failed."
        : kind === "project_write_acl"
          ? "Sandbox could not apply project write permissions."
          : "Sandbox could not protect the repository's .git directory.";
    const signature = kind + (target || project || "");
    if (seen.has(signature)) continue;
    seen.add(signature);
    findings.push({
      kind,
      detail,
      source,
      observedAt: line.match(/^\[([^\]]+)\]/)?.[1] || null,
      excerpt: redact(line).slice(0, 900),
      ...(target
        ? {
            path: target,
            pathLength: target.length,
            ...(target.length > 260
              ? {
                  hypothesis:
                    "Path length may contribute; CreateFileW failure alone does not prove this cause.",
                }
              : {}),
          }
        : {}),
      // "failed: 5" and "failed for D:\repo\.git: 5" both carry the Win32 code last.
      ...(/SetNamedSecurityInfoW failed\b.*:\s*5$|\berror\s*5\b/i.test(line.trim())
        ? { windowsError: 5 }
        : {}),
    });
    if (findings.length >= 12) break;
  }
  return findings.reverse();
}
function logFiles() {
  const directory = path.join(codexHome(), ".sandbox");
  try {
    return fs
      .readdirSync(directory)
      .filter((n) => /^sandbox(?:\.\d{4}-\d{2}-\d{2})?\.log$/.test(n))
      .map((n) => {
        const s = fs.statSync(path.join(directory, n));
        return { file: path.join(directory, n), mtime: s.mtimeMs, size: s.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}
// Keeps the first (newest) finding per kind and target across log files.
function unique(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const signature = f.kind + "\0" + (f.path || "");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}
/** Current sizes of the shared setup logs, taken just before a probe. */
export function logMarks() {
  return new Map(logFiles().map((e) => [e.file, e.size]));
}
/** Findings from log lines appended after `marks`: what this probe caused. */
export function logsSince(marks, cwd) {
  return unique(
    logFiles()
      .filter((e) => e.size > (marks.get(e.file) ?? 0))
      .flatMap((e) =>
        logFindings(readTail(e.file, 262144, marks.get(e.file) ?? 0), cwd, e.file),
      ),
  );
}
// .NET calls rather than Get-Acl/Test-Path, so the query needs no module loading.
const OWNER_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$items=@()",
  "foreach($p in @($env:CODEX_TEAM_OWNER_PATH,[IO.Path]::Combine($env:CODEX_TEAM_OWNER_PATH,'.git'))){",
  " $acl=$null",
  " if([IO.Directory]::Exists($p)){$acl=[IO.Directory]::GetAccessControl($p,'Owner')}",
  " elseif([IO.File]::Exists($p)){$acl=[IO.File]::GetAccessControl($p,'Owner')}",
  " if($acl){",
  "  $o=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;$n=$null",
  "  try{$n=[Security.Principal.SecurityIdentifier]::new($o).Translate([Security.Principal.NTAccount]).Value}catch{}",
  "  $items+=[pscustomobject]@{path=$p;owner=$o;ownerName=$n}}}",
  "[pscustomobject]@{user=$me;items=$items}|ConvertTo-Json -Compress -Depth 4",
].join("\n");
/**
 * Pure: turns the owner query into a finding. Codex's Windows sandbox adds
 * permissions to the project and .git, which needs ownership (WRITE_DAC);
 * Modify rights alone fail with error 5.
 */
export function ownershipReport(raw, cwd) {
  const items = [].concat(raw?.items || []).filter((i) => i?.owner);
  const checked = items.map((i) => ({
    path: i.path,
    ownerSid: i.owner,
    ownerAccount: i.ownerName || null,
    matchesCurrentUser: i.owner === raw.user,
  }));
  const foreign = checked.filter((i) => !i.matchesCurrentUser);
  const orphaned = foreign.some((i) => !i.ownerAccount);
  return {
    currentUserSid: raw?.user || null,
    checked,
    mismatch: foreign.length > 0,
    orphanedOwner: orphaned,
    ...(foreign.length
      ? {
          detail:
            `The project is owned by ${foreign[0].ownerAccount || foreign[0].ownerSid}` +
            (orphaned
              ? ", an account that no longer resolves on this machine (typically a previous Windows installation)"
              : "") +
            `, not the current user (${raw.user}). The sandbox cannot add its permissions without ownership.`,
          repair: {
            requiresAdministrator: true,
            command: `takeown /F "${cwd}" /R /D Y`,
            effect:
              "Makes the current user the owner of the project tree. Existing permissions are kept.",
          },
        }
      : {}),
  };
}
/** Windows only; null elsewhere or when the query fails. */
export function inspectOwnership(cwd) {
  if (process.platform !== "win32" || !cwd) return null;
  const shell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // A PowerShell 7 parent leaves its PSModulePath behind, which Windows
  // PowerShell 5.1 cannot load from; drop it so 5.1 uses its own defaults.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"),
  );
  const run = spawnSync(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", OWNER_SCRIPT],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1048576,
      env: { ...env, CODEX_TEAM_OWNER_PATH: cwd },
    },
  );
  try {
    return run.status === 0 ? ownershipReport(JSON.parse(run.stdout), cwd) : null;
  } catch {
    return null;
  }
}
const ACL_KINDS = new Set(["project_write_acl", "git_protection_acl"]);
const ownerCache = new Map();
/**
 * Checks ownership only when a project permission failure was logged. Repeated
 * failure events of one run reuse a result for a few seconds.
 */
export function ownershipFor(cwd, findings) {
  if (!cwd || !findings.some((f) => ACL_KINDS.has(f.kind))) return null;
  const hit = ownerCache.get(cwd);
  if (hit && Date.now() - hit.at < 5000) return hit.report;
  const report = inspectOwnership(cwd);
  ownerCache.set(cwd, { at: Date.now(), report });
  return report;
}
export function sandboxLogs(cwd) {
  const directory = path.join(codexHome(), ".sandbox");
  const findings = unique(
    logFiles()
      .slice(0, 3)
      .flatMap((e) => logFindings(readTail(e.file, 262144), cwd, e.file)),
  );
  const errorFile = path.join(directory, "setup_error.json");
  let lastSetupError = null;
  try {
    const e = JSON.parse(readTail(errorFile, 16384));
    lastSetupError = {
      code: redact(e.code).slice(0, 100),
      message: redact(e.message).slice(0, 500),
      modifiedAt: fs.statSync(errorFile).mtime.toISOString(),
      source: errorFile,
    };
  } catch {}
  return {
    historical: true,
    note: "Historical shared logs are supporting evidence, not a fresh test or proof that this project/runtime is currently broken.",
    findings,
    lastSetupError,
  };
}
function stamp(file) {
  try {
    const s = fs.statSync(file);
    return { file: fs.realpathSync(file), size: s.size, mtime: s.mtimeMs };
  } catch {
    return { file, missing: true };
  }
}
export function inspectRuntime(binary, cwd) {
  const run = (args) =>
    spawnSync(binary.command, [...binary.prefix, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1048576,
      cwd,
    });
  const version = run(["--version"]),
    auth = run(["login", "status"]),
    help = run(["exec", "--help"]);
  const configs = [
    path.join(codexHome(), "config.toml"),
    path.join(codexHome(), "requirements.toml"),
  ];
  if (cwd)
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      configs.push(path.join(dir, ".codex", "config.toml"));
      if (path.dirname(dir) === dir) break;
    }
  const identity = {
    binary,
    files: [binary.command, ...binary.prefix].map(stamp),
    version: (version.stdout || version.stderr || "").trim(),
    codexHome: codexHome(),
    configs: [...new Set(configs)]
      .filter((file) => fs.existsSync(file))
      .map((file) => ({
        hash: hash(readTail(file, 1048576)),
      })),
  };
  return {
    available: version.status === 0,
    version: identity.version,
    authenticated: auth.status === 0,
    structuredOutputSupported:
      help.stdout?.includes("--output-schema") || false,
    executable: binary.command,
    cliEntrypoint: binary.prefix[0] || binary.command,
    argumentsPrefix: binary.prefix,
    selection: process.env.CODEX_TEAM_CODEX
      ? "CODEX_TEAM_CODEX"
      : "automatic executable search",
    fingerprint: hash(JSON.stringify(identity)),
    node: process.version,
    stateDirectory: S.stateRoot(),
    auth:
      auth.status === 0
        ? "Existing Codex login is available."
        : "Run codex login; inspect its error locally.",
    scope: cwd || null,
  };
}
function table() {
  S.db().exec(
    "CREATE TABLE IF NOT EXISTS runtime_health (key TEXT PRIMARY KEY,data TEXT NOT NULL)",
  );
}
function healthKey(cwd, runtime) {
  return hash(S.key(cwd) + "\0" + runtime.fingerprint);
}
export function health(cwd, runtime) {
  table();
  const row = S.db()
    .prepare("SELECT data FROM runtime_health WHERE key=?")
    .get(healthKey(cwd, runtime));
  return row ? JSON.parse(row.data) : null;
}
function saveHealth(cwd, runtime, data) {
  table();
  S.db()
    .prepare(
      "INSERT INTO runtime_health(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
    )
    .run(healthKey(cwd, runtime), JSON.stringify(data));
  return data;
}
export function recordFailure(
  cwd,
  runtime,
  failure,
  readOnly = false,
  jobId = null,
) {
  // Contributor reports and command stdout are evidence for this job only.
  if (["command", "report"].includes(failure?.source)) return null;
  return S.transaction(() => {
    const prior = health(cwd, runtime);
    return saveHealth(cwd, runtime, {
      status: "blocked",
      at: S.now(),
      readOnly:
        prior?.status === "blocked" && prior.readOnly === false
          ? false
          : readOnly,
      jobId,
      failure,
    });
  });
}
export function recovery(cwd, jobId = null, diagnostics = null) {
  const owner = diagnostics?.ownership;
  return {
    automaticRetry: false,
    assignmentPreserved: true,
    steps: [
      ...(owner?.mismatch
        ? [
            `${owner.detail} With the owner's authorization, run in an administrator terminal: ${owner.repair.command}. Then probe.`,
          ]
        : []),
      "Inspect the recorded executable, CLI version and failure evidence before choosing a repair.",
      "For elevated setup failures, retry Codex's supported interactive sandbox setup in the affected project; Windows may require administrator approval.",
      "A downgrade is only a diagnostic option after user authorization, not a proven fix. Changing npm's CLI may not change the desktop/PATH-selected executable.",
      "After an authorized repair, call codex_doctor with the affected cwd and probe=true. A read-only success cannot clear a write-mode failure.",
      "When the probe succeeds, resume the latest blocked job with a NEW requestId; the saved assignment and exact thread, when available, are retained.",
    ],
    probe: { cwd, ...(jobId ? { jobId } : {}), probe: true },
    documentation: "https://learn.chatgpt.com/docs/windows/windows-sandbox",
    limits:
      "No automatic install/downgrade, ACL repair, privilege escalation, sandbox weakening, or Claude implementation takeover.",
  };
}
/**
 * `observed` holds findings from log lines this probe wrote; they are current
 * evidence, unlike the shared historical logs.
 */
export function failureRecord(
  message,
  { cwd, stage = "worker", historical = false, observed = null, target = cwd, source = "stderr" } = {},
) {
  const authentication = classifyFailure(message, {source});
  if (authentication?.kind === "auth_expired") return {
    ...authentication, source, stage, historical, evidence: redact(message).slice(-2000), diagnostics: {},
    recovery: { automaticRetry: false, assignmentPreserved: true, steps: [authentication.hint] },
  };
  const diagnostics = sandboxLogs(cwd);
  if (observed)
    diagnostics.probe = {
      historical: false,
      note: "Setup log lines written during this probe.",
      findings: observed,
    };
  // `target` is the folder the sandbox was granted: the worktree for isolated jobs.
  const ownership = ownershipFor(target, [...(observed || []), ...diagnostics.findings]);
  if (ownership) diagnostics.ownership = ownership;
  return {
    ...(classifyFailure(message, {source}) || {
      category: "runtime",
      code: "sandbox_probe_failed",
      message: "The bounded runtime check did not complete successfully.",
    }),
    stage,
    source,
    evidence: redact(message).slice(-2000),
    historical,
    diagnostics,
    recovery: recovery(cwd, null, diagnostics),
  };
}

// The probe executes only a nonce print through Codex's sandbox, never a model.
// Keep managed requirements in the profile resolution. Unsupported CLIs remain
// explicitly untested rather than silently selecting a weaker execution mode.
export function probeRuntime(
  binary,
  runtime,
  cwd,
  {
    readOnly = false,
    executionCwd = cwd,
    timeoutMs = 20000,
    force = false,
    jobId = null,
  } = {},
) {
  const cached = health(cwd, runtime);
  if (cached?.status === "blocked" && !force)
    return { ...cached, cached: true, probeExecuted: false };
  if (process.platform !== "win32")
    return {
      status: "untested",
      probeExecuted: false,
      reason: "This sandbox preflight is implemented for native Windows only.",
    };
  const help = spawnSync(
    binary.command,
    [...binary.prefix, "sandbox", "--help"],
    {
      cwd: executionCwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1048576,
    },
  );
  if (
    !help.stdout?.includes("--permission-profile") ||
    !help.stdout?.includes("--include-managed-config")
  )
    return cached?.status === "blocked"
      ? {
          ...cached,
          cached: true,
          probeExecuted: false,
          reason:
            "This CLI lacks the supported sandbox probe interface; existing failure retained.",
        }
      : {
          status: "untested",
          probeExecuted: false,
          reason:
            "CLI lacks the supported sandbox probe interface; no alternative sandbox mode was substituted.",
        };
  const nonce = "codex-team-probe-" + randomUUID();
  const args = [
    ...binary.prefix,
    "sandbox",
    "--permission-profile",
    readOnly ? ":read-only" : ":workspace",
    "--include-managed-config",
    "-c",
    'approval_policy="never"',
    "-C",
    executionCwd,
    "--",
    process.execPath,
    "-e",
    `process.stdout.write(${JSON.stringify(nonce)})`,
  ];
  const marks = logMarks();
  const checked = spawnSync(binary.command, args, {
    cwd: executionCwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: Math.min(20000, Math.max(1000, timeoutMs)),
    maxBuffer: 1048576,
  });
  const at = S.now();
  if (checked.status === 0 && checked.stdout?.includes(nonce)) {
    return S.transaction(() => {
      const latest = health(cwd, runtime);
      if (latest?.status === "blocked" && !latest.readOnly && readOnly)
        return {
          ...latest,
          probeExecuted: true,
          latestProbe: { status: "passed", at, readOnly },
          reason:
            "Read-only probe passed; the recorded workspace-write failure still requires a workspace-write probe.",
        };
      return saveHealth(cwd, runtime, {
        status: "passed",
        at,
        readOnly,
        probeExecuted: true,
        executionCwd,
        scope:
          "One command launched under the requested sandbox profile; not implementation or test acceptance.",
      });
    });
  }
  const failure = failureRecord(
    [checked.error?.message, checked.stderr, checked.stdout]
      .filter(Boolean)
      .join("\n") || "Sandbox probe returned no success marker.",
    {
      cwd,
      stage: "preflight",
      observed: logsSince(marks, executionCwd),
      target: executionCwd,
    },
  );
  if (checked.error?.code === "ETIMEDOUT") {
    failure.code = "sandbox_probe_timeout";
    failure.message = "Sandbox check exceeded its bounded timeout.";
  }
  failure.recovery = recovery(cwd, jobId, failure.diagnostics);
  return {
    ...recordFailure(cwd, runtime, failure, readOnly, jobId),
    probeExecuted: true,
  };
}
