import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as S from "../scripts/store.mjs";
test("additive migration preserves legacy rows and a consistent pre-migration SQLite backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-migration-"));
  const oldState = process.env.CODEX_TEAM_STATE;
  process.env.CODEX_TEAM_STATE = root;
  const job = {
    jobId: "11111111-2222-3333-4444-555555555555",
    cwd: root,
    startedAt: "2026-09-27T00:00:00.000Z",
    status: "accepted",
    version: "1.1.1",
    result: { summary: "Historical result" },
  };
  try {
    const old = new DatabaseSync(path.join(root, "state.sqlite"));
    old.exec(
      "PRAGMA journal_mode=WAL;CREATE TABLE jobs(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,created TEXT NOT NULL,state TEXT NOT NULL);CREATE TABLE contexts(cwd TEXT PRIMARY KEY,data TEXT NOT NULL);",
    );
    old
      .prepare("INSERT INTO jobs VALUES(?,?,?,?)")
      .run(job.jobId, root, job.startedAt, JSON.stringify(job));
    old
      .prepare("INSERT INTO contexts VALUES(?,?)")
      .run(root, JSON.stringify({ version: 3, decisions: ["Keep history"] }));
    // Leave the old connection open: the backup must include committed WAL data.
    assert.deepEqual(S.read(job.jobId), job);
    S.setExtension("fixture", "migration", { ok: true });
    const backups = fs
      .readdirSync(root)
      .filter((f) => /^before-v112-.*\.sqlite$/.test(f));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(root, backups[0]), {
      readOnly: true,
    });
    assert.deepEqual(
      JSON.parse(backup.prepare("SELECT state FROM jobs").get().state),
      job,
    );
    assert.equal(
      JSON.parse(backup.prepare("SELECT data FROM contexts").get().data)
        .version,
      3,
    );
    assert.equal(
      backup
        .prepare("SELECT name FROM sqlite_master WHERE name='extensions'")
        .get(),
      undefined,
    );
    backup.close();
    old.close();
    S.closeStores();
    assert.deepEqual(S.read(job.jobId), job);
    assert.equal(
      fs.readdirSync(root).filter((f) => /^before-v112-.*\.sqlite$/.test(f))
        .length,
      1,
    );
  } finally {
    S.closeStores();
    if (oldState === undefined) delete process.env.CODEX_TEAM_STATE;
    else process.env.CODEX_TEAM_STATE = oldState;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codex-team-migration-"));
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
