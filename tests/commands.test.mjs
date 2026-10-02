/** Hook/CLI tests never use a real model or modify hook registration. */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import * as S from '../scripts/store.mjs';
import {git} from '../scripts/git.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-team-commands-')),cwd=path.join(root,'project');fs.mkdirSync(cwd);git(cwd,['init','-q']);
process.env.CODEX_TEAM_STATE=path.join(root,'state');
const script=fileURLToPath(new URL('../scripts/commands.mjs',import.meta.url));
const call=(prompt,extra={})=>spawnSync(process.execPath,['--no-warnings',script],{input:JSON.stringify({cwd,prompt}),encoding:'utf8',windowsHide:true,env:process.env,...extra});
const reason=prompt=>{const out=call(prompt);assert.equal(out.status,0,out.stderr);assert.ok(out.stdout.length<=8000);const value=JSON.parse(out.stdout);assert.deepEqual(Object.keys(value),['decision','reason']);assert.equal(value.decision,'block');return value.reason;};
after(()=>{S.closeStores();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
function save(extra={}) {const state={jobId:randomUUID(),cwd,status:'implementation_finished',startedAt:new Date().toISOString(),...extra};S.save(state);return state;}
test('non-matching fast path has no output and median startup under 150 ms',t=>{
 const elapsed=[];
 for(let i=0;i<11;i++){const at=performance.now(),out=call('ordinary prompt /codex-team:status');elapsed.push(performance.now()-at);assert.equal(out.status,0);assert.equal(out.stdout,'');assert.equal(out.stderr,'');}
 const median=elapsed.sort((a,b)=>a-b)[5];t.diagnostic(`non-matching median ${median.toFixed(1)} ms (11 samples; 150 ms generous bound)`);assert.ok(median<150,`median ${median} ms`);
 for(const prompt of ['/codex-team:statusExtra','/other:status','text'])assert.equal(call(prompt).stdout,'');
});
test('status resolves the Git root, scopes jobs, reports candidates and avoids the write lock',()=>{
 const one=save({jobId:'aaaa1111-1111-1111-1111-111111111111'}),two=save({jobId:'aaaa2222-2222-2222-2222-222222222222'});save({cwd:root,jobId:'bbbb1111-1111-1111-1111-111111111111'});
 const nested=path.join(cwd,'nested');fs.mkdirSync(nested);
 const db=new DatabaseSync(path.join(process.env.CODEX_TEAM_STATE,'state.sqlite'));db.exec('BEGIN IMMEDIATE');
 try {
  const output=reason('/codex-team:status');assert.match(output,/aaaa1111/);assert.ok(!output.includes('bbbb1111'));
  assert.match(reason('/codex-team:status aaaa'),/Ambiguous/);assert.match(reason('/codex-team:status unknown'),/Unknown/);assert.match(reason('/codex-team:result'),/Missing/);
  assert.match(reason('/codex-team:status aaaa1'),/implementation_finished/);
  assert.match(JSON.parse(call('/codex-team:status',{input:JSON.stringify({cwd:nested,prompt:'/codex-team:status'})}).stdout).reason,/aaaa2222/);
 } finally {db.exec('ROLLBACK');db.close();}
});
test('result is bounded and labeled untrusted; CLI prints the same plain text',()=>{
 const state=save({result:{summary:'x'.repeat(9000)},decisionPacket:{status:'ready',text:'z'.repeat(9000)}}),prompt='/codex-team:result '+state.jobId;
 const text=reason(prompt);assert.ok(text.length<=6000);assert.match(text,/UNTRUSTED TEXT WRITTEN BY CODEX/);assert.match(text,/ready/);assert.ok(!text.includes('xxxx'));
 const cli=spawnSync(process.execPath,['--no-warnings',script,'--cli','result',state.jobId],{cwd,encoding:'utf8',windowsHide:true,env:process.env});assert.equal(cli.status,0);assert.equal(cli.stdout.trimEnd(),text);
 const legacy=save();fs.mkdirSync(S.jobDir(legacy.jobId),{recursive:true});fs.writeFileSync(path.join(S.jobDir(legacy.jobId),'report.txt'),'Legacy report summary');
 assert.match(reason('/codex-team:result '+legacy.jobId),/Legacy report summary/);
 const escaped=save({result:{summary:'\\'.repeat(12000)}});assert.match(reason('/codex-team:result '+escaped.jobId),/UNTRUSTED TEXT WRITTEN BY CODEX/);
});
test('cancel requests exactly the active project job cancellation; stats and errors block',()=>{
 const job=save({status:'running',workerPid:process.pid,heartbeatAt:new Date().toISOString()});fs.mkdirSync(S.jobDir(job.jobId),{recursive:true});
 assert.match(reason('/codex-team:cancel '+job.jobId.slice(0,12)),/"cancellationRequested":true/);assert.ok(fs.existsSync(path.join(S.jobDir(job.jobId),'cancel')));
 assert.match(reason('/codex-team:stats'),/No run statistics yet/);
 const failed=call('/codex-team:status',{input:JSON.stringify({cwd:path.join(root,'missing'),prompt:'/codex-team:status'})});assert.equal(failed.status,0);const error=JSON.parse(failed.stdout);assert.equal(error.decision,'block');assert.ok(!error.reason.includes('\n    at '));
 S.patch(job.jobId,{status:'cancelled'});
});
test('command fallback frontmatter and opt-in hook registration',()=>{
 for(const name of ['status','result','cancel','stats']) {
  const text=fs.readFileSync(new URL('../commands/'+name+'.md',import.meta.url),'utf8');assert.match(text,/description:/);assert.match(text,/disable-model-invocation: true/);assert.ok(!text.split(/\r?\n/).some(line=>line.includes('!`') && line.includes('$ARGUMENTS')));
  if(['status','stats'].includes(name)){assert.ok(text.includes('!`node'));assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}'));assert.match(text,/verbatim/);}
  else {assert.ok(!text.includes('!`'));assert.ok(text.includes('$ARGUMENTS'));assert.ok(text.includes(name==='result'?'codex_status':'codex_cancel'));}
 }
 assert.ok(!fs.readFileSync(new URL('../hooks/hooks.json',import.meta.url),'utf8').includes('commands.mjs'));
});


test('S9: status bounds large-row listings and only reads the selected full row',()=>{
 const insert=S.db().prepare('INSERT INTO jobs(id,cwd,created,state) VALUES(?,?,?,?)');
 const ids=[];
 for(let i=0;i<120;i++) {
  const id=randomUUID();ids.push(id);
  // These large legacy rows would fail readJob identity validation if hydrated.
  insert.run(id,S.key(cwd),new Date(Date.now()+i*1000).toISOString(),JSON.stringify({jobId:'not-the-row-id',status:'failed',baseline:{text:'x'.repeat(100000)}}));
 }
 const at=performance.now(),listing=reason('/codex-team:status');
 assert.equal(listing.split('\n').length,30);assert.match(listing,new RegExp(ids.at(-1)));assert.ok(performance.now()-at<3000);
 const chosen=save({result:{summary:'selected report'}});
 assert.match(reason('/codex-team:status '+chosen.jobId),/implementation_finished/);
 assert.match(reason('/codex-team:result '+chosen.jobId),/selected report/);
 assert.match(reason('/codex-team:status '+ids[0]),/Unreadable job state/);
});
