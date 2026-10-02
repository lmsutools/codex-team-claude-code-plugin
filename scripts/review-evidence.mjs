/** Bounded heuristic evidence floor, not a security boundary. Prose is not a read. */
import path from 'node:path';
import fs from 'node:fs';
import {readJob,jobDirectory} from './state-reader.mjs';
import { safeFile } from './git.mjs';
import { lineCount } from './review-findings.mjs';
import { boundedBytes } from './baseline-bytes.mjs';
export function readEvents(file,limit=32*1024*1024) {
  try {
    const text=boundedBytes(file,limit).toString('utf8'),events=[];
    let start=0;
    while(start<text.length && events.length<4096) {
      const newline=text.indexOf('\n',start),end=newline<0 ? text.length : newline;
      const line=text.slice(start,end).trim();start=end+1;
      if(line)events.push(JSON.parse(line));
    }
    return events;
  } catch { return []; }
}
export function scoutThreadEvents(state) {
  const events=[],seen=new Set(),thread=state.threadId,cwd=state.executionCwd;
  let remaining=32*1024*1024;
  for(let n=0;state && n<64 && events.length<4096 && remaining>0 && !seen.has(state.jobId);n++) {
    seen.add(state.jobId);
    try {
      const directory=jobDirectory(state.jobId);
      const names=fs.readdirSync(directory).filter(name=>name==='events.jsonl' || /^exec-\d+-events\.jsonl$/.test(name)).sort().slice(0,16);
      for(const name of names) {
        if(events.length>=4096 || remaining<=0)break;
        const file=path.join(directory,name),size=fs.statSync(file).size;
        events.push(...readEvents(file,remaining).slice(0,4096-events.length));remaining-=size;
      }
    } catch {}
    if(!thread || !state.resumeJobId) break;
    try {state=readJob(state.resumeJobId);} catch {break;}
    if(state.threadId!==thread || state.executionCwd!==cwd) break;
  }
  return events;
}
const normalize = value => value.replaceAll('\\','/');
const executable = value => normalize(value || '').split('/').at(-1).toLowerCase().replace(/\.exe$/,'');
// Keep separators inside quoted data out of the command stream: echo/Write-Output
// containing a quoted "cat file; ..." is not a read.
function segments(text) {
  const parts=[];let start=0,quote=null;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='`' || (c==='\\' && /["'\\;|&]/.test(text[i+1] || ''))) {i++;continue;}
    if(quote) {if(c===quote) {if(text[i+1]===quote)i++;else quote=null;}continue;}
    if(c==='"' || c==="'") {quote=c;continue;}
    if(c==='#' && (i===0 || /\s/.test(text[i-1]))) {
      parts.push(text.slice(start,i));const next=text.indexOf('\n',i);if(next<0)return parts;i=next;start=i+1;continue;
    }
    if(c===';' || c==='|' || c==='\n' || (c==='&' && text[i+1]==='&')) {
      parts.push(text.slice(start,i));if(text[i+1]===c)i++;start=i+1;
    }
  }
  parts.push(text.slice(start));return parts;
}
function tokens(text) {
  const result=[];let quote=null,value='',start=-1;
  const flush=end=>{if(start>=0)result.push({value,start,end});value='';start=-1;};
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(!quote && /\s/.test(c)) {flush(i);continue;}
    if(start<0)start=i;
    if(c==='`' && i+1<text.length) {value+=text[++i];continue;}
    if(quote) {if(c===quote){if(text[i+1]===quote){value+=c;i++;}else quote=null;}else value+=c;}
    else if(c==='"' || c==="'")quote=c;
    else value+=c;
  }
  flush(text.length);return result;
}
function unwrap(command) {
  let text=String(command || '').trim();
  for(let depth=0;depth<4;depth++) {
    const args=tokens(text),exe=executable(args[0]?.value);
    const flag=args.findIndex((arg,i)=>i>0 && (
      (['pwsh','powershell'].includes(exe) && /^-(?:command|c)$/i.test(arg.value)) ||
      (exe==='cmd' && /^\/c$/i.test(arg.value)) ||
      (['bash','sh'].includes(exe) && /^-[lc]*c[lc]*$/.test(arg.value))));
    if(flag<0)break;
    text=text.slice(args[flag].end).trim();
    if((text[0]==='"' || text[0]==="'") && text.at(-1)===text[0])text=text.slice(1,-1);
  }
  return text;
}
const readers=new Set(['get-content','gc','cat','type','more','head','tail','sed','awk','less']);
const searches=new Set(['rg','grep','select-string','sls','findstr']);
// Conservative heuristic, not an execution/security boundary. Shell aliases,
// functions, redirections and manufactured search output cannot prove a read.
const nameOnly=/^(?:--(?:name-only|name-status|stat|numstat|shortstat|files|files-with-matches|files-without-match|count)(?:=.*)?|-[lcL]|-List|-Quiet)$/i;
function readsIn(command) {
  const text=unwrap(command);
  if (/\b(?:function|Set-Alias|New-Alias|alias|Out-Null)\b|[\w-]+\s*\(\)\s*\{|>\s*["']?(?:\/dev\/null|\$null|nul)\b/i.test(text)) return [];
  const parts=segments(text).map(segment=>tokens(unwrap(segment)).map(t=>t.value));
  const prints=parts.some(argv=>/^(?:echo|printf|write-output|write-host|out-host)$/i.test(executable(argv[0])));
  const reads=[];
  for(const argv0 of parts) {
    const argv=[...argv0],exe=executable(argv.shift());
    if(argv.some(a=>nameOnly.test(a) || (['rg','grep','head','tail','git'].includes(exe) && /^-[^-]*[lcL][^-]*$/.test(a))))continue;
    if (argv.some((a,i)=>/^(?:-n0|--(?:lines|bytes)=0)$/.test(a) || (/^(?:-n|--lines|--bytes|-TotalCount|-First|-Head)$/i.test(a) && argv[i+1]==='0')))continue;
    if(readers.has(exe)) {reads.push({args:argv,search:false});continue;}
    let search=searches.has(exe);
    if(exe==='git') {
      if(argv[0]?.startsWith('-'))continue;
      const sub=argv.shift()?.toLowerCase();
      if(!['show','diff','log','blame','grep'].includes(sub))continue;
      if(sub==='log' && !argv.some(a=>a==='-p' || a==='--patch'))continue;
      search=sub==='grep';
      if(!search) {
        const separator=argv.indexOf('--');
        const paths=separator>=0 ? argv.slice(separator+1) : argv.filter(a=>!a.startsWith('-') && !/^(?:HEAD|main|master|refs\/[^:]+|[a-f0-9]{7,40})(?:[~^]\d*)?$/.test(a) && !a.includes('..'));
        reads.push({args:paths.map(a=>/^[a-z]:[/\\]/i.test(a) ? a : a.replace(/^[^/\\:]+:/,'')),search:false});
        continue;
      }
    }
    if(!search || prints || parts.length!==1 || argv.includes('-') || argv.some(a=>/^-InputObject$/i.test(a)))continue;
    // Skip the pattern and option values; stdin-only searches have no paths.
    const paths=[];let pattern=false;
    for(let i=0;i<argv.length;i++) {
      const a=argv[i];
      if (/^(?:-e|--regexp|-Pattern)$/i.test(a)) {pattern=true;i++;continue;}
      if (/^(?:-g|--glob|-t|--type|-A|-B|-C|-m|--max-count|--encoding)$/i.test(a)) {i++;continue;}
      if (a.startsWith('-'))continue;
      if (!pattern) {pattern=true;continue;}
      if (a!=='-')paths.push(a);
    }
    if(paths.length)reads.push({args:paths,search:true});
  }
  return reads;
}
const evidenceKey=value=>process.platform==='win32' ? normalize(value).toLowerCase() : normalize(value);
export function fileReads(events, files, cwd, copies = []) {
  const reads=new Set(), aliases=new Map(), absolute=new Map();
  const add=(name,file)=>{if(name)aliases.set(evidenceKey(name),file);};
  for(const file of files) {
    add(file,file);add('./'+file,file);add(path.resolve(cwd,file),file);
    absolute.set(file,evidenceKey(path.resolve(cwd,file)));
  }
  for(const copy of copies) {if(absolute.has(copy.file)){add(copy.beforePath,copy.file);add(copy.afterPath,copy.file);}}
  // Bound both legacy log evaluation and work per event. Normalize once, then
  // intersect maps; never split a search output once for every baseline file.
  for(const event of events.slice(0,4096)) {
    const item=event.type==='item.completed' ? event.item : null;
    if(!item || item.type!=='command_execution' || item.exit_code!==0 || item.status!=='completed')continue;
    const command=String(item.command || '');
    if(command.length>8192)continue; // A truncated suffix could redirect or redefine a reader.
    const commands=readsIn(command);
    if(!commands.length)continue;
    let names;
    for(const command of commands) {
      const args=command.args.map(evidenceKey);
      if(!command.search) {for(const arg of args){const file=aliases.get(arg);if(file)reads.add(file);}continue;}
      if(!names) {
        names=new Set();
        for(const line of String(item.aggregated_output || '').slice(0,65536).split(/\r?\n/)) {
          const name=evidenceKey(line.trim().replace(/^>\s*/,''));
          // Drive colons are retained; only a numeric line/column suffix or
          // a tab separates a search filename from its own output.
          const prefix=name.split(/:\d+(?::|[-: ]|$)|\t/)[0];
          let file=aliases.get(prefix);
          // Plain rg/grep output need not include line numbers. Look up a small
          // number of colon prefixes, preserving the Windows drive colon.
          for(let at=name.indexOf(':'),n=0;!file && at>=0 && n<4;n++,at=name.indexOf(':',at+1))file=aliases.get(name.slice(0,at));
          if(file)names.add(file);
        }
      }
      const exact=new Set(args.map(a=>aliases.get(a)).filter(Boolean));
      const dirs=args.filter(a=>!aliases.has(a)).map(a=>evidenceKey(path.resolve(cwd,a)).replace(/\/$/,'')+'/');
      for(const file of names)if(exact.has(file) || dirs.some(dir=>absolute.get(file).startsWith(dir)))reads.add(file);
    }
  }
  return reads;
}
export function reviewerEvidenceFloor(report, hunks, events, state) {
  if (hunks.inline !== false) return 'passed';
  const files = state.changes?.files || hunks.files?.map(f => f.file) || [];
  const reads = fileReads(events, files, state.executionCwd, hunks.files);
  let failed = false;
  const citedFiles = item => [...new Set([...(item.hunks || []).map(h => h.file), ...(item.file ? [item.file] : []), ...(item.evidence instanceof Array ? item.evidence : []).map(c => c.match(/^(.+):\d+(?:-\d+)?$/)?.[1]).filter(Boolean)])].filter(f => files.includes(f));
  for (const verdict of report.criteria) {
    const cited = citedFiles(verdict);
    verdict.evidenceFloor = reads.size && cited.every(file => reads.has(file)) ? 'passed' : 'failed';
    failed ||= verdict.evidenceFloor === 'failed';
  }
  for (const finding of report.findings || []) if (!citedFiles(finding).every(file => reads.has(file))) failed = true;
  return failed || !reads.size ? 'failed' : 'passed';
}
export function scoutEvidenceFloor(state, brief, events) {
  // Earlier execs, including archived automatic resumes, remain evidence.
  const files = [...new Set([...Object.keys(state.attemptBaseline?.files || state.baseline?.files || {}), ...(brief?.files || []).map(f=>f.path)])];
  const reads = fileReads(events, files, state.executionCwd, [], {changedFiles:state.changes?.files || []});
  const citation = (brief?.files || []).some(file => {
    try { safeFile(state.executionCwd,file.path); const count = lineCount(state,file.path); return file.lines.some(r => r.startLine >= 1 && r.endLine >= r.startLine && r.endLine <= count); } catch { return false; }
  });
  return reads.size && citation ? { version: 2, status: 'passed' } : { version: 2, status: 'failed', reason: 'no-evidence' };
}
