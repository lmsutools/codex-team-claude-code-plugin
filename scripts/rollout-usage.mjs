/** Codex per-process rollout samples, bounded discovery/tails and per-exec deltas. No model calls. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBounded } from "./observer.mjs";
export const usageKeys = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];
export const zero = () => Object.fromEntries(usageKeys.map(k => [k, 0]));
export const delta = (a, b = {}) => Object.fromEntries(usageKeys.map(k => [k, Math.max(0, (Number(a?.[k]) || 0) - (Number(b?.[k]) || 0))]));
export function findRollout(threadId, { home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), deadline = Date.now() + 60 } = {}) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(threadId || "")) return null;
  const pending = [path.join(home, "sessions")];
  let visited = 0;
  while (pending.length && visited < 4096 && Date.now() < deadline) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    for (const e of entries) {
      if (++visited > 4096 || Date.now() >= deadline) return null;
      if (e.isDirectory()) pending.push(path.join(dir, e.name));
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(`-${threadId}.jsonl`)) return path.join(dir, e.name);
    }
  }
  return null;
}
export function readRollout(threadId, options = {}) {
  const file = findRollout(threadId, options);
  if (!file) return { samples: [], truncated: false };
  const { text, truncated } = readBounded(file, options.tailBytes || 512 * 1024, true);
  const samples = [];
  let model = null;
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line), p = event.payload;
      if (event.type === "turn_context" && p?.model) model = p.model;
      if (event.type !== "event_msg" || p?.type !== "token_count" || !p.info?.total_token_usage) continue;
      const at = Date.parse(event.timestamp);
      if (Number.isFinite(at)) samples.push({ at, usage: p.info.total_token_usage, rateLimits: p.rate_limits, model });
    } catch { /* a concurrent writer may leave a partial final line */ }
  }
  return { samples, truncated, model };
}
export function readExecUsage(exec, { replyStart = 0, rollout, ...options } = {}) {
  const start = Date.parse(exec.startedAt || ""), end = Date.parse(exec.finishedAt || "") || Infinity;
  const log = rollout || readRollout(exec.threadId, options);
  // Each CLI exec/resume starts its own counter at zero. Never use a preceding
  // process's total as a baseline, including legacy persisted rolloutBaseline.
  let samples = log.samples.filter(s => s.at >= start && s.at <= end);
  let reset = false;
  for (let i = 1; i < samples.length; i++) {
    if (Number(samples[i].usage.input_tokens) < Number(samples[i - 1].usage.input_tokens)) {
      samples = samples.slice(i); i = 0; reset = true;
    }
  }
  const latest = samples.at(-1);
  const usage = exec.finishedAt && exec.usage ? exec.usage : latest ? delta(latest.usage) : null;
  let replyUsage = null;
  if (usage) {
    if (replyStart <= start) replyUsage = usage;
    else if (end < replyStart || (!exec.finishedAt && latest && latest.at < replyStart)) replyUsage = zero();
    else {
      const beforeReply = samples.filter(s => s.at < replyStart && s.at >= start).at(-1);
      if (beforeReply) replyUsage = delta(usage, beforeReply.usage);
      else if (latest && (!log.truncated || reset)) replyUsage = usage;
    }
  }
  return { usage, replyUsage, model: latest?.model || exec.model || log.model || null,
    rateLimits: latest?.rateLimits || null, sampledAt: latest?.at, live: !exec.finishedAt, unavailable: !usage };
}
export function jobExecs(job) {
  if (job.execs?.length) {
    const seen = new Map();
    for(const e of job.execs) {
      const key=[e.role,e.attempt,e.startedAt,e.reviewRunId || ""].join(":");
      const prior=seen.get(key);
      if(!prior || e.finishedAt || !prior.finishedAt)seen.set(key,e);
    }
    return [...seen.values()].map(e=>({...e,model:e.model || job.model}));
  }
  return [{ startedAt: job.modelChildStartedAt || job.startedAt, finishedAt: job.implementationFinishedAt || job.finishedAt,
    threadId: job.modelChildStartedAt ? job.threadId : null, usage: job.usage, model: job.model,
    legacy: !job.modelChildStartedAt }];
}
