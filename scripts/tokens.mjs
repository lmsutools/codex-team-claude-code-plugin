import { incrementalTranscript } from "./transcript-cache.mjs";
/**
 * Token split between the lead (Claude) and the contributor (Codex).
 *
 * Every number comes from a log, never from a model's guess:
 * - Claude: the session transcript. Each model call records the API's usage,
 *   repeated on every content-block line of that call, so calls are counted
 *   once by message id. Subagent transcripts live next to the session.
 * - Codex: this plugin's job records, which keep the CLI's own usage event.
 *
 * The providers count input differently: Anthropic's input_tokens excludes
 * cache reads and writes, OpenAI's includes its cached tokens. Both are
 * normalized here to all input (new + cache write + cache read), with the
 * cached part kept separately. Thinking/reasoning is part of output for both.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateRoot } from "./state-reader.mjs";
import { projectJobs, attributedJobs, readBounded } from "./observer.mjs";
import { jobExecs, readExecUsage } from "./rollout-usage.mjs";
import { classifySourcePath, recentCodex } from "./delegation-policy.mjs";
import { contextAdvice } from "./context-advisor.mjs";
import { codexTeamTool, resultJobIds, ownerPrompt } from "./session-attribution.mjs";
import { editLineStats } from "./line-stats.mjs";
import { priceUsage } from "./token-prices.mjs";

export const emptyUsage = () => ({ calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });

function add(total, usage) {
  total.calls += 1;
  total.input += usage.input;
  total.cached += usage.cached;
  total.output += usage.output;
  total.reasoning += usage.reasoning;
}

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

export function claudeCallUsage(usage) {
  const cacheRead = count(usage?.cache_read_input_tokens);
  return {
    input: count(usage?.input_tokens) + count(usage?.cache_creation_input_tokens) + cacheRead,
    cached: cacheRead,
    output: count(usage?.output_tokens),
    reasoning: count(usage?.output_tokens_details?.thinking_tokens),
  };
}

export function codexJobUsage(usage) {
  return {
    input: count(usage?.input_tokens),
    cached: count(usage?.cached_input_tokens),
    output: count(usage?.output_tokens),
    reasoning: count(usage?.reasoning_output_tokens),
  };
}

/**
 * Reads one transcript: its model calls in order (deduplicated), when it
 * started, and where the latest response began.
 */
