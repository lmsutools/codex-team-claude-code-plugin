/** Bounded, read-only observations for interactive hooks; never opens the writable store. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeBoundary } from "./execution-boundary.mjs";
export const fold = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
export function within(parent, child) {
  const rel = path.relative(fold(parent), fold(child));
  return !rel || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}
export function gitRoot(cwd) {
  let dir = fs.realpathSync.native(cwd);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
export function readBounded(file, limit = 1024 * 1024, tail = false) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = tail ? Math.max(0, size - limit) : 0;
    const buffer = Buffer.alloc(Math.min(size, limit));
    const length = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, length).toString("utf8");
    return { text: start ? text.slice(text.indexOf("\n") + 1) : text, truncated: size > limit };
  } finally { fs.closeSync(fd); }
}
export function observe(root, fn) {
  if (!fs.existsSync(path.join(root, "state.sqlite"))) return null;
  const db = new DatabaseSync(path.join(root, "state.sqlite"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout=0"); return fn(db); }
  finally { db.close(); }
}
// Project filtering and row limits precede JSON extraction. Large legacy inline
// baselines never cross the SQLite/JS boundary. Multipath extraction parses once.
const fields = {
  guard: ["status", "startedAt", "modelChildStartedAt", "finishedAt"],
  card: ["status", "startedAt", "finishedAt", "livePhase", "decisionPacket.criteria"],
  status: ["runningCommandStartedAt", "lastEventAt", "readableTail", "checkPlan.checks", "assignment.verification", "activeCheck.host", "status", "startedAt", "finishedAt", "livePhase", "requestId", "assignment.objective", "progress", "lastCommand", "model", "threadId", "modelChildStartedAt", "usage", "execs"],
  tokens: ["mode", "readOnly", "containmentVersion", "executionReadOnly", "status", "startedAt", "finishedAt", "livePhase", "model", "threadId", "modelChildStartedAt", "usage", "execs", "implementationFinishedAt", "reviewerStartedAt", "acceptedAt", "committedAt", "integration.committedAt", "delivery.at", "delivery.implementationCommit", "lineStats", "lineStatsAt"],
};
export function extractJobs(db, cwds, view = "tokens", limit = 256, byId = false) {
  const selected = fields[view];
  if (!selected || !cwds.length) return [];
  // Card criteria are counted in SQL, never passed through as reviewer prose.
  const paths = selected.filter(k => k !== "decisionPacket.criteria");
  const packet = view === "card" ? ", (SELECT count(*) FROM json_each(state, '$.decisionPacket.criteria')) AS total, (SELECT count(*) FROM json_each(state, '$.decisionPacket.criteria') WHERE json_extract(value, '$.verdict')='met') AS met" : "";
  const sql = "WITH selected AS MATERIALIZED (SELECT id FROM jobs WHERE " + (byId ? "id" : "cwd") + " IN (" + cwds.map(() => "?").join(",") + ") ORDER BY created DESC LIMIT ?) SELECT jobs.id,jobs.cwd,json_extract(state," + paths.map(k => "'$." + k + "'").join(",") + ") AS data" + packet + " FROM selected JOIN jobs ON jobs.id=selected.id";
  // Bound extracted exec histories before they cross into JS; inline legacy baselines stay in SQLite.
  const query = byId ? "WITH projected AS MATERIALIZED ("+sql+") SELECT id,cwd,CASE WHEN length(data)<=1048576 THEN data END AS data FROM projected" : sql;
  let bytes=0;
  const results=[];
  for(const row of db.prepare(query).iterate(...cwds, limit)) {
    if(byId && (row.data===null || (bytes+=row.data.length)>8*1048576))throw Error("Attributed job metadata exceeds bound");
    const result = { id: row.id, jobId: row.id, cwd: row.cwd };
    JSON.parse(row.data).forEach((value, i) => {
      if (value === null) return;
      const parts = paths[i].split("."); let target = result;
      for (const part of parts.slice(0, -1)) target = target[part] ||= {};
      target[parts.at(-1)] = value;
    });
    if (view === "card") result.packetCounts = { total: row.total, met: row.met };
    results.push(view === "tokens" ? decodeBoundary(result) : result);
  }
  return results;
}
export function projectJobs(root, cwd, view = "tokens") {
  if (!cwd) return [];
  const ancestors = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    ancestors.push(fold(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return observe(root, db => extractJobs(db, ancestors, view)) || [];
}
/** Session attribution is approximate: same project, execution started since the transcript began. */
export function sessionStart(file) {
  if (!file) return null;
  for (const line of readBounded(file, 65536).text.split("\n")) {
    try { const at = Date.parse(JSON.parse(line).timestamp); if (Number.isFinite(at)) return at; } catch {}
  }
  return null;
}

/** Exact bounded ID lookup, independent of project folders and with no write lock. */
export function attributedJobs(root, ids) {
  if(ids.length>256)throw Error("Session attribution exceeds job bound");
  return observe(root,db=>extractJobs(db,ids,"tokens",256,true)) || [];
}
