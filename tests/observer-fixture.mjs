/** Isolated observer fixtures: no real provider logs, settings or state. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export const id = "11111111-1111-1111-1111-111111111111";
export const at = n => new Date(Date.UTC(2026, 8, 28, 10, 0, n)).toISOString();
export function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-observer-"));
  const root = path.join(dir, "state"), cwd = path.join(dir, "project"), home = path.join(dir, "home");
  fs.mkdirSync(root); fs.mkdirSync(cwd); fs.mkdirSync(home); fs.mkdirSync(path.join(cwd, ".git"));
  const db = new DatabaseSync(path.join(root, "state.sqlite"));
  db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,cwd TEXT,created TEXT,state TEXT); CREATE INDEX jobs_cwd ON jobs(cwd,created); CREATE TABLE extensions(kind TEXT,key TEXT,data TEXT,PRIMARY KEY(kind,key)); CREATE TABLE contexts(cwd TEXT PRIMARY KEY,data TEXT)");
  const transcript = path.join(dir, "session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: at(0), message: { content: "build" } }) + "\n");
  const put = (state = {}) => {
    const job = { jobId: id, cwd, status: "running", startedAt: at(1), requestId: "fixture", ...state };
    db.prepare("INSERT OR REPLACE INTO jobs VALUES(?,?,?,?)").run(job.jobId, process.platform === "win32" ? cwd.toLowerCase() : cwd, job.startedAt, JSON.stringify(job));
    return job;
  };
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { dir, root, cwd, home, db, put, transcript };
}
export function rollout(home, thread, entries) {
  const dir = path.join(home, "sessions", "2026", "09", "28");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-28-${thread}.jsonl`);
  fs.writeFileSync(file, entries.map(e => typeof e === "string" ? e : JSON.stringify(e)).join("\n") + "\n");
  return file;
}
export const sample = (n, input, output = 0) => ({ timestamp: at(n), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: output } }, rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: 1790000000 } } } });