export function readTranscript(text, previous = null) {
  const seen = new Set(previous?._state?.seen || []);
  const jobIds = new Set(previous?.jobIds || []);
  const calls = [...(previous?.calls || [])];
  let firstAt = previous?.firstAt || null;
  let replyFrom = previous?.replyFrom || 0;
  let replyStartAt = previous?.replyStartAt || null;
  const toolUses = new Map(previous?._state?.toolUses || []), successfulEdits = [...(previous?.edits || [])];
  let toolResults = [...(previous?.toolResults || [])], replyIndex = previous?._state?.replyIndex || 0;
  for (const line of String(text).split("\n")) {
    if (!line) continue;
    // Cheap filters before JSON.parse. Tool results are the bulk of a transcript
    // and never start a response; inside prompt text the quotes would be escaped.
    const maybeUser = line.includes('"user"') && !line.includes('"type":"tool_result"');
    const maybeCall = line.includes('"usage"') && line.includes('"assistant"');
    const maybeTool = line.includes('"tool_use"') || line.includes('"tool_result"');
    if (firstAt && !maybeUser && !maybeCall && !maybeTool && !line.includes('compact_boundary')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    firstAt ??= entry.timestamp ?? null;
    if (entry.type === "system" && entry.subtype === "compact_boundary") toolResults = [];
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block.type === "tool_use") toolUses.set(block.id, { ...block, input: ["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(block.name) ? block.input :
        codexTeamTool(block.name) ? Object.fromEntries(["jobId", "batchId", "action"].filter(key => typeof block.input?.[key] === "string").map(key => [key, block.input[key].slice(0, 64)])) : null, at: entry.timestamp ?? null, cwd: entry.cwd, replyIndex });
      if (block.type === "tool_result") {
        const use = toolUses.get(block.tool_use_id);
        toolUses.delete(block.tool_use_id);
        const result = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        const resultText = Array.isArray(block.content) ? block.content.map(b => b.text || "").join("\n") : result;
        toolResults.push({ name: use?.name || block.tool_use_id, characters: result.length });
        if (use && codexTeamTool(use.name) && !block.is_error) for (const id of resultJobIds(block.content, use)) jobIds.add(id);
        if (jobIds.size > 256) throw Error("Session attribution exceeds job bound");
        if (use && ["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(use.name) && !block.is_error &&
          !/^(?:Error\b|Permission denied|Tool use rejected|User denied|<tool_use_error>)/i.test(resultText.trim())) successfulEdits.push({ name: use.name, input: { file_path: use.input?.file_path || use.input?.notebook_path || use.input?.path },
            at: entry.timestamp || use.at, replyIndex: use.replyIndex, cwd: entry.cwd || use.cwd,
            lineStats: editLineStats(use, entry.toolUseResult) });
      }
    }
    if (entry.type === "user" && ownerPrompt(entry)) {
      replyFrom = calls.length;
      replyStartAt = entry.timestamp ?? replyStartAt;
      replyIndex++;
    } else if (entry.type === "assistant" && entry.message?.usage) {
      const id = entry.message.id || entry.requestId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      calls.push({ at: entry.timestamp ?? null, usage: claudeCallUsage(entry.message.usage), model: entry.message.model ?? null,
        cacheWrite: count(entry.message.usage.cache_creation_input_tokens) });
    }
  }
  return { firstAt, calls, replyFrom, replyStartAt, toolResults, jobIds: [...jobIds],
    edits: successfulEdits,
    _state: { seen: [...seen], toolUses: [...toolUses], replyIndex } };
}

/** Subagent transcripts: <dir>/<session>/subagents/*.jsonl next to <dir>/<session>.jsonl. */
export function subagentTranscripts(transcriptPath) {
  const folder = path.join(transcriptPath.replace(/\.jsonl$/i, ""), "subagents");
  try {
    const files=[],dir=fs.opendirSync(folder);let visited=0;
    try {let entry;while((entry=dir.readSync())) {
      if(++visited>4096)throw Error("Subagent directory exceeds bound");
      if(entry.isFile() && entry.name.endsWith(".jsonl"))files.push(path.join(folder,entry.name));
      if(files.length>64)break;
    }} finally {dir.closeSync();}
    return files;
  } catch(error) {
    if(error.code!=="ENOENT")throw error;
    return [];
  }
}

/** Classify at most ten qualifying edits, even when many paths repeat. */
export function successfulSourceEdits(edits, cwd, scratchpad, classify = classifySourcePath) {
  const paths = new Set(); let qualifying = 0;
  for (const edit of edits) {
    let target;
    try { target = classify(edit.input?.file_path || edit.input?.notebook_path || edit.input?.path, edit.cwd || cwd, undefined, scratchpad); } catch {}
    if (target) { paths.add(target); if (++qualifying >= 10) break; }
  }
  return [...paths];
}
/** Read-only job observations; the Stop footer always supplies exact attributed IDs. */
export function codexJobs(stateRoot, cwdOrIds) {
  return (Array.isArray(cwdOrIds) ? attributedJobs(stateRoot, cwdOrIds) : projectJobs(stateRoot, cwdOrIds)).map(state => {
    let doneAt = Date.parse(state.implementationFinishedAt || state.lineStatsAt || state.finishedAt || "") || null;
    if (!doneAt && !["starting", "running", "verifying"].includes(state.status)) try { doneAt = fs.statSync(path.join(stateRoot, state.id, "report.txt")).mtimeMs; } catch {}
    return { ...state, startedAt: Date.parse(state.startedAt ?? "") || null, doneAt,
      execs: jobExecs(state) };
  });
}

const RUNNING = new Set(["starting", "running", "verifying"]);

/**
 * Session totals and the owner's last task: Claude calls since the prompt,
 * Codex execs that finished since it plus cumulative live samples.
 */
export function summarize({ transcript, subagents = [], jobs = [], rolloutOptions = {}, cwd, scratchpad, home }) {
  const lead = { session: emptyUsage(), reply: emptyUsage() };
  const contributor = { session: emptyUsage(), reply: emptyUsage(), sessionJobs: 0, running: 0 };
  const replyStart = Date.parse(transcript.replyStartAt || transcript.firstAt || "") || 0;
  const prices = [], taskPrices = [], windows = [];
  const code={lead:{files:0,added:0,removed:0,unknownFiles:0},contributor:{files:0,added:0,removed:0,unknownFiles:0}};
  const leadPaths=new Set(),unknownPaths=new Set(),contributorPaths=new Set(),edits=[],sourcePaths=new Map();
  let unavailable = 0;
  for(const [index, source] of [transcript,...subagents].entries()) {
    source.calls.forEach((call,i)=>{
      add(lead.session,call.usage);
      const inTask=index===0 ? i>=transcript.replyFrom : (Date.parse(call.at || "") || 0)>=replyStart;
      if(inTask)add(lead.reply,call.usage);
      const entry={provider:"anthropic",role:"lead",model:call.model,usage:call.usage,cacheWrite:call.cacheWrite};
      prices.push(entry);if(inTask)taskPrices.push(entry);
    });
    for(const edit of source.edits || []) {
      if((Date.parse(edit.at || "") || 0)<replyStart)continue;
      edits.push(edit);
      const key=JSON.stringify([edit.cwd || cwd,edit.input?.file_path]);
      if(!sourcePaths.has(key)) {
        let target=null;try{target=classifySourcePath(edit.input?.file_path,edit.cwd || cwd,home,scratchpad);}catch{}
        sourcePaths.set(key,target);
      }
      const file=sourcePaths.get(key);
      if(!file)continue;
      leadPaths.add(file);
      if(edit.lineStats) {code.lead.added+=edit.lineStats.added;code.lead.removed+=edit.lineStats.removed;}
      else unknownPaths.add(file);
    }
  }
  code.lead.files=leadPaths.size;code.lead.unknownFiles=unknownPaths.size;
  for (const job of jobs) {
    contributor.sessionJobs++;
    if (RUNNING.has(job.status)) contributor.running++;
    const doneAt=job.doneAt || Date.parse(job.implementationFinishedAt || job.lineStatsAt || job.finishedAt || "");
    const authoredFinished=(!RUNNING.has(job.status) || !!job.implementationFinishedAt) && !job.readOnly && job.mode!=="scout";
    if(authoredFinished && doneAt>=replyStart) {
      const stats=job.lineStats, target=code.contributor;
      if(!stats || stats.version!==2 || stats.unavailable)target.unknownJobs=(target.unknownJobs || 0)+1;
      else {
        for(const key of ["added","removed","unknownFiles"])target[key]+=count(stats[key]);
        const ids=new Set((Array.isArray(stats.fileIds)?stats.fileIds:[]).slice(0,256).filter(id=>typeof id==="string" && /^[0-9a-f]{64}$/.test(id)));
        for(const id of ids)contributorPaths.add(id);
        if(ids.size<count(stats.files))target.unknownIdentities=(target.unknownIdentities || 0)+count(stats.files)-ids.size;
        target.files=contributorPaths.size;
      }
    }
    // Every exec has its own zero-based counter, including resumes and reviewers.
    for(const exec of job.execs?.length ? job.execs : [{startedAt:new Date(job.startedAt || 0).toISOString(),finishedAt:doneAt ? new Date(doneAt).toISOString() : null,usage:job.usage,model:job.model}]) {
      const sample=readExecUsage(exec,rolloutOptions);
      if(!sample.usage){unavailable++;continue;}
      const usage=codexJobUsage(sample.usage);
      add(contributor.session,usage);
      const inTask=!exec.finishedAt || Date.parse(exec.finishedAt)>=replyStart;
      if(inTask)add(contributor.reply,usage);
      const entry={provider:"openai",role:"contributor",model:sample.model,usage};
      prices.push(entry);if(inTask)taskPrices.push(entry);
      if(sample.rateLimits)windows.push({...sample.rateLimits,sampledAt:sample.sampledAt});
    }
  }
  windows.sort((a,b)=>a.sampledAt-b.sampledAt);
  return {lead,contributor,prices,taskPrices,windows,unavailable,replyUnavailable:0,code,edits};
}

/** "long" (default): only after long responses in sessions that used Codex. */
export function shouldShow(summary, { mode = "long", minCalls = 8 } = {}) {
  const { lead, contributor } = summary;
  if (mode === "off") return false;
  if (summary.alarm?.length) return true;
  if (!lead.reply.calls && !contributor.reply.calls && !contributor.running) return false;
  if (mode === "always") return true;
  if (!contributor.sessionJobs) return false;
  return lead.reply.calls >= minCalls || contributor.reply.calls > 0 || contributor.running > 0;
}

// ── Rendering ──

const sig = (value) => (value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2));
export function formatTokens(value) {
  if (value < 1000) return String(value);
  if (value < 1e6) return sig(value / 1e3) + "k";
  if (value < 1e9) return sig(value / 1e6) + "M";
  return sig(value / 1e9) + "B";
}

