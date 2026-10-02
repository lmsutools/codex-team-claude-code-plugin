import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { recordWorkerFault } from "../scripts/runtime.mjs";
import * as S from "../scripts/store.mjs";
test("detached worker faults remain available and redact secret text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-fault-")),
    id = "11111111-2222-3333-4444-555555555555";
  process.env.CODEX_TEAM_STATE = root;
  try {
    fs.mkdirSync(S.jobDir(id));
    const state = {
      jobId: id,
      cwd: root,
      startedAt: S.now(),
      status: "running",
      workerPid: 2147483647,
      heartbeatAt: "2000-01-01T00:00:00Z",
    };
    S.save(state);
    recordWorkerFault(
      id,
      new Error("sk-SYNTHETIC012345678901234567890"),
      "heartbeat",
    );
    const result = S.recover(state);
    assert.equal(result.status, "interrupted");
    assert.equal(result.workerFault.stage, "heartbeat");
    assert.equal(result.workerFault.message, "[REDACTED]");
  } finally {
    S.closeStores();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codex-team-fault-"));
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
test("heartbeats preserve persisted content without rerunning secret expressions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-fault-")),
    id = "22222222-2222-3333-4444-555555555555";
  process.env.CODEX_TEAM_STATE = root;
  try {
    const state = {
      jobId: id,
      cwd: root,
      startedAt: S.now(),
      status: "running",
      progress: "already scanned",
      profile: {
        components: {
          secrets: {
            level: "enforce",
            patterns: ["synthetic-secret"],
            redactInState: true,
          },
        },
      },
    };
    S.save(state);
    const scanner = t.mock.method(vm, "runInNewContext", () => {
      throw Error("must not scan unchanged content");
    });
    const updated = S.heartbeat(id);
    assert.equal(scanner.mock.callCount(), 0);
    assert.ok(Date.parse(updated.heartbeatAt));
    const { heartbeatAt, updatedAt, ...unchanged } = updated;
    assert.deepEqual(unchanged, state);
    assert.deepEqual(S.read(id), updated);
    scanner.mock.restore();
  } finally {
    S.closeStores();
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
