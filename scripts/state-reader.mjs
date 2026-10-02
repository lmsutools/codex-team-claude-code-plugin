/** Short read-only SQLite statements for observers. Never migrates, recovers or hydrates blobs. */
import fs from "node:fs";
import { decodeBoundary } from "./execution-boundary.mjs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export const stateRoot = () => path.resolve(
  process.env.CODEX_TEAM_STATE || path.join(os.homedir(), ".claude", "codex-team", "jobs"),
);
export function jobDirectory(id, root = stateRoot()) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
    throw new Error("Invalid job ID.");
  return path.join(root, id);
}
export function openReadOnlyStore(root = stateRoot()) {
  const db = new DatabaseSync(path.join(root, "state.sqlite"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout=5000"); }
  catch (error) { db.close(); throw error; }
  return db;
}
export const isBusy = error => [5, 6].includes(error?.errcode) ||
  /database (?:table )?is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/i.test(error?.message || "");
export function readJob(id, root = stateRoot()) {
  const dir = jobDirectory(id, root);
  let raw;
  if (fs.existsSync(path.join(root, "state.sqlite"))) {
    const db = openReadOnlyStore(root);
    try {
      raw = db.prepare("SELECT state FROM jobs WHERE id=?").get(id)?.state;
    } finally {
      db.close();
    }
  }
  if (raw === undefined) {
    const legacy = path.join(dir, "job.json");
    if (!fs.existsSync(legacy)) throw new Error("Unknown job ID.");
    raw = fs.readFileSync(legacy, "utf8");
  }
  const state = JSON.parse(raw);
  if (state?.jobId !== id || typeof state.status !== "string" || !/^[a-z_]{1,64}$/.test(state.status))
    throw new Error("Unreadable job state.");
  return decodeBoundary(state);
}