export function formatShare(part, total) {
  if (!total || !part) return "0%";
  const share = (part / total) * 100;
  if (share < 1) return "<1%";
  if (share > 99 && part < total) return ">99%";
  return Math.round(share) + "%";
}

/**
 * Lead in solid blocks, contributor in light shade, half-cell precision.
 * A nonzero share never rounds away: each side keeps at least half a cell.
 */
export function splitBar(lead, contributor, width = 30) {
  const total = lead + contributor;
  if (!total) return "·".repeat(width);
  let halves = Math.round((lead / total) * width * 2);
  if (lead > 0) halves = Math.max(halves, 1);
  if (contributor > 0) halves = Math.min(halves, width * 2 - 1);
  const full = Math.floor(halves / 2);
  const half = halves % 2;
  return "█".repeat(full) + (half ? "▌" : "") + "░".repeat(width - full - half);
}

const cleanLine = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g," ");
const fit = text => {const clean=cleanLine(text);return clean.length>110 ? clean.slice(0,109)+"…" : clean;};
export function render(summary) {
  const {lead,contributor}=summary, all=u=>u.input+u.output;
  const l=lead.reply,c=contributor.reply,ls=lead.session,cs=contributor.session;
  const code=summary.code || {lead:{},contributor:{}};
  const linesFor=value=>`+${formatTokens(value.added || 0)}/-${formatTokens(value.removed || 0)}${value.unknownFiles || value.unknownJobs ? "+?" : ""} in ${value.files || 0}${value.unknownJobs || value.unknownIdentities ? "+?" : ""} files`;
  const cost=summary.taskCost;
  const dollars=cost && cost.lead.total!==null && cost.contributor.total!==null && !summary.unavailable && summary.cost?.total!==null;
  const lines=[
    `╭─ Last task · output ${splitBar(l.output,c.output,16)} lead ${formatTokens(l.output)} · Codex ${formatTokens(c.output)}`,
    `│ Code: Codex ${linesFor(code.contributor)} · lead ${linesFor(code.lead)}`,
    dollars ? `│ Cost: lead $${cost.lead.total.toFixed(4)} · Codex $${cost.contributor.total.toFixed(4)} (user prices)` :
      `│ Consumption: lead ${formatTokens(all(l))} · Codex ${formatTokens(all(c))} tokens (price gap; no dollar total)`,
    `│ Re-reads: lead ${formatTokens(l.cached)} · Codex ${formatTokens(c.cached)}`,
    `│ Session: output lead ${formatTokens(ls.output)} (${formatShare(ls.output,ls.output+cs.output)}) · Codex ${formatTokens(cs.output)} (${formatShare(cs.output,ls.output+cs.output)}); consumption ${formatTokens(all(ls))} / ${formatTokens(all(cs))}`,
    `│ Lead shell edits are not visible; ? = unknown lines/files.${contributor.running ? ` ${contributor.running} Codex running.` : !contributor.sessionJobs ? " No Codex jobs." : ""}`,
  ];
  if(summary.unavailable)lines.push(`│ Codex usage unavailable for ${summary.unavailable} exec(s); totals are partial.`);
  if(summary.replyUnavailable)lines.push(`│ Last-task usage unavailable for ${summary.replyUnavailable} exec(s); totals are partial.`);
  for(const [name,v] of Object.entries(summary.windows?.at(-1) || {}).filter(([,v])=>v && typeof v==="object" && Number.isFinite(v.used_percent)).slice(0,2))
    lines.push(`│ Codex rate window ${name}: ${v.used_percent}% used / ${v.window_minutes} min · resets ${new Date(v.resets_at*1000).toLocaleString()} · seen ${new Date(summary.windows.at(-1).sampledAt || 0).toISOString().slice(11,16)}Z`);
  if(summary.alarm?.length)lines.push(`│ Delegation alarm: lead edited source: ${summary.alarm.map(file=>path.basename(file)).join(", ")}`);
  if(summary.context) {
    const x=summary.context;
    lines.push(`│ Context/call ${formatTokens(x.context)} · next 10 calls ≈ ${formatTokens(x.projectedInput)} input (constant context)`);
    lines.push(`│ Largest tool results (chars / 4): ${x.top.map(t=>`${String(t.name).slice(0,22)} ≈${formatTokens(Math.ceil(t.characters/4))}`).join("; ") || "none"}`);
    if(x.advice) {
      lines.push(`│ Reset break-even: ${x.expectedCalls} calls · reset size ${x.resetSize} · reset cost ${formatTokens(x.resetCost)} input`);
      lines.push(`│ ${x.advice==="/clear" ? "/clear" : "/compact Keep state card, decisions, next steps, findings and rules"}${x.liveJobs?.length ? `; ${x.liveJobs.length} live jobs retained` : ""}`);
    }
  }
  if(lines.length>14 && summary.replyUnavailable)lines.splice(7,1);
  return lines.slice(0,14).map(fit).join("\n");
}

