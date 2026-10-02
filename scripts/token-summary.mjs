process.env.NoDefaultCurrentDirectoryInExePath = "1";
/**
 * Stop hook entry: after a long response, shows how the session's tokens
 * split between the lead (Claude) and the contributor (Codex).
 *
 * It only reads logs, never blocks the turn and never fails it: any problem
 * means no summary. Settings (environment):
 *   CODEX_TEAM_TOKENS            long (default) | always | off
 *   CODEX_TEAM_TOKENS_MIN_CALLS  Claude calls that make a response "long" (default 8)
 */
import fs from "node:fs";
import { tokenSummary } from "./tokens.mjs";

try {
  const message = tokenSummary(JSON.parse(fs.readFileSync(0, "utf8") || "{}"));
  if (message) process.stdout.write(JSON.stringify({ systemMessage: message }));
} catch {
  // A summary is optional; the response must end normally.
}
