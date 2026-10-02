process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** SessionStart compact/clear/resume recovery through Claude Code's additionalContext contract. */
import fs from "node:fs";
import path from "node:path";
import { isMain } from "./hook-entry.mjs";
import { stateRoot } from "./state-reader.mjs";
import { observe, gitRoot, fold } from "./observer.mjs";
export function sessionContext(input, root = stateRoot()) {
  if (!["compact", "clear", "resume"].includes(input?.source) || !input.cwd) return null;
  const cwd = gitRoot(input.cwd) || input.cwd;
  const card = observe(root, db => {
    const row = db.prepare("SELECT data FROM extensions WHERE kind='lead-state' AND key=?").get(fold(cwd));
    return row ? JSON.parse(row.data).text : null;
  });
  return typeof card === "string" && card ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: card.length <= 8000 ? card : card.slice(0, card.lastIndexOf("\n", 8000)) } } : null;
}
if (isMain(import.meta.url)) {
  try { const result = sessionContext(JSON.parse(fs.readFileSync(0, "utf8"))); if (result) process.stdout.write(JSON.stringify(result)); } catch {}
}
