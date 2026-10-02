/** Pinned exec review adapter: read-only launcher, bounded untrusted findings. */
import path from 'node:path';
import { git, changes } from './git.mjs';
import { assertReviewInstructions } from './review-instructions.mjs';
import { validateFindings } from './review-findings.mjs';
import * as PC from './policy-core.mjs';
import * as E from './evidence-budget.mjs';
import { reviewAttempt } from './review-order.mjs';
export function nativeEligibility(state, current) {
  if (state.review?.native === false) return 'Disabled by review.native=false.';
  if (!state.baseline?.available || !state.baseline.head || state.baseline.dirty) return 'Dirty or unavailable baseline; job changes are not exactly uncommitted changes.';
  const paths = new Set([...git(state.executionCwd, ['diff', 'HEAD', '--name-only', '-z']).stdout.split('\0'), ...git(state.executionCwd, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0')].filter(Boolean));
  const jobPaths = changes(state.baseline, current, state.assignment.scope).files;
  if (paths.size !== jobPaths.length || jobPaths.some(f => !paths.has(f))) return 'Job changed paths differ from uncommitted changes.';
  return null;
}
export function nativeArgs(state, buildArgs) {
  const args = buildArgs({ ...state, threadId: null, readOnly: true, assignment: null }, 'unused');
  for (const flag of ['--output-schema', '--output-last-message']) {
    const index = args.indexOf(flag); if (index >= 0) args.splice(index, 2);
  }
  if (args.at(-1) === '-') args.pop();
  args.push('-c', 'project_doc_max_bytes=0', 'review', '--uncommitted');
  return args;
}
/** Verified pinned exec output is plain agent_message text, as captured by the lead. */
export function parseNativeReview(text, state) {
  if (typeof text !== 'string' || text.length > 1024*1024) return {findings:[],droppedNativeFindings:1};
  let candidates = [], json = null;
  if (text.trimStart().startsWith('{')) { try { json = JSON.parse(text); } catch {} }
  if (Array.isArray(json?.findings)) {
    candidates = json.findings.map(f => ({json:f}));
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*- \[P/.test(line)) candidates.push({header:line.trim(),lines:[]});
      else if (candidates.length && (/^\s+\S/.test(line) || !line.trim())) candidates.at(-1).lines.push(line.replace(/^(?: {2}|\t)/,''));
    }
  }
  const findings = [], lineCounts=new Map(); let droppedNativeFindings = 0, validated=0;
  for (const candidate of candidates) {
    if (findings.length>=8 || validated++>=64) {droppedNativeFindings++;continue;}
    try {
      let priority, title, body, location, startLine, endLine, confidence;
      if (candidate.json) {
        const f = candidate.json;
        priority=f.priority;title=f.title;body=f.body;location=f.code_location?.absolute_file_path;
        startLine=f.code_location?.line_range?.start;endLine=f.code_location?.line_range?.end;confidence=f.confidence_score ?? null;
      } else {
        const header=candidate.header;
        if(header.length>600)throw Error('Native header too long.');
        const separator=header.lastIndexOf(' — '), prefix=header.slice(0,7);
        const m=header.slice(separator+3).match(/^(.+):(\d+)-(\d+)$/);
        if(separator<8 || !/^- \[P[0-3]\] $/.test(prefix) || !m)throw Error('Invalid native finding header.');
        priority=Number(prefix[4]);title=header.slice(7,separator);location=m[1];startLine=Number(m[2]);endLine=Number(m[3]);
        body=candidate.lines.join('\n').trim();confidence=null;
      }
      if (!Number.isInteger(priority) || priority<0 || priority>3 || typeof location!=='string') throw Error('Invalid native location/priority.');
      const file=(path.isAbsolute(location) ? path.relative(state.executionCwd,location).replaceAll('\\','/') : location.replaceAll('\\','/')).replace(/^(?:\.\/)+/,'');
      const finding={severity:['critical','high','medium','low'][priority],confidence,file,startLine,endLine,title,body,
        evidence:[file+':'+startLine+'-'+endLine],source:'native'};
      validateFindings([finding],state,{native:true,lineCounts});
      findings.push(finding);
    } catch { droppedNativeFindings++; }
  }
  return {findings,droppedNativeFindings};
}
export function parseNativeFindings(text,state) { return parseNativeReview(text,state).findings; }
export async function runNativeReview(state, current, { runProcess, buildArgs, resolveCodex, directory, timeoutSeconds = 300, retryBusy = async fn => fn() }) {
  try {
    const reason = nativeEligibility(state, current);
    if (reason) return { status: 'skipped', reason };
    const nativeState = { ...state, readOnly: true, threadId: null, execRole: 'reviewer', reviewRunId: 'native', execAttempt: reviewAttempt(state,4) };
    E.assertBudget(nativeState);
    const binary = resolveCodex(), args = nativeArgs(state, buildArgs);
    let final = null, completed = false, failed = false, threadId = null;
    const usageEvents = [];
    assertReviewInstructions(state);
    const outcome = await runProcess(nativeState, binary.command, [...binary.prefix, ...args], {
      input: '', eventsFile: path.join(directory, 'native-review-events.jsonl'), errorFile: path.join(directory, 'native-review-stderr.log'), timeoutSeconds,
      onEvent(event) {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') final = event.item.text;
        if (event.item?.type === 'exitedReviewMode') final = event.item.review;
        if (event.type === 'thread.started') threadId = event.thread_id;
        if (event.type === 'turn.completed') { completed = true; usageEvents.push(event); }
        if (event.type === 'turn.failed' || event.type === 'error') failed = true;
      },
    });
    for (const [index,event] of usageEvents.entries()) {
      const budget = await retryBusy(() => E.recordUsage(nativeState,event,index+1));
      if (budget?.exceeded.length && PC.enforced(state.profile,'budget')) throw Error('Native review budget exhausted.');
    }
    if (outcome.authFailure) throw Object.assign(Error('Native review authentication failure: ' + outcome.authFailure),{code:'auth_expired'});
    if (outcome.durationMs > timeoutSeconds * 1000) throw Error('Native review failed: timed_out');
    if (outcome.stopReason || outcome.parseError || outcome.secretCount || outcome.code !== 0 || failed || !completed) throw Error('Native review failed: ' + (outcome.stopReason || outcome.parseError || (outcome.secretCount ? 'forbidden output' : 'exit/completion failure')));
    if (typeof final !== 'string' || final.length > 1024 * 1024 || PC.scan(final,state.profile).count) throw Error('Native review missing or unsafe final output.');
    const {findings,droppedNativeFindings} = parseNativeReview(final, state);
    if (PC.inspectValue(findings,state.profile).count) throw Error('Native review forbidden content.');
    return { status: 'completed', findings, droppedNativeFindings, threadId, usage: usageEvents.at(-1)?.usage };
  } catch (error) { return { status: 'failed', reason: PC.scan(error.message,state.profile).text.slice(0,500), ...(error.code==='auth_expired' ? {failureKind:'auth_expired'} : {}) }; }
}
