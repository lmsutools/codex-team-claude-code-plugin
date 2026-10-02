process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** PostToolUse size advice from stdin only: never reads a transcript or calls a model. */
import fs from "node:fs";
import path from "node:path";
import { isMain } from "./hook-entry.mjs";
export function sizeWarning(input) {
  if (input?.tool_response === undefined) return null;
  const text = typeof input.tool_response === "string" ? input.tool_response : JSON.stringify(input.tool_response);
  if (text.length <= 80000) return null;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext:
    "codex-team: this output exceeds about 20k tokens (characters / 4) and will be re-read on every later call; delegate, trim or summarize next time." } };
}
if (isMain(import.meta.url)) {
  try { const result = sizeWarning(JSON.parse(fs.readFileSync(0, "utf8"))); if (result) process.stdout.write(JSON.stringify(result)); } catch {}
}
