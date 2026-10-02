/** Best-effort statistics use a separate database: never the job transition lock. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateRoot } from "./state-reader.mjs";
export const kinds = ["implementation", "revision", "scout", "reviewer", "verification"];
function recordingFailure(root, error) {
  try { const log=path.join(root,"run-stats-errors.log"); if(fs.existsSync(log) && fs.statSync(log).size>65536) fs.truncateSync(log,0); fs.appendFileSync(log, new Date().toISOString() + " " + (error.code || error.message) + "\n"); } catch {}
}
/** One connection/transaction per batch; updates do not rewrite unchanged samples. */
export function recordRuns(records, root = stateRoot()) {
  if (!records.length) return true;
  let db;
  try {
    if (records.some(record => !kinds.includes(record.kind))) throw Error("Unknown run kind");
    fs.mkdirSync(root, {recursive:true});
    db = new DatabaseSync(path.join(root, "run-stats.sqlite"));
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,kind TEXT,at TEXT,data TEXT); CREATE INDEX IF NOT EXISTS runs_kind ON runs(kind,at);");
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,at=excluded.at,data=excluded.data WHERE runs.data!=excluded.data");
    for (const record of records) insert.run(record.id, record.kind, record.at || new Date().toISOString(), JSON.stringify(record));
    const count = db.prepare("SELECT count(*) AS n FROM runs WHERE kind=?");
    const prune = db.prepare("DELETE FROM runs WHERE kind=? AND id NOT IN (SELECT id FROM runs WHERE kind=? ORDER BY at DESC,rowid DESC LIMIT 200)");
    // Prune only overflowing kinds, once per batch. The 200-record bound stays strict.
    for (const kind of new Set(records.map(record => record.kind))) if (count.get(kind).n > 200) prune.run(kind,kind);
    db.exec("COMMIT");
    return true;
  } catch (error) { recordingFailure(root,error); return false; }
  finally { try { db?.close(); } catch {} }
}
export const recordRun = (record, root = stateRoot()) => recordRuns([record],root);

/** Deferred to the next event-loop turn: no statistics I/O before persist resolves. */
export function createRunRecorder({write = recordRuns, schedule = setImmediate} = {}) {
  const pending = new Map();
  let scheduled = false;
  function flush() {
    scheduled = false;
    const batches = [...pending]; pending.clear();
    for (const [root,records] of batches) {
      // A test/session may already have removed its isolated state directory.
      if (!fs.existsSync(root)) continue;
      try { write([...records.values()],root); } catch (error) { recordingFailure(root,error); }
    }
  }
  return {
    enqueue(record, root = stateRoot()) {
      let records = pending.get(root);
      if (!records) { records = new Map(); pending.set(root,records); }
      records.set(record.id,record);
      if (records.size > 1000) records.delete(records.keys().next().value);
      if (!scheduled) { scheduled = true; schedule(flush); }
    },
    flush,
  };
}
const recorder = createRunRecorder();
export const queueRun = (record, root = stateRoot()) => recorder.enqueue(record,root);
export const flushRunStats = () => recorder.flush();

