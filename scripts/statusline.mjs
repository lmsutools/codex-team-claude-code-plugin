process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** Read-only progress without model calls. Optional --base composes an existing status command. */
import { actor, liveWatchers, clockTime } from "./watchers.mjs";
import { baseCommand } from "./base-command.mjs";
import { redactDefault } from "./host-security.mjs";
import fs from "node:fs";
import path from "node:path";
import { isMain } from "./hook-entry.mjs";
import { stateRoot } from "./state-reader.mjs";
import { projectJobs } from "./observer.mjs";
import { jobExecs, readExecUsage } from "./rollout-usage.mjs";
const short = (s, n) => String(s || "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").slice(0, n);
export function statusLines(input, { root = stateRoot(), now = Date.now(), home } = {}) {
  const deadline = Date.now() + 100;
  return projectJobs(root, input?.cwd, "status").filter(j => ["starting", "running", "verifying"].includes(j.status) ||
    (now - Date.parse(j.finishedAt) >= 0 && now - Date.parse(j.finishedAt) < 600000)).slice(0, 12).map(j => {
    const active = ["starting", "running", "verifying"].includes(j.status);
    const elapsed = Math.max(0, Math.floor(((active ? now : Date.parse(j.finishedAt)) - Date.parse(j.startedAt)) / 1000));
    let tokens = 0, missing = false;
    for (const e of jobExecs(j)) {
      const sample = e.finishedAt && e.usage ? { usage: e.usage } : readExecUsage(e, { home, deadline });
      if (sample.usage) tokens += (sample.usage.input_tokens || 0) + (sample.usage.output_tokens || 0);
      else missing = true;
    }
    const phase = actor(j).phase;
    const watcher = liveWatchers(root, j.jobId, now)[0];
    const lastEvent = Date.parse(j.lastEventAt || j.modelChildStartedAt);
    const eventAge = active && (j.status !== "verifying" || j.livePhase === "reviewer") && Number.isFinite(lastEvent) ? Math.max(0, Math.floor((now-lastEvent)/1000)) : null;
    const commandAt = Date.parse(j.runningCommandStartedAt);
    const commandAge = eventAge !== null && Number.isFinite(commandAt) ? Math.max(0, Math.floor((now-commandAt)/1000)) : null;
    return `Codex ▸ ${short(j.requestId || j.assignment?.objective || j.id, 36)} · ${phase}${commandAge !== null ? ` · command running ${commandAge}s` : eventAge !== null ? ` · last event ${eventAge}s ago` : ""} ${Math.floor(elapsed / 60)}m${elapsed % 60}s · "${short(redactDefault(String(j.progress || j.lastCommand || "")).split(/\r?\n/).filter(line => line.trim()).at(-1), 60)}" · ${String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} tokens${missing ? " (live unavailable)" : ""}${watcher ? ` · Claude checks ${clockTime(watcher.until)}` : ""}`;
  }).join("\n");
}
if (isMain(import.meta.url)) {
  try {
    const stdin = fs.readFileSync(0, "utf8"), input = JSON.parse(stdin);
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--base")) throw Error("Expected --base command");
    let base = "";
    if (args[1]) {
      base = await baseCommand(args[1], stdin);
    }
    let progress = "";
    try { progress = statusLines(input); } catch {}
    const output = [base, progress].filter(Boolean).join("\n");
    if (output) process.stdout.write(output, () => process.exit(0));
    else process.exit(0);
  } catch { process.exit(0); }
}
