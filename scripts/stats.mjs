/** Read-only, zero-model statistics command. */
import path from "node:path";
import { isMain } from "./hook-entry.mjs";
import { readRuns, statistics } from "./run-stats.mjs";
export function statsCommand(args) {
  let project, json = false;
  for (let i=0;i<args.length;i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--project" && path.isAbsolute(args[i+1] || "")) project = args[++i];
    else throw Error("Usage: stats.mjs [--project <absolute cwd>] [--json]");
  }
  const result = statistics(readRuns(undefined, project));
  if (!Object.keys(result).length) return json ? JSON.stringify({ message: "No run statistics yet.", kinds: {} }) : "No run statistics yet.";
  return json ? JSON.stringify(result) : Object.entries(result).map(([k,s]) => `${k}: n=${s.n} p50=${s.p50}s p90=${s.p90}s median tokens=${JSON.stringify(s.medianTokens)} timeout=${(100*s.timeoutRate).toFixed(1)}% salvage=${(100*s.salvageRate).toFixed(1)}%`).join("\n");
}
if (isMain(import.meta.url)) { try { console.log(statsCommand(process.argv.slice(2))); } catch(e) { console.error(e.message); process.exitCode=1; } }
