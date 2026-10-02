/** Optional 1.2 review settings, validated findings and lead dispositions. */
import * as C from './contracts.mjs';
import { boundedBytes, inScope } from './baseline-bytes.mjs';
import { safeFile } from './git.mjs';
import { forbidden } from './policy-core.mjs';
export function reviewOptions(value = {}, previous = {}) {
  C.object(value, 'review options', ['native', 'mode', 'focus', 'maxReviewers']);
  const options = { native: true, mode: 'standard', focus: [], maxReviewers: 4, ...previous, ...value };
  if (typeof options.native !== 'boolean') throw Error('review.native must be boolean.');
  if (!['standard', 'adversarial'].includes(options.mode)) throw Error('Invalid review.mode.');
  C.integer(options.maxReviewers, 'review.maxReviewers', 1, 4);
  if (!Array.isArray(options.focus) || options.focus.length > 10) throw Error('review.focus allows at most 10 attack surfaces.');
  options.focus.forEach(v => C.text(v, 'review.focus', 200));
  return options;
}
export function lineCount(state, file, cache) {
  if(cache?.has(file))return cache.get(file);
  C.relative(file);
  if (file === '.') throw Error('Finding must cite a file.');
  if (forbidden(state.profile,state.executionCwd || state.cwd,file)) throw Error('Finding references a forbidden file.');
  const bytes=boundedBytes(safeFile(state.executionCwd || state.cwd,file),32*1024*1024);
  let count=bytes.length && bytes.at(-1)!==10 ? 1 : 0;
  for(const byte of bytes)if(byte===10)count++;
  cache?.set(file,count);return count;
}
export function validateRange(state, file, startLine, endLine, cache) {
  C.relative(file);
  if (!inScope(file, state.assignment.scope)) throw Error('Finding file is out-of-scope.');
  C.integer(startLine, 'startLine', 1, lineCount(state, file, cache));
  C.integer(endLine, 'endLine', startLine, lineCount(state, file, cache));
}
export function validateFindings(findings = [], state, { limit = 8, native = false, lineCounts = new Map() } = {}) {
  if (!Array.isArray(findings) || findings.length > limit) throw Error('At most ' + limit + ' findings allowed.');
  for (const f of findings) {
    C.object(f, 'finding', ['severity', 'confidence', 'file', 'startLine', 'endLine', 'title', 'body', 'evidence', ...(native ? ['source'] : [])]);
    if (native && f.source !== 'native') throw Error('Native findings require source native.');
    if (!['critical', 'high', 'medium', 'low'].includes(f.severity)) throw Error('Invalid finding severity.');
    if (!(native && f.confidence === null) && (typeof f.confidence !== 'number' || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1)) throw Error('Invalid finding confidence.');
    validateRange(state, f.file, f.startLine, f.endLine, lineCounts);
    C.text(f.title, 'finding title', 120); C.text(f.body, 'finding body', 1500);
    if (!Array.isArray(f.evidence) || !f.evidence.length || f.evidence.length > 20) throw Error('Every finding requires evidence citations.');
    for (const citation of f.evidence) {
      C.text(citation, 'finding citation', 1100);
      if (state.verification?.checks?.some(c => c.id === citation && c.status === 'passed' && c.exitCode === 0)) continue;
      const m = citation.match(/^(.+):(\d+)(?:-(\d+))?$/);
      if (!m) throw Error('Finding citation must be file:line-range or a passed check ID.');
      validateRange(state, m[1], Number(m[2]), Number(m[3] || m[2]), lineCounts);
    }
  }
  return findings;
}
export { mergeFindings } from './review-order.mjs';
// Reviews are secret-scanned prose containers; numeric binding bytes cannot be
// mistaken for model secrets by a profile's hex-string redaction pattern.
export function findingPacketBinding(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? Array.from(Buffer.from(hash,'hex')) : hash;
}
const bindingKey = hash => JSON.stringify(findingPacketBinding(hash));
export function findingDispositions(state, supplied = [], accepting = false) {
  if (!Array.isArray(supplied) || supplied.length > 40) throw Error('Invalid findingDispositions.');
  const findings = state.decisionPacket?.findings || [], seen = new Set();
  for (const d of supplied) {
    C.object(d, 'finding disposition', ['findingIndex', 'disposition', 'observation']);
    C.integer(d.findingIndex, 'findingIndex', 0, findings.length - 1);
    if (seen.has(d.findingIndex)) throw Error('Duplicate finding disposition.');
    seen.add(d.findingIndex);
    if (!['not-a-defect', 'accepted-risk', 'fixed'].includes(d.disposition)) throw Error('Invalid finding disposition.');
    C.text(d.observation, 'finding observation', 1500);
  }
  const prior = (state.reviews || []).filter(r => state.findingPacketHash && bindingKey(r.findingPacketHash) === bindingKey(state.findingPacketHash)).flatMap(r => r.findingDispositions || []);
  const resolved = new Set([...prior, ...supplied].map(d => d.findingIndex));
  if (accepting && findings.some((f,i) => ['critical','high'].includes(f.severity) && (f.confidence >= 0.5 || (f.source === 'native' && f.confidence === null)) && !resolved.has(i)))
    throw Error('Lead findingDispositions required for unresolved critical/high findings with confidence >= 0.5 or unknown native confidence.');
  return supplied;
}
