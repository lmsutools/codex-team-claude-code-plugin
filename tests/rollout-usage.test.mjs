/** Live/final and resumed execution accounting, using fake provider logs. */
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, rollout, sample, at } from "./observer-fixture.mjs";
import { findRollout, readRollout, readExecUsage, jobExecs } from "../scripts/rollout-usage.mjs";
import { priceUsage } from "../scripts/token-prices.mjs";
test("resumed process resets its total; live and final use zero baseline with correct reply delta", t => {
  const { home } = fixture(t);
  rollout(home, "thread", [{ type: "turn_context", payload: { model: "test-model" } }, sample(1, 5805867, 10000), sample(3, 174601, 20), sample(5, 250000, 30), "{partial"]);
  const exec = { threadId: "thread", startedAt: at(2), rolloutBaseline: sample(1, 100, 10).payload.info.total_token_usage };
  const live = readExecUsage(exec, { home, replyStart: Date.parse(at(4)) });
  assert.equal(live.usage.input_tokens, 250000); assert.equal(live.replyUsage.input_tokens, 75399);
  assert.equal(live.model, "test-model"); assert.equal(live.rateLimits.primary.used_percent, 25);
  const final = readExecUsage({ ...exec, finishedAt: at(6), usage: { input_tokens: 260000, output_tokens: 25 } }, { home, replyStart: Date.parse(at(4)) });
  assert.equal(final.usage.input_tokens, 260000); assert.equal(final.replyUsage.input_tokens, 85399);
  assert.equal(readRollout("thread", { home }).samples.length, 3);
});
test("bounded tails use zero per-process baseline but cannot invent a reply boundary", t => {
  const { home } = fixture(t);
  rollout(home, "bounded", [sample(0, 100), "x".repeat(2000), sample(8, 200)]);
  const log = readRollout("bounded", { home, tailBytes: 800 });
  assert.equal(log.truncated, true);
  const result = readExecUsage({ startedAt: at(2), threadId: "bounded" }, { rollout: log, replyStart: Date.parse(at(5)) });
  assert.equal(result.usage.input_tokens, 200); assert.equal(result.replyUsage, null);
  assert.equal(findRollout("../../escape", { home }), null);
  assert.equal(findRollout("missing", { home, deadline: 0 }), null);
  const fresh = readExecUsage({ startedAt: at(2), freshThread: true }, { rollout: log, replyStart: Date.parse(at(5)) });
  assert.equal(fresh.usage.input_tokens, 200); assert.equal(fresh.replyUsage, null);
  assert.equal(readExecUsage({ startedAt: at(2), freshThread: false }, {
    rollout: { ...log, truncated: false }, replyStart: Date.parse(at(1)),
  }).usage.input_tokens, 200, "a resumed exec starts a new per-process counter");
});
test("history deduplicates execs, retaining reviewer roles", () => {
  const a = { role: "implementation", attempt: 0, startedAt: at(1) };
  assert.equal(jobExecs({ execs: [a, a, { ...a, role: "reviewer" }] }).length, 2);
});
test("final usage without rollout samples cannot invent an intra-exec reply boundary", () => {
  const result = readExecUsage({ startedAt: at(1), finishedAt: at(10), usage: { input_tokens: 500 } },
    { rollout: { samples: [], truncated: false }, replyStart: Date.parse(at(5)) });
  assert.equal(result.usage.input_tokens, 500); assert.equal(result.replyUsage, null);
});
test("prices require all provider/model rates including cache writes", () => {
  const entries = [{ provider: "anthropic", model: "m", usage: { input: 100, cached: 50, output: 10 }, cacheWrite: 20 }];
  assert.equal(priceUsage(entries, null).total, null);
  const prices = { version: 1, models: { "anthropic/m": { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 } } };
  assert.equal(priceUsage(entries, prices).total, 230 / 1e6);
  assert.equal(priceUsage([...entries, { ...entries[0], model: null }], prices).total, null);
  delete prices.models["anthropic/m"].cacheWrite;
  assert.equal(priceUsage(entries, prices).total, null);
});

test("an interrupted reviewer never inherits implementation usage", async () => {
  const { finishExecs } = await import("../scripts/supervisor.mjs");
  const impl = { role: "implementation", attempt: 1, startedAt: at(2) };
  const reviewer = { role: "reviewer", attempt: 0, startedAt: at(3) };
  const state = { execAttempt: 1, usage: { input_tokens: 123 }, threadId: "impl", execs: [impl, reviewer, { ...impl, attempt: 0 }] };
  const done = finishExecs(state, "interrupted");
  assert.equal(done[0].usage.input_tokens, 123);
  assert.equal(done[1].usage, null); assert.equal(done[1].threadId, null);
  assert.equal(done[2].usage, null);
});

test("counter drop discards samples from an earlier process even in an overlapping clock window", () => {
  const result = readExecUsage({ startedAt: at(1), threadId: "resumed" }, { replyStart: Date.parse(at(2)), rollout: { truncated: true, samples: [
    { at: Date.parse(at(1)), usage: { input_tokens: 5805867 } },
    { at: Date.parse(at(3)), usage: { input_tokens: 174601 } },
  ] } });
  assert.equal(result.usage.input_tokens, 174601); assert.equal(result.replyUsage.input_tokens, 174601);
});
