import { trustedExecutable } from "./host-security.mjs";
/**
 * Job state for every project and session on this machine, in one SQLite
 * database shared by MCP servers (one per Claude session) and detached
 * workers (one per Codex run).
 *
 * Many sessions write at once, so:
 * - a write transaction holds the database-wide lock for milliseconds, never
 *   while hashing a project or running git (callers prepare that first);
 * - large, immutable snapshots are stored once in `blobs` and referenced from
 *   job rows written by 1.1.5 (storage 2), so heartbeats and progress notes
 *   rewrite about 20 KB instead of about 1 MB;
 * - a busy database makes a writer wait (CODEX_TEAM_DB_BUSY_MS, default 60 s),
 *   and workers treat progress writes as retryable, never as fatal.
 */
import fs from "node:fs";
import { encodeBoundary, decodeBoundary } from "./execution-boundary.mjs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { sanitize } from "./policy-core.mjs";
import { queueStateCard, flushStateCards, leadContext } from "./lead-state.mjs";
export const now = () => new Date().toISOString();
/** Job rows that keep snapshots in `blobs`. Older rows stay inline for 1.1.4 readers. */
export const STORAGE_VERSION = 2;
const positive = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const busyTimeoutMs = () =>
  positive(process.env.CODEX_TEAM_DB_BUSY_MS, 60000);
/** A start's reservation keeps the project while its process lives, at most this long. */
const RESERVATION_MS = 15 * 60 * 1000;
/** Transactions held longer than this are logged to lock-slow.log for diagnosis. */
const SLOW_LOCK_MS = 2000;
export const active = new Set(["starting", "running", "verifying"]);
export const stateRoot = () =>
  path.resolve(
    process.env.CODEX_TEAM_STATE ||
      path.join(os.homedir(), ".claude", "codex-team", "jobs"),
  );
export const key = (cwd) =>
  process.platform === "win32" ? cwd.toLowerCase() : cwd;
export function workspace(value) {
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw new Error("cwd must be an explicit absolute project directory.");
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory())
    throw new Error("cwd must be a directory.");
  return resolved;
}
export function jobDir(id) {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
  )
    throw new Error("Invalid job ID.");
  return path.join(stateRoot(), id);
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
const connections = new Map();
export function db() {
  const root = stateRoot();
  if (!connections.has(root)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const c = new DatabaseSync(path.join(root, "state.sqlite"));
    // The busy timeout comes first: switching to WAL can itself wait for a lock.
    // synchronous=NORMAL is crash-safe in WAL mode and avoids an fsync per commit.
    c.exec(
      `PRAGMA busy_timeout=${busyTimeoutMs()}; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=67108864; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,created TEXT NOT NULL,state TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jobs_cwd ON jobs(cwd,created); CREATE TABLE IF NOT EXISTS contexts(cwd TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY,data TEXT NOT NULL);`,
    );
    if (
      !c
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='extensions'",
        )
        .get()
    ) {
      if (c.prepare("SELECT COUNT(*) AS n FROM jobs").get().n) {
        const backup = path
          .join(root, "before-v112-" + Date.now() + ".sqlite")
          .replaceAll("'", "''");
        c.exec("VACUUM INTO '" + backup + "'");
      }
      c.exec(
        "CREATE TABLE IF NOT EXISTS extensions(kind TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,key));",
      );
    }
    connections.set(root, c);
  }
  return connections.get(root);
}
/** SQLITE_BUSY / SQLITE_LOCKED: another process holds the write lock. */
export const isBusy = (error) =>
  error?.errcode === 5 ||
  error?.errcode === 6 ||
  /database (?:table )?is (?:locked|busy)|SQLITE_BUSY/i.test(
    String(error?.message),
  );
