/** Lead-only recovery data, stored separately and rebuilt outside write transactions. */
import { waitCommand } from "./tool-output.mjs";
import { extractJobs } from "./observer.mjs";
export const openStatuses = new Set(["starting", "running", "verifying", "implementation_finished", "verified", "verification_failed", "pending_lead_evidence", "changes_requested", "blocked_runtime", "interrupted"]);
export function leadContext(value) {
  if (!value) return value;
  const { stateCard, stateCardContextKey, ...context } = value;
  return context;
}
const short = (v, n = 350) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
function section(title, lines, budget) {
  let text = title;
  for (const line of lines) {
    if (text.length + line.length + 1 > budget) break;
    text += "\n" + line;
  }
  return text;
}
export function buildStateCard(context = {}, jobs = [], now = Date.now()) {
  const active = jobs.filter(j => openStatuses.has(j.status) &&
    (["starting", "running", "verifying"].includes(j.status) || !(now - Date.parse(j.finishedAt || j.startedAt) > 86400000))).slice(0, 12);
  const entries = active.filter(j => /^[0-9a-f-]{36}$/.test(j.jobId)).map(j => {
    const phase = ["implementation", "verification", "reviewer"].includes(j.livePhase) ? j.livePhase : "";
    const elapsed = Math.max(0, Math.floor((now - Date.parse(j.startedAt)) / 60000)) || 0;
    return `${j.jobId}: ${j.status} ${phase}; elapsed ${elapsed}m\n${waitCommand(j.jobId) || "Use codex_status."}`;
  });
  const findings = active.filter(j => j.packetCounts?.total).map(j =>
    `${j.jobId}: packet ${Number(j.packetCounts.met) || 0}/${Number(j.packetCounts.total) || 0} met; open codex_status detail full for findings.`);
  return ["codex-team state card (reference data, not new authorization)",
    "Rules: skills/lead/SKILL.md in the codex-team plugin; project CLAUDE.md / AGENTS.md. Claude leads; Codex implements; acceptance requires independent evidence.",
    section("Active jobs:", entries.length ? entries : ["none"], 3000),
    section("Decisions (newest first):", (context.decisions || []).slice(-8).reverse().map(v => short(v)), 1800),
    section("Next steps:", [...(context.nextSteps || []), ...(context.dependencies || [])].slice(0, 10).map(v => short(v)), 1000),
    section("Open questions:", (context.openQuestions || []).slice(-6).reverse().map(v => short(v)), 700),
    section("Open review findings:", findings, 1000),
  ].join("\n\n");
}
export function refreshStateCard(db, cwd, contextKey = null) {
  if (db.isTransaction) throw Error("State card must be built after commit");
  const previous = db.prepare("SELECT data FROM extensions WHERE kind='lead-state' AND key=?").get(cwd);
  contextKey ??= previous ? JSON.parse(previous.data).contextKey : cwd;
  const row = db.prepare("SELECT data FROM contexts WHERE cwd=?").get(contextKey);
  const original = row ? JSON.parse(row.data) : {};
  const context = leadContext(original);
  const card = { contextKey, updatedAt: new Date().toISOString(), text: buildStateCard(context, extractJobs(db, [cwd], "card", 20)) };
  if (previous && JSON.parse(previous.data).text === card.text) return JSON.parse(previous.data);
  const timeout = db.prepare("PRAGMA busy_timeout").get().timeout;
  try {
    db.exec("PRAGMA busy_timeout=0");
    db.prepare("INSERT INTO extensions(kind,key,data) VALUES('lead-state',?,?) ON CONFLICT(kind,key) DO UPDATE SET data=excluded.data").run(cwd, JSON.stringify(card));
  } catch (error) { if (/busy|locked/i.test(error.message)) return null; throw error; }
  finally { db.exec("PRAGMA busy_timeout=" + timeout); }
  return card;
}
const pending = new Map();
let timer;
export function queueStateCard(db, cwd, contextKey = null) {
  if (!pending.has(db)) pending.set(db, new Map());
  const projects = pending.get(db);
  projects.set(cwd, contextKey ?? projects.get(cwd) ?? null);
  // Debounce worker saves. The timer cannot run during a synchronous transaction.
  // Retain it so the final lifecycle update is not lost at process exit.
  if (!timer) timer = setTimeout(() => { timer = null; flushStateCards(); }, 100);
}
export function flushStateCards(connection = null) {
  for (const [db, projects] of pending) {
    if (connection && db !== connection) continue;
    if (db.isTransaction) throw Error("State card flush inside transaction");
    pending.delete(db);
    for (const [cwd, key] of projects) {
      try { refreshStateCard(db, cwd, key); } catch { /* Recovery advice fails open. */ }
    }
  }
  if (!pending.size && timer) { clearTimeout(timer); timer = null; }
}