/** The whole hook: read the logs for this session and return the summary text, or null. */
export function tokenSummary(input, env = process.env, root = stateRoot()) {
  const mode = String(env.CODEX_TEAM_TOKENS || "long").toLowerCase();
  if (mode === "off" || typeof input?.transcript_path !== "string") return null;
  const minCalls = Number.parseInt(env.CODEX_TEAM_TOKENS_MIN_CALLS ?? "", 10);
  const transcript = incrementalTranscript(input.transcript_path, root, readTranscript);
  if (transcript.historyIncomplete) return null; // Never label a first-sight tail as complete session totals.
  const subagents = [];
  let cachedBytes = JSON.stringify(transcript).length;
  const transcriptDeadline = Date.now() + 700;
  const subagentFiles = subagentTranscripts(input.transcript_path);
  if (subagentFiles.length > 64) return null;
  for (const file of subagentFiles) {
    if (Date.now() > transcriptDeadline) return null;
    const read = incrementalTranscript(file, root, readTranscript);
    cachedBytes += JSON.stringify(read).length;
    if (cachedBytes > 8 * 1024 * 1024) return null;
    if (read.historyIncomplete) return null;
    subagents.push(read);
  }
  const ids=[...new Set([transcript,...subagents].flatMap(t=>t.jobIds || []))];
  if(ids.length>256 || [transcript,...subagents].some(t=>t.historyGap))return null;
  const jobs = codexJobs(root, ids);
  const summary = summarize({ transcript, subagents, jobs, cwd:input.cwd, scratchpad:input.scratchpad_dir || env.CLAUDE_CODE_SCRATCHPAD_DIR, rolloutOptions: { home: env.CODEX_HOME, deadline: Date.now() + 1200 } });
  summary.unavailable += ids.length - jobs.length;
  summary.contributor.sessionJobs = ids.length;
  summary.alarm = summary.contributor.sessionJobs || (summary.edits.length && projectJobs(root, input.cwd, "guard").some(j => recentCodex(j)))
    ? successfulSourceEdits(summary.edits, input.cwd, input.scratchpad_dir || env.CLAUDE_CODE_SCRATCHPAD_DIR) : [];
  summary.context = contextAdvice(transcript, jobs.map(j => ({ ...j, startedAt: new Date(j.startedAt).toISOString() })));
  let prices = null;
  try { prices = JSON.parse(readBounded(path.join(os.homedir(), ".claude", "codex-team", "prices.json"), 65536).text); } catch {}
  summary.cost = priceUsage(summary.prices, prices);
  summary.taskCost = Object.fromEntries(["lead","contributor"].map(role=>[role,priceUsage(summary.taskPrices.filter(e=>e.role===role),prices)]));
  const long = { mode, minCalls: Number.isFinite(minCalls) && minCalls > 0 ? minCalls : 8 };
  return shouldShow(summary, long) ? render(summary) : null;
}

// Skip irrelevant streaming chunks before allocating their text; timestamps and all
// event families consumed above remain eligible.
readTranscript.cacheVersion = 1212;
readTranscript.acceptsChunk = bytes => ['"timestamp"', '"user"', '"assistant"', '"tool_use"', '"tool_result"', 'compact_boundary'].some(word => bytes.includes(word));