export function readRuns(root = stateRoot(), project) {
  let db;
  try {
    if (!fs.existsSync(path.join(root, "run-stats.sqlite"))) return [];
    db = new DatabaseSync(path.join(root, "run-stats.sqlite"), { readOnly: true });
    db.exec("PRAGMA busy_timeout=0");
    // Each kind is an indexed, bounded lookup, including databases created by older builds.
    const select = db.prepare("SELECT data FROM runs WHERE kind=? ORDER BY at DESC,rowid DESC LIMIT 200");
    return kinds.flatMap(kind => select.all(kind).map(r => JSON.parse(r.data))).filter(r => !project || (r.cwd && path.resolve(r.cwd).toLowerCase() === path.resolve(project).toLowerCase()));
  } catch { return []; } finally { try { db?.close(); } catch {} }
}
/** Timeout/tool-list queries need only successful durations, never all token records. */
function readTimings(selected = kinds) {
  let db;
  try {
    const file = path.join(stateRoot(),"run-stats.sqlite");
    if (!fs.existsSync(file)) return [];
    db = new DatabaseSync(file,{readOnly:true}); db.exec("PRAGMA busy_timeout=0");
    const select = db.prepare("SELECT json_extract(data,'$.durationSeconds') AS durationSeconds FROM (SELECT data FROM runs WHERE kind=? ORDER BY at DESC,rowid DESC LIMIT 200) WHERE json_extract(data,'$.outcome')='finished'");
    return selected.flatMap(kind => select.all(kind).map(row => ({kind,outcome:"finished",durationSeconds:row.durationSeconds})));
  } catch { return []; } finally { try {db?.close();} catch {} }
}
const percentile = (values, p) => { const sorted = values.filter(Number.isFinite).sort((a,b) => a-b); return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length*p)-1)] : null; };
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b), middle = Math.floor(sorted.length/2);
  return !sorted.length ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
};
export function statistics(records = readRuns()) {
  return Object.fromEntries(kinds.flatMap(kind => {
    const rows = records.filter(r => r.kind === kind);
    if (!rows.length) return [];
    return [[kind, { n: rows.length, p50: percentile(rows.map(r => r.durationSeconds), .5), p90: percentile(rows.map(r => r.durationSeconds), .9),
      medianTokens: Object.fromEntries(["input", "cached", "output"].map(k => [k, median(rows.map(r => r[k + "Tokens"]))])),
      timeoutRate: rows.filter(r => r.outcome === "timed_out").length/rows.length, salvageRate: rows.filter(r => r.outcome === "salvaged").length/rows.length }]];
  }));
}
export function timeoutChoice(kind, explicit, records = readTimings([kind])) {
  const s = statistics(records.filter(r => r.outcome === "finished" && Number.isFinite(r.durationSeconds)))[kind];
  return { timeoutSeconds: explicit ?? (s?.n >= 5 ? Math.max(600, Math.min(7200, Math.ceil(s.p90*1.5))) : 1800),
    timeoutBasis: explicit !== undefined ? "explicit" : s?.n >= 5 ? { n: s.n, p50: s.p50, p90: s.p90 } : "default",
    ...(s ? { typicalDurationSeconds: s.p50 } : {}) };
}
export function typicalLine() {
  try { const s = statistics(readTimings().filter(r => Number.isFinite(r.durationSeconds))); const parts = Object.entries(s).map(([k,v]) => `${k} ${Math.ceil(v.p50/60)}m`); return parts.length ? ("Typical durations: " + parts.join(", ")).slice(0,200) : ""; } catch { return ""; }
}
export const runKind = state => state.execRole === "reviewer" ? "reviewer" : state.mode === "scout" ? "scout" : state.resumeJobId ? "revision" : "implementation";
export function runRecord(state, exec, outcome) {
  return { id: `${state.jobId}:${exec.role}:${exec.startedAt}`, cwd: state.cwd, kind: exec.role === "reviewer" ? "reviewer" : runKind(state), at: exec.finishedAt,
    durationSeconds: Math.max(0,(Date.parse(exec.finishedAt)-Date.parse(exec.startedAt))/1000),
    inputTokens: exec.usage?.input_tokens ?? null, cachedTokens: exec.usage?.cached_input_tokens ?? null, outputTokens: exec.usage?.output_tokens ?? null,
    outcome, cliVersion: state.runtime?.version ?? null, model: exec.model || state.model || null, effort: state.effort || null };
}
export function finishedRunChanges(state, previousExecs = []) {
  const previous = new Map(previousExecs.map(exec => [`${exec.role}:${exec.startedAt}`,exec]));
  return (state.execs || []).filter(exec => {
    if (!exec.finishedAt) return false;
    const prior = previous.get(`${exec.role}:${exec.startedAt}`);
    return !prior?.finishedAt || prior.finishedAt !== exec.finishedAt || prior.outcome !== exec.outcome || JSON.stringify(prior.usage) !== JSON.stringify(exec.usage);
  }).map(exec => {
    const outcome = ["implementation_finished", "completed", "finished"].includes(exec.outcome) ? "finished" : ["salvaged", "timed_out", "cancelled", "interrupted"].includes(exec.outcome) ? exec.outcome : "failed";
    return runRecord(state,exec,outcome);
  });
}
export function recordFinishedExecs(state, previousExecs = []) {
  try { for (const record of finishedRunChanges(state,previousExecs)) queueRun(record); }
  catch (error) { recordingFailure(stateRoot(),error); }
}