/** Runs fn with a different busy timeout on this process's connection. */
export function withBusyTimeout(ms, fn) {
  const c = db();
  c.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(ms))}`);
  try {
    return fn();
  } finally {
    c.exec(`PRAGMA busy_timeout=${busyTimeoutMs()}`);
  }
}
const lockStats = { transactions: 0, maxHoldMs: 0, totalHoldMs: 0 };
/** Write-lock use in this process; tests assert slow work stays outside it. */
export const lockStatistics = () => ({ ...lockStats });
export function resetLockStatistics() {
  Object.assign(lockStats, { transactions: 0, maxHoldMs: 0, totalHoldMs: 0 });
}
function recordHold(ms, label, origin) {
  lockStats.transactions += 1;
  lockStats.totalHoldMs += ms;
  lockStats.maxHoldMs = Math.max(lockStats.maxHoldMs, ms);
  if (process.env.CODEX_TEAM_LOCK_TRACE === "1") {
    try { fs.appendFileSync(path.join(stateRoot(), "lock-trace.jsonl"), JSON.stringify({ pid: process.pid, ms, label }) + "\n"); } catch {}
  }
  if (ms < SLOW_LOCK_MS) return;
  try {
    const file = path.join(stateRoot(), "lock-slow.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024)
      fs.rmSync(file, { force: true });
    const caller = String(origin.stack).split("\n").slice(2, 4).join(" <")
      .replace(/\s+/g, " ");
    fs.appendFileSync(
      file,
      JSON.stringify({ at: now(), pid: process.pid, ms: Math.round(ms), label, caller }) + "\n",
      { mode: 0o600 },
    );
  } catch {}
}
/**
 * One write transaction. It holds the lock every session and worker shares,
 * so fn must only read and write the database: no hashing, git or processes.
 */
let transactionDepth = 0;
export function transaction(fn, label = "") {
  const c = db();
  const origin = new Error();
  c.exec("BEGIN IMMEDIATE");
  const at = performance.now();
  transactionDepth++;
  try {
    const result = fn();
    c.exec("COMMIT");
    return result;
  } catch (e) {
    c.exec("ROLLBACK");
    throw e;
  } finally {
    transactionDepth--;
    recordHold(performance.now() - at, label, origin);
  }
}

// ── Snapshot blobs ──
// Baselines are project snapshots (hundreds of KB, immutable once taken).
// Storage-2 rows reference them as {"$blob": "sha256:…"}; identical snapshots
// (baseline, attemptBaseline and originBaseline are often equal) share one blob.
const BLOB_KEYS = [
  "reviewBaseline",
  "baseline",
  "attemptBaseline",
  "originBaseline",
  "verificationBaseline",
  "policyBaseline",
  "baselineBytes",
  "attemptBytes",
  "verificationInputs",
  "hiddenBaseline",
  "verificationHidden",
];
const BLOB_MIN_CHARS = 2048;
const BLOB_ID = Symbol("codex-team.blob");
const isRef = (value) =>
  !!value &&
  typeof value === "object" &&
  typeof value.$blob === "string" &&
  Object.keys(value).length === 1;
/** Stores a snapshot's blob (no-op when stored) and returns its reference, or null when small. */
function storeBlob(value, force = false) {
  if (value[BLOB_ID]) return value[BLOB_ID];
  const text = JSON.stringify(value);
  if (!force && text.length < BLOB_MIN_CHARS) return null;
  const id = "sha256:" + createHash("sha256").update(text).digest("hex");
  db()
    .prepare("INSERT OR IGNORE INTO blobs(hash,data) VALUES(?,?)")
    .run(id, text);
  Object.defineProperty(value, BLOB_ID, { value: id });
  return id;
}
/** Persist large extension snapshots before entering a write transaction. */
export function blobReference(value) { return { $blob: storeBlob(value, true) }; }
/**
 * Stores a state's snapshots ahead of a transaction, so the transaction
 * itself writes only the small row. Returns the state unchanged.
 */
export function stageBlobs(state) {
  if (state?.storage !== STORAGE_VERSION) return state;
  for (const k of BLOB_KEYS)
    if (state[k] && typeof state[k] === "object" && !isRef(state[k]))
      storeBlob(state[k], k === "hiddenBaseline" || k === "verificationHidden");
  return state;
}
function dehydrate(state) {
  if (state.storage !== STORAGE_VERSION) return state;
  let stored = state;
  for (const k of BLOB_KEYS) {
    const value = state[k];
    if (!value || typeof value !== "object" || isRef(value)) continue;
    const id = storeBlob(value);
    if (!id) continue;
    if (stored === state) stored = { ...state };
    stored[k] = { $blob: id };
  }
  return stored;
}
function hydrate(state) {
  let full = state;
  const loaded = new Map();
  for (const k of BLOB_KEYS) {
    const value = state[k];
    if (!isRef(value)) continue;
    if (!loaded.has(value.$blob)) {
      const row = db()
        .prepare("SELECT data FROM blobs WHERE hash=?")
        .get(value.$blob);
      if (!row)
        throw new Error(`Job ${state.jobId} is missing its stored ${k}.`);
      const parsed = JSON.parse(row.data);
      Object.defineProperty(parsed, BLOB_ID, { value: value.$blob });
      loaded.set(value.$blob, parsed);
    }
    if (full === state) full = { ...state };
    full[k] = loaded.get(value.$blob);
  }
  return full;
}
export function save(state) {
  const previousCardState = db().prepare("SELECT json_extract(state, '$.status') AS status, json_extract(state, '$.livePhase') AS phase FROM jobs WHERE id=?").get(state.jobId);
  if (state.contextAtStart) state = { ...state, contextAtStart: leadContext(state.contextAtStart) };
  if (state.handbookAtStart) {
    const { hash, version } = state.handbookAtStart;
    state = { ...state, handbookAtStart: { hash, version } };
  }
  if (state.profile) {
    const contentKeys = [
      "prompt",
      "assignment",
      "contextAtStart",
      "contextPacks",
      "handbookAtStart",
      "reviews",
      "progress",
      "error",
      "lastDiagnostic",
      "cliFailure",
      "lastCommand",
      "result",
      "reviewer",
      "autoVerifySkipped",
      "verification",
      "policyFindings",
      "secretFindings",
      "delivery",
      "runtimeFailure",
      "preflight",
      "diagnostics",
      "errorLogTail",
    ];
    const content = Object.fromEntries(
      contentKeys.filter((k) => k in state).map((k) => [k, state[k]]),
    );
    state = { ...state, ...sanitize(content, state.profile) };
    if (state.decisionPacket) {
      // Binding values are plugin-generated metadata, never secret-scanned model text.
      const { assignmentHash, fingerprint, ...packetContent } = state.decisionPacket;
      state = { ...state, decisionPacket: { ...sanitize(packetContent, state.profile), assignmentHash, fingerprint } };
    }
  }
  db()
    .prepare(
      "INSERT INTO jobs(id,cwd,created,state) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
    )
    .run(
      state.jobId,
      key(state.cwd),
      state.startedAt,
      JSON.stringify(encodeBoundary(dehydrate(state))),
    );
  try { if (!previousCardState || previousCardState.status !== state.status || previousCardState.phase !== (state.livePhase ?? null)) queueStateCard(db(), key(state.cwd)); } catch { /* Optional recovery card cannot fail a job write. */ }
  return state;
}
/** Removes a job row (a start that failed before launch leaves no record). */
export function remove(id) {
  jobDir(id);
  const cwd = db().prepare("SELECT cwd FROM jobs WHERE id=?").get(id)?.cwd;
  db().prepare("DELETE FROM jobs WHERE id=?").run(id);
  try { if (cwd) queueStateCard(db(), cwd); } catch {}
}
export function extension(kind, key) {
  const row = db()
    .prepare("SELECT data FROM extensions WHERE kind=? AND key=?")
    .get(kind, key);
  return row ? JSON.parse(row.data) : null;
}
export function setExtension(kind, key, value) {
  db()
    .prepare(
      "INSERT INTO extensions(kind,key,data) VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET data=excluded.data",
    )
    .run(kind, key, JSON.stringify(value));
  return value;
}
export function extensions(kind) {
  return db()
    .prepare("SELECT key,data FROM extensions WHERE kind=?")
    .all(kind)
    .map((r) => ({ key: r.key, ...JSON.parse(r.data) }));
}
/** The stored row: snapshots of storage-2 jobs are still {"$blob"} references. */
export function readRaw(id) {
  jobDir(id);
  const row = db().prepare("SELECT state FROM jobs WHERE id=?").get(id);
  if (row) return decodeBoundary(JSON.parse(row.state));
  const file = path.join(jobDir(id), "job.json");
  if (!fs.existsSync(file)) throw new Error("Unknown job ID.");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  if (old.jobId !== id) throw new Error("Legacy job ID mismatch.");
  return old;
}
/** The job with its snapshots; `blobs: false` skips them for status and listing. */
export function read(id, { blobs = true } = {}) {
  const state = readRaw(id);
  return blobs ? hydrate(state) : state;
}
function processIdentity(pid) {
  let command;
  if (process.platform === "linux") {
    try {
      command = fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .replaceAll("\0", " ");
    } catch {
      return null;
    }
  } else {
    const result =
      process.platform === "win32"
        ? spawnSync(
            trustedExecutable("powershell.exe"),
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object CommandLine,@{Name='startedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`,
            ],
            { encoding: "utf8", windowsHide: true, timeout: 5000 },
          )
        : spawnSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: 5000,
          });
    if (result.status !== 0) return null;
    if (process.platform === "win32") {
      try {
        const identity = JSON.parse(result.stdout);
        return identity?.CommandLine?.trim()
          ? {
              command: identity.CommandLine,
              startedAt: Date.parse(identity.startedAt),
            }
          : null;
      } catch {
        return null;
      }
    }
    command = result.stdout;
  }
  return command?.trim() ? { command } : null;
}
export function supervisorStillOwned(state, inspect = processIdentity) {
  if (!alive(state.supervisorPid)) return false;
  const identity = transactionDepth ? null : inspect(state.supervisorPid);
  if (!identity) return alive(state.supervisorPid);
  return identity.command.includes(state.jobId) && /(?:^|[\\/])supervisor\.mjs(?:["\s]|$)/.test(identity.command);
}
function workerStillOwned(state) {
  if (supervisorStillOwned(state)) return true;
  if (!alive(state.workerPid)) return false;
  const identity = processIdentity(state.workerPid);
  if (!identity) return alive(state.workerPid); // Unknown identity keeps the lock.
  return (
    identity.command.includes(state.jobId) &&
    /--(?:worker|verify)\b/.test(identity.command)
  );
}
function childStillOwned(state) {
  if (!alive(state.codexPid)) return false;
  const identity = processIdentity(state.codexPid);
  if (!identity) return alive(state.codexPid);
  const startedAt = state.childStartedAt;
  if (
    startedAt &&
    Number.isFinite(identity.startedAt) &&
    Math.abs(identity.startedAt - Date.parse(startedAt)) > 2000
  )
    return false;
  if (
    state.childRole === "verification" ||
    state.status === "verifying" ||
    state.interruptedFromStatus === "verifying"
  )
    return true;
  return (
    identity.command.includes(state.jobId) &&
    identity.command.includes("--output-last-message")
  );
}
/** A start holds its project with a reservation until its full record is saved. */
function reservationOwned(state) {
  if (fs.existsSync(path.join(jobDir(state.jobId), "launch-failed.json"))) return false;
  const reservation = state.reservation;
  return (
    alive(reservation?.pid) &&
    Date.now() - Date.parse(reservation.at) < RESERVATION_MS
  );
}
export function recover(state) {
  if (active.has(state.status) && state.reservation) {
    if (reservationOwned(state)) return state;
    if (state.recoveryPhase)
      return save({
        ...state,
        status: "interrupted",
        livePhase: null,
        reservation: null,
        finishedAt: now(),
        error: "The automatic-resume supervisor exited. Inspect the saved thread and logs before resuming.",
        orphanProcessAlive: alive(state.codexPid),
      });
    return save({
      ...state,
      status: "failed",
      livePhase: null,
      reservation: null,
      finishedAt: now(),
      error:
        "The start stopped before Codex was launched. Start again with a new requestId.",
    });
  }
  if (
    active.has(state.status) &&
    Date.now() -
      Date.parse(state.heartbeatAt || state.updatedAt || state.startedAt) >
      15000 &&
    (state.status === "verifying" && !alive(state.workerPid) || !workerStillOwned(state))
  )
    return save({
      ...state,
      status: state.status === "verifying" ? "verification_failed" : "interrupted",
      livePhase: null,
      interruptedFromStatus: state.status,
      finishedAt: now(),
      error:
        "Worker exited without a final result. Logs and thread are retained. Stop any orphaned live Codex process before retrying.",
      orphanProcessAlive: childStillOwned(state),
      ...readWorkerFault(state.jobId),
    });
  return state;
}
function readWorkerFault(id) {
  try {
    const file = path.join(jobDir(id), "worker-fault.json");
    if (fs.statSync(file).size > 4096) return {};
    return { workerFault: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return {};
  }
}
export function scoped(id, cwd, options) {
  const state = read(id, options);
  if (key(state.cwd) !== key(cwd))
    throw new Error("Job belongs to a different project directory.");
  return state;
}
/** Merges changes into the stored row; snapshots stay references, so this stays small. */
export function patch(id, changes) {
  return transaction(
    () => save({ ...readRaw(id), ...changes, updatedAt: now() }),
    "patch",
  );
}
export function heartbeat(id) {
  // Content was scanned when persisted. Only these generated timestamps change;
  // do not repeatedly execute custom regexes over unchanged job content.
  return transaction(() => {
    const state = readRaw(id),
      at = now();
    if (!active.has(state.status)) return state;
    const updated = { ...state, heartbeatAt: at, updatedAt: at };
    db()
      .prepare("UPDATE jobs SET state=? WHERE id=?")
      .run(JSON.stringify(encodeBoundary(updated)), id);
    return updated;
  }, "heartbeat");
}
const legacyScanned = new Set();
/** A project's jobs, newest first, without their snapshots. */
export function projectJobs(cwd) {
  // Pre-SQLite job.json folders are imported once per process and project,
  // not on every call: the state root grows with every job ever run.
  const scanKey = stateRoot() + "\0" + key(cwd);
  if (!legacyScanned.has(scanKey)) {
    for (const e of fs.readdirSync(stateRoot(), { withFileTypes: true })) {
      if (
        !e.isDirectory() ||
        !/^[0-9a-f-]{36}$/.test(e.name) ||
        db().prepare("SELECT 1 FROM jobs WHERE id=?").get(e.name)
      )
        continue;
      try {
        const state = readRaw(e.name);
        if (key(state.cwd) === key(cwd)) save(state);
      } catch {}
    }
    legacyScanned.add(scanKey);
  }
  return db()
    .prepare("SELECT state FROM jobs WHERE cwd=? ORDER BY created DESC")
    .all(key(cwd))
    .map((r) => recover(decodeBoundary(JSON.parse(r.state))));
}
export function withProjectOperation(cwd, fn) {
  const leaseKey=key(cwd), previous=extension("operation-lease",leaseKey);
  transaction(()=>{
    const held=extension("operation-lease",leaseKey);
    if(held && held.pid!==process.pid && alive(held.pid)) throw Error("Project operation is already running.");
    setExtension("operation-lease",leaseKey,{pid:process.pid,at:now()});
  });
  try{return fn();}finally{transaction(()=>setExtension("operation-lease",leaseKey,previous?.pid===process.pid?previous:null));}
}
export function assertIdle(cwd, exceptId) {
  const lease=extension("operation-lease",key(cwd));
  if(lease && lease.pid!==process.pid && alive(lease.pid)) throw Error("Project operation is already running.");
  for (const job of projectJobs(cwd)) {
    if (job.jobId === exceptId) continue;
    if (active.has(job.status))
      throw new Error(
        `Project already has active job ${job.jobId}. Poll or cancel it first.`,
      );
    if (
      (job.status === "interrupted" || job.cancellationError) &&
      childStillOwned(job)
    )
      throw new Error(
        `Stopped job ${job.jobId} still has a live Codex process; inspect it before retrying.`,
      );
  }
}
export function closeStores() {
  for (const c of connections.values()) { flushStateCards(c); c.close(); }
  connections.clear();
  legacyScanned.clear();
}
