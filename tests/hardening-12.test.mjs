/** Job H regressions use isolated state and the fake CLI only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {statusLines} from '../scripts/statusline.mjs';
import {fixture,S,R} from './job-b-fixture.mjs';
import {captureVisibility,finishVisibility} from '../scripts/visibility.mjs';
import {liveWatchers} from '../scripts/watchers.mjs';
import {incrementalTranscript} from '../scripts/transcript-cache.mjs';
import {classifyFailure,versionHint} from '../scripts/diagnostics.mjs';
import {checkEnvironment,shellEnvironmentPolicy} from '../scripts/host-security.mjs';
import {snapshot,hash,git} from '../scripts/git.mjs';
import {reportTool,pushTool} from '../scripts/delivery.mjs';
import {compactResult} from '../scripts/tool-output.mjs';
import {draftHash} from '../scripts/report-preview.mjs';
const F=fixture('hardening-12');
const control=value=>{const file=path.join(F.root,randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify(value));process.env.CODEX_TEAM_FAKE_RECOVERY=file;return file;};

test('H9: noisy commands do not consume the ignored path cap',()=>{
 const cwd=F.project(),dir=path.join(F.root,'visibility');fs.mkdirSync(dir);
 fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\nnode_modules/\n');
 fs.mkdirSync(path.join(cwd,'node_modules'));fs.writeFileSync(path.join(cwd,'node_modules/one'),'before');
 captureVisibility({executionCwd:cwd},dir);
 const commands=Array.from({length:200},()=>Array.from({length:20},(_,i)=>'noise'+i).join(' '));commands.push('Set-Content node_modules/one changed');
 const result=finishVisibility({executionCwd:cwd},dir,commands);
 assert.ok(result.hiddenChanges.entries.some(e=>e.file==='node_modules/one' && e.kind==='reported'));
});
test('H10: stale watchers are deleted and do not hide a live watcher',()=>{
 const root=path.join(F.root,'watcher-test'),dir=path.join(root,'watchers'),id=randomUUID();fs.mkdirSync(dir,{recursive:true});
 for(let i=0;i<1050;i++)fs.writeFileSync(path.join(dir,`${id}.${i}.json`),JSON.stringify({jobId:id,pid:process.pid,until:new Date(0).toISOString()}));
 fs.writeFileSync(path.join(dir,`${id}.live.json`),JSON.stringify({jobId:id,pid:process.pid,until:new Date(Date.now()+60000).toISOString()}));
 const db=new DatabaseSync(path.join(root,'state.sqlite'));db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,cwd TEXT,created TEXT,state TEXT)');
 const job={jobId:id,cwd:F.root,status:'running',startedAt:new Date().toISOString()};db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(id,S.key(F.root),job.startedAt,JSON.stringify(job));db.close();
 assert.match(statusLines({cwd:F.root},{root}),/Claude checks \d{2}:\d{2}/);
 assert.equal(liveWatchers(root,id).length,1);assert.equal(fs.readdirSync(dir).length,1);
});
test('H12: a 6 MiB line becomes a gap; later totals remain incremental',()=>{
 const file=path.join(F.root,'transcript.jsonl'),root=path.join(F.root,'cache');
 const parse=(text,value={tokens:0})=>{value ||= {tokens:0};for(const line of text.trim().split('\n').filter(Boolean))value.tokens+=JSON.parse(line).tokens || 0;return value;};
 fs.writeFileSync(file,JSON.stringify({tokens:2})+'\n'+JSON.stringify({text:'x'.repeat(6*1048576)})+'\n'+JSON.stringify({tokens:3})+'\n');
 let value=incrementalTranscript(file,root,parse);assert.equal(value.historyIncomplete,true);
 value=incrementalTranscript(file,root,parse);assert.equal(value.historyIncomplete,false);assert.equal(value.historyGap,true);assert.equal(value.tokens,5);
 fs.appendFileSync(file,JSON.stringify({tokens:7})+'\n');value=incrementalTranscript(file,root,parse);assert.equal(value.tokens,12);assert.equal(value.historyIncomplete,false);
});
test('H14/R5: CODEX_HOME is excluded from check commands and CLI shell policy',()=>{
 assert.equal(checkEnvironment({CODEX_HOME:F.root,OPENAI_API_KEY:'never'}).CODEX_HOME,undefined);
 assert.equal(checkEnvironment({CODEX_HOME:F.root,OPENAI_API_KEY:'never'}).OPENAI_API_KEY,undefined);
 assert.doesNotMatch(shellEnvironmentPolicy().join(' '),/CODEX_HOME/);
});
test('sandbox classification rejects printed fixture content but accepts own setup errors',async t=>{
 t.after(()=>delete process.env.CODEX_TEAM_FAKE_RECOVERY);
 const embedded=fs.readFileSync(new URL('./fake-codex.mjs',import.meta.url),'utf8');
 assert.equal(classifyFailure(embedded,{source:'command'}),null);
 assert.equal(classifyFailure('helper_unknown_error: setup refresh had errors',{source:'command'}).code,'sandbox_setup_failed');
 control({command:'Get-Content tests/fake-codex.mjs; exit 1',commandExitCode:1,commandOutput:embedded});
 const job=F.start(F.project(),{prompt:'WRITE_CODE'}),done=await F.done(job);assert.equal(done.status,'implementation_finished');assert.equal(done.runtimeFailure,null);
 assert.notEqual(R.doctor({cwd:job.cwd}).sandbox.status,'blocked');
 control({runs:true,auth:'helper_unknown_error: setup refresh had errors',authEvent:true});
 const failed=await F.done(F.start(F.project()));assert.equal(failed.status,'blocked_runtime');assert.equal(failed.runtimeFailure.code,'sandbox_setup_failed');
 delete process.env.CODEX_TEAM_FAKE_RECOVERY;
});
test('doctor 0.157.x setup-refresh hint is version and failure specific',t=>{
 const cwd=F.project(),file=path.join(F.root,'probe.json');fs.writeFileSync(file,JSON.stringify({mode:'fail'}));
 process.env.CODEX_TEAM_FAKE_PROBE=file;process.env.CODEX_TEAM_FAKE_VERSION='codex-cli 0.157.2';
 t.after(()=>{delete process.env.CODEX_TEAM_FAKE_PROBE;delete process.env.CODEX_TEAM_FAKE_VERSION;});
 assert.match(R.doctor({cwd,probe:true}).hint,/CODEX_TEAM_CODEX/);assert.match(R.doctor({cwd}).hint,/CODEX_TEAM_CODEX/);
 assert.match(versionHint('codex-cli 0.157.2',{failure:{evidence:'setup refresh had errors'}}),/CODEX_TEAM_CODEX/);
 assert.equal(versionHint('codex-cli 0.153.2','setup refresh had errors'),null);assert.equal(versionHint('codex-cli 0.157.0','other'),null);
});
test('default auto-verify runs; explicit false wins; new revisions inherit and legacy revisions stay off',async()=>{
 const cwd=F.project(),input={cwd,requestId:randomUUID(),assignment:F.assignment(),prompt:'WRITE_CODE'};
 const job=R.startJob(input);assert.equal(job.autoVerify,true);assert.match(compactResult('codex_start',job).autoVerifyReason,/sandboxed/);
 assert.equal(R.startJob(input).jobId,job.jobId);assert.equal(R.startJob({...input,autoVerify:true}).jobId,job.jobId);
 assert.equal((await F.done(job)).status,'verified');
 const inherited=R.startJob({cwd,resumeJobId:job.jobId,requestId:randomUUID(),prompt:'Revision'});assert.equal(inherited.autoVerify,true);await F.done(inherited);
 const manual=R.startJob({cwd,resumeJobId:inherited.jobId,requestId:randomUUID(),prompt:'Revision',autoVerify:false});assert.equal(manual.autoVerify,false);assert.equal((await F.done(manual)).status,'implementation_finished');
 const inheritedOff=R.startJob({cwd,resumeJobId:manual.jobId,requestId:randomUUID(),prompt:'Revision'});assert.equal(inheritedOff.autoVerify,false);await F.done(inheritedOff);
 S.patch(inheritedOff.jobId,{autoVerifyVersion:undefined,autoVerify:true,autoVerifyExplicit:true});
 const legacy=R.startJob({cwd,resumeJobId:inheritedOff.jobId,requestId:randomUUID(),prompt:'Revision'});assert.equal(legacy.autoVerify,false);await F.done(legacy);
});
test('host and scout-drafted checks never default or explicitly auto-run',async()=>{
 for(const autoVerify of [undefined,true]) {
  const job=F.start(F.project(),{autoVerify,assignment:F.assignment({verification:[{...F.assignment().verification[0],host:true}]})});
  assert.equal(job.autoVerify,false);assert.match(job.autoVerifyReason,/Host/);await F.done(job);
 }
 const cwd=F.project(),scout=await F.done(F.start(cwd,{mode:'scout',prompt:'Explore'}));
 for(const autoVerify of [undefined,true]) {
  const job=R.startJob({cwd,requestId:randomUUID(),fromScout:scout.jobId,confirmDraftHash:draftHash(scout.result.draftAssignment),assignment:{verification:scout.result.draftAssignment.verification},autoVerify});
  assert.equal(job.autoVerify,false);assert.match(job.autoVerifyReason,/Scout/);await F.done(job);
 }
});
test('status refresh exposes the host fingerprint after edits and supports includeProfileChecks:false',async()=>{
 const cwd=F.project({gates:{level:'advise',checks:{extra:{when:'always',command:[process.execPath,'--version'],level:'advise',host:true}}}});F.approve(cwd);
 const assignment=F.assignment({scope:['.'],verification:[{...F.assignment().verification[0],host:true}]});
 const job=F.start(cwd,{assignment,prompt:'WRITE_CODE'});await F.done(job);
 const full=await R.statusJob({cwd,jobId:job.jobId}),without=await R.statusJob({cwd,jobId:job.jobId,includeProfileChecks:false});assert.ok(without.reviewFingerprint);assert.notEqual(full.reviewFingerprint,without.reviewFingerprint);
 fs.writeFileSync(path.join(cwd,'lead.txt'),'lead edit');
 assert.throws(()=>R.verifyJob({cwd,jobId:job.jobId,includeProfileChecks:false,hostAck:without.reviewFingerprint}),e=>/Current reviewFingerprint: [a-f0-9]+/.test(e.message)&&/lead.txt/.test(e.message));
 const fresh=await R.statusJob({cwd,jobId:job.jobId,refresh:true,includeProfileChecks:false});assert.notEqual(fresh.reviewFingerprint,without.reviewFingerprint);
 R.verifyJob({cwd,jobId:job.jobId,includeProfileChecks:false,hostAck:fresh.reviewFingerprint});const done=await F.done(job);assert.equal(done.status,'verified',done.error);assert.equal(done.verification.checks.length,1);
});
test('salvaged scouts use pre-deadline reads and no-read scouts fail no-evidence',async t=>{
 t.after(()=>delete process.env.CODEX_TEAM_FAKE_RECOVERY);
 for(const noScoutRead of [false,true]) {
  const file=control({runs:true,noScoutRead});const job=F.start(F.project(),{mode:'scout',prompt:'Explore',timeoutSeconds:15,salvageSeconds:10});
  const done=await F.done(job);assert.equal(done.salvage.outcome,'salvaged');assert.equal(done.status,noScoutRead?'failed':'implementation_finished',done.error);
  assert.equal(done.evidenceFloor.status,noScoutRead?'failed':'passed');if(noScoutRead)assert.equal(done.evidenceFloor.reason,'no-evidence');
  const calls=JSON.parse(fs.readFileSync(file)).calls;assert.match(calls[1].prompt,/existing file line ranges/);
 }
 delete process.env.CODEX_TEAM_FAKE_RECOVERY;
});
test('delivery refuses tampered evidence attachments independently of status',()=>{
 const cwd=F.project({report:{level:'advise'}}),profile=F.approve(cwd),jobId=randomUUID(),baseline=snapshot(cwd),dir=path.join(S.jobDir(jobId),'evidence');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'proof.txt');fs.writeFileSync(file,'original');
 S.save({jobId,cwd,executionCwd:cwd,status:'accepted',reviewStatus:'accepted',profile,baseline,assignment:F.assignment(),acceptedFingerprint:baseline.fingerprint,reviews:[{action:'accept',evidence:[{leadObservation:{attachments:[{path:file,hash:hash('original')}]}}]}],startedAt:new Date().toISOString()});
 fs.writeFileSync(file,'tampered');assert.throws(()=>reportTool({cwd,jobId}),/Recorded evidence attachment changed/);
});

test('integrate and push refusals expose current fingerprint and changed paths',async()=>{
 const cwd=F.project(),job=F.start(cwd,{prompt:'WRITE_CODE'});await F.done(job);
 fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\nlead-cache/\n');fs.writeFileSync(path.join(cwd,'answer.mjs'),'lead edit');
 for(const operation of [R.integrateJob,pushTool]) assert.throws(()=>operation({cwd,jobId:job.jobId}),e=>/Current reviewFingerprint: [a-f0-9]+/.test(e.message)&&/answer.mjs/.test(e.message)&&/info\/exclude/.test(e.message));
});


test('scout finalize reuses evidence across real fake-CLI execs without a second read',async t=>{
 t.after(()=>delete process.env.CODEX_TEAM_FAKE_RECOVERY);
 const {salvageRun}=await import('../scripts/salvage.mjs');
 const {scoutReportSchema}=await import('../scripts/contracts.mjs');
 const {readEvents,scoutEvidenceFloor}=await import('../scripts/review-evidence.mjs');
 for(const read of [true,false]) {
  const cwd=F.project(),jobId=randomUUID(),dir=S.jobDir(jobId);fs.mkdirSync(dir,{recursive:true});
  const state={jobId,cwd,executionCwd:cwd,status:'running',mode:'scout',readOnly:true,assignment:F.assignment(),baseline:snapshot(cwd),startedAt:new Date().toISOString(),threadId:'11111111-2222-3333-4444-555555555555',timeoutSeconds:60,salvageSeconds:10};S.save(state);
  fs.writeFileSync(path.join(dir,'report-schema.json'),JSON.stringify(scoutReportSchema));
  const reportPath=path.join(dir,'report.txt'),eventsFile=path.join(dir,'events.jsonl'),errorFile=path.join(dir,'stderr.log'),binary=R.resolveCodex();
  try {
   control({});const first=await R.runProcess(state,binary.command,[...binary.prefix,...R.buildArgs(state,reportPath)],{input:read?'Explore':'NO_SCOUT_READ',eventsFile,errorFile,timeoutSeconds:30,onEvent:()=>{}});assert.equal(first.code,0);
   const initialReads=readEvents(eventsFile).filter(e=>e.item?.type==='command_execution').length;
   control({runs:true});const result=await salvageRun(state,{runProcess:R.runProcess,buildArgs:R.buildArgs,binary,reportPath,eventsFile,errorFile,persist:R.persist});
   assert.equal(result.salvage.outcome,'salvaged');assert.equal(result.stopReason,null);
   const events=readEvents(eventsFile);assert.equal(events.filter(e=>e.item?.type==='command_execution').length,initialReads);
   const floor=scoutEvidenceFloor(state,JSON.parse(fs.readFileSync(reportPath)),events);assert.equal(floor.status,read?'passed':'failed');if(!read)assert.equal(floor.reason,'no-evidence');
  } finally {S.patch(jobId,{status:'failed'});}
 }
});


test('scout evidence follows saved revisions only within the same thread and project',async()=>{
 const {scoutThreadEvents,scoutEvidenceFloor}=await import('../scripts/review-evidence.mjs');
 const cwd=F.project(),first=randomUUID(),next=randomUUID(),thread=randomUUID();
 const base={cwd,executionCwd:cwd,mode:'scout',status:'implementation_finished',threadId:thread,startedAt:new Date().toISOString(),baseline:snapshot(cwd)};
 for(const jobId of [first,next])fs.mkdirSync(S.jobDir(jobId),{recursive:true});
 S.save({...base,jobId:first});
 fs.writeFileSync(path.join(S.jobDir(first),'events.jsonl'),JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'Get-Content existing.txt',status:'completed',exit_code:0}})+'\n');
 const state={...base,jobId:next,resumeJobId:first},brief={files:[{path:'existing.txt',lines:[{startLine:1,endLine:1}]}]};
 assert.equal(scoutEvidenceFloor(state,brief,scoutThreadEvents(state)).status,'passed');
 fs.renameSync(path.join(S.jobDir(first),'events.jsonl'),path.join(S.jobDir(first),'exec-0-events.jsonl'));
 assert.equal(scoutEvidenceFloor(state,brief,scoutThreadEvents(state)).status,'passed','automatic-resume archives retain earlier reads');
 assert.equal(scoutEvidenceFloor(state,brief,scoutThreadEvents({...state,threadId:randomUUID()})).reason,'no-evidence');
 assert.equal(scoutEvidenceFloor(state,brief,scoutThreadEvents({...state,executionCwd:F.root})).reason,'no-evidence');
});

// Lead security review regressions (S1-S9).
const commandEvent=(command,aggregated_output='')=>({type:'item.completed',item:{type:'command_execution',command,aggregated_output,status:'completed',exit_code:0}});

test('S2: evidence rejects listing, count, stdin, printed search output, aliases and null reads',async()=>{
 const {fileReads}=await import('../scripts/review-evidence.mjs');
 const cwd=F.project(),files=['src/a.js','a','b','f'];
 for(const command of ['git diff --name-only','git diff --stat','git show --stat','rg --files','grep -c zzz a b',
  'pwsh -Command "Write-Output src/a.js | Select-String src"','bash -lc "rg nomatch; echo src/a.js"',
  'cat f >/dev/null','cat f > \"/dev/null\"','cat f | Out-Null','head -n0 f','head -c 0 f',"bash -c 'cat(){ :; }; cat f'",'Set-Alias gc Out-Null; gc f',
  'rg -l pattern .','grep --count pattern f','rg pattern','grep pattern - f','Select-String src -InputObject src/a.js','git diff','git show HEAD','rg pattern .; echo src/a.js:1:fake','cat unrelated; rg nomatch f','cat f '+' '.repeat(8200)+'>/dev/null']) {
   assert.equal(fileReads([commandEvent(command,'src/a.js:1:fake\nf:1:fake\na\nb')],files,cwd).size,0,command);
 }
 for(const command of ["pwsh -Command 'git diff; git diff --cached; Get-Content src/a.js; $p = (Get-Location).Path; ...'",
  "powershell -Command 'Get-Location; git status --short; Get-Content src/a.js'",'rg -n pattern src/a.js','Get-Content -LiteralPath src/a.js']) {
  assert.deepEqual([...fileReads([commandEvent(command,'src/a.js:1:real')],files,cwd)],['src/a.js']);
 }
});

test('S3: 30,000 files and 1,000 search events have a bounded evidence floor',async t=>{
 const {scoutEvidenceFloor}=await import('../scripts/review-evidence.mjs');
 const cwd=F.project(),files=Object.fromEntries(Array.from({length:30000},(_,i)=>['file-'+i,{}]));files['existing.txt']={};
 const output=('existing.txt:1:'+ 'x'.repeat(240)+'\n').repeat(16);
 const events=Array.from({length:1000},()=>commandEvent('rg -n pattern .',output));
 const at=performance.now(),floor=scoutEvidenceFloor({executionCwd:cwd,baseline:{files}},{files:[{path:'existing.txt',lines:[{startLine:1,endLine:1}]}]},events);
 const elapsed=performance.now()-at;t.diagnostic(`30k files x 1k events: ${elapsed.toFixed(1)} ms`);
 assert.equal(floor.status,'passed');assert.ok(elapsed<3000,`bounded floor took ${elapsed} ms`);
});

test('S3: fromScout uses the worker result after logs are archived or removed',async()=>{
 const {resolveScout}=await import('../scripts/scout.mjs');
 const job=await F.done(F.start(F.project(),{mode:'scout',prompt:'Explore'}));assert.equal(job.evidenceFloor.status,'passed');
 fs.renameSync(path.join(S.jobDir(job.jobId),'events.jsonl'),path.join(S.jobDir(job.jobId),'saved-events.jsonl'));
 assert.ok(resolveScout({fromScout:job.jobId,assignment:{verification:F.assignment().verification}},job.cwd).provenance);
 S.patch(job.jobId,{evidenceFloor:{status:'passed'}});
 assert.throws(()=>resolveScout({fromScout:job.jobId,assignment:{verification:F.assignment().verification}},job.cwd),/no-evidence/,'old floors use the bounded legacy fallback');
});

test('S4: native headers and repeated finding citations have bounded validation',async t=>{
 const {parseNativeReview}=await import('../scripts/native-review.mjs');
 const {validateFindings}=await import('../scripts/review-findings.mjs');
 const cwd=F.project();fs.writeFileSync(path.join(cwd,'answer.mjs'),'one\ntwo\n');
 const state={executionCwd:cwd,assignment:F.assignment()},header='- [P1] Defect \u2014 answer.mjs:1-1\n  A concrete failure.\n';
 const many=header.repeat(Math.floor(1048576/header.length)),long='- [P1] '+'x'.repeat(200*1024)+' \u2014 answer.mjs:1-1\n  Failure.';
 for(const text of [many,long]) {const at=performance.now(),result=parseNativeReview(text,state),elapsed=performance.now()-at;t.diagnostic(`native ${text.length} chars: ${elapsed.toFixed(1)} ms`);assert.ok(elapsed<1000);assert.equal(result.findings.length,text===many?8:0);assert.ok(result.droppedNativeFindings>0);}
 const finding={severity:'high',confidence:.9,file:'answer.mjs',startLine:1,endLine:1,title:'Defect',body:'Failure',evidence:Array(20).fill('answer.mjs:1-1')};
 const original=fs.openSync;let reads=0;fs.openSync=function(file,...args){if(path.resolve(file)===path.join(cwd,'answer.mjs'))reads++;return original.call(this,file,...args);};
 try {validateFindings(Array(8).fill(finding),state);} finally {fs.openSync=original;}
 assert.equal(reads,1,'one cited file is loaded once per validation');
});

test('S1 and S7: finalize refuses changed ignored config and any non-message item',async t=>{
 const {salvageRun}=await import('../scripts/salvage.mjs');
 const {instructionSnapshot}=await import('../scripts/review-instructions.mjs');
 const {reportSchema}=await import('../scripts/contracts.mjs');
 t.after(()=>delete process.env.CODEX_TEAM_FAKE_RECOVERY);
 for(const item of [null,'file_change','web_search','command_execution','mcp_tool_call','unknown_item','config']) {
  const cwd=F.project();fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\n.codex/\n');
  if(item===null) {fs.mkdirSync(path.join(cwd,'.codex'));fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'# Existing trusted fixture configuration');}
  const jobId=randomUUID(),dir=S.jobDir(jobId);fs.mkdirSync(dir,{recursive:true});
  const state={jobId,cwd,executionCwd:cwd,status:'running',baseline:snapshot(cwd),reviewInstructionBaseline:instructionSnapshot(cwd),startedAt:S.now(),threadId:randomUUID(),timeoutSeconds:30,salvageSeconds:10};S.save(state);
  fs.writeFileSync(path.join(dir,'report-schema.json'),JSON.stringify(reportSchema));
  if(item==='config') {fs.mkdirSync(path.join(cwd,'.codex'));fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'notify = ["untrusted"]');}
  const file=control({runs:true,finalizeItem:item==='config'?null:item});
  const result=await salvageRun(state,{runProcess:R.runProcess,buildArgs:R.buildArgs,binary:R.resolveCodex(),reportPath:path.join(dir,'report.txt'),eventsFile:path.join(dir,'events.jsonl'),errorFile:path.join(dir,'stderr.log'),persist:R.persist});
  assert.equal(result.salvage.outcome,item==='config'?'config_changed':item?'invalid_report':'salvaged');
  const calls=JSON.parse(fs.readFileSync(file)).calls || [];
  if(item==='config') {assert.equal(calls.length,0);assert.match(result.salvage.error,/config.toml/);}
  else {assert.equal(calls.length,1);assert.ok(calls[0].args.includes('project_doc_max_bytes=0'));}
  S.patch(jobId,{status:'failed'});
 }
});

test('S1: automatic resume refuses a newly written ignored project config',async t=>{
 const old=process.env.CODEX_TEAM_TEST_BACKOFF_MS;process.env.CODEX_TEAM_TEST_BACKOFF_MS='1,1';
 t.after(()=>{if(old===undefined)delete process.env.CODEX_TEAM_TEST_BACKOFF_MS;else process.env.CODEX_TEAM_TEST_BACKOFF_MS=old;delete process.env.CODEX_TEAM_FAKE_RECOVERY;});
 const cwd=F.project();fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\n.codex/\n');
 const file=control({writeConfig:true,failures:1,message:'HTTP 503'}),job=F.start(cwd),done=await F.done(job);
 assert.ok(job.reviewInstructionBaseline);assert.equal(done.status,'failed');assert.match(done.error,/Automatic resume refused.*config.toml/);
 assert.equal(done.autoResumes.at(-1).outcome,'config_changed');assert.equal(JSON.parse(fs.readFileSync(file)).calls.length,1);
});

test('S5: reviewer and native auth failures stay on incomplete review packets',async t=>{
 const file=path.join(F.root,'review-auth.json');process.env.CODEX_TEAM_FAKE_REVIEWER=file;t.after(()=>delete process.env.CODEX_TEAM_FAKE_REVIEWER);
 for(const flag of ['reviewerAuth','nativeAuth']) {
  fs.writeFileSync(file,JSON.stringify({[flag]:true}));
  const job=await F.done(F.start(F.project(),{prompt:'WRITE_CODE',autoVerify:true}));
  assert.equal(job.status,'verified');assert.equal(job.runtimeFailure,null);assert.equal(job.decisionPacket.status,'incomplete');assert.match(job.decisionPacket.reviewerError,/authentication failure.*refresh token expired/);
  assert.ok(!/codex login/.test(job.next || ''));assert.equal(S.readRaw(job.jobId).runtimeFailure,null);
 }
});

test('S6: accepted, cancelled and superseded jobs prune external review copies',async()=>{
 const copies=id=>{const dir=path.join(S.jobDir(id),'review-copies');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'copy.after'),'source');return dir;};
 const accepted=await F.done(F.start(F.project(),{prompt:'WRITE_CODE',autoVerify:true})),acceptedDir=copies(accepted.jobId);
 assert.equal(F.accept(accepted).status,'accepted');assert.equal(fs.existsSync(acceptedDir),false);
 const prior=await F.done(F.start(F.project(),{prompt:'WRITE_CODE'})),priorDir=copies(prior.jobId);
 const next=F.start(prior.cwd,{resumeJobId:prior.jobId,prompt:'Revision'});assert.equal(fs.existsSync(priorDir),false);await F.done(next);
 const id=randomUUID(),cwd=F.project();S.save({jobId:id,cwd,status:'running',startedAt:S.now()});const cancelledDir=copies(id);
 await R.persist(id,{status:'cancelled'});assert.equal(fs.existsSync(cancelledDir),false);
 const cancelledReview=copies(id),baselineDir=path.join(S.jobDir(id),'baseline-bytes');fs.mkdirSync(baselineDir);fs.writeFileSync(path.join(baselineDir,'baseline'),'retry input');
 await R.persist(id,{status:'verification_failed',cancelled:true});assert.equal(fs.existsSync(cancelledReview),false);assert.ok(fs.existsSync(path.join(baselineDir,'baseline')),'verification retry keeps its baseline');
});

test('S8: enforced review budgets serialize launch and usage accounting',async()=>{
 const {runReviewer}=await import('../scripts/reviewer.mjs');
 const {instructionSnapshot}=await import('../scripts/review-instructions.mjs');
 const {captureBytes}=await import('../scripts/baseline-bytes.mjs');
 const {usageSummary}=await import('../scripts/evidence-budget.mjs');
 const cwd=F.project(),baseline=snapshot(cwd),jobId=randomUUID();
 const state={jobId,cwd,executionCwd:cwd,startedAt:S.now(),status:'verifying',baseline,reviewInstructionBaseline:instructionSnapshot(cwd),assignment:F.assignment({scope:['.']}),verification:{checks:[{id:'answer',status:'passed',exitCode:0,criteria:[0]}]},result:{blockers:[]},execs:[],timeoutSeconds:30,
  profile:{repoId:randomUUID(),components:{budget:{level:'enforce',perJob:{inputTokens:5}}}}};
 state.baselineBytes=captureBytes(cwd,baseline,['.'],path.join(S.jobDir(jobId),'baseline-bytes'));
 for(let i=0;i<31;i++)fs.writeFileSync(path.join(cwd,'changed-'+i+'.mjs'),'export const x=1;\n');
 const current=snapshot(cwd);state.verifiedFingerprint=current.fingerprint;S.save(state);let launches=0;
 await runReviewer(state,current,true,{buildArgs:R.buildArgs,resolveCodex:()=>({command:'unused',prefix:[]}),persist:R.persist,retryBusy:async fn=>fn(),runProcess:async(s,c,a,options)=>{
  launches++;await new Promise(r=>setTimeout(r,25));options.onEvent({type:'turn.completed',usage:{input_tokens:7,output_tokens:1}});return {code:1};
 }});
 assert.equal(launches,1,'only the first turn may exceed the observed budget');assert.equal(usageSummary(state).task.inputTokens,7);
 assert.equal(S.read(jobId).decisionPacket.status,'incomplete');assert.match(S.read(jobId).nativeReview.reason,/budget exhausted/);
});


test('finished scout previews retain short scope with learned timing metadata',async()=>{
 const {compactJob}=await import('../scripts/tool-output.mjs');
 const job=await F.done(F.start(F.project(),{mode:'scout',prompt:'Explore'}));
 const view=compactJob({...job,timeoutBasis:{n:200,p50:1234.567891,p90:2345.678912},typicalDurationSeconds:1234.567891});
 assert.ok(JSON.stringify(view).length<=1500);assert.equal(view.untrustedCodexText.content.draftScopePreview,'"answer.mjs"');assert.equal(view.draftScopeTruncated,false);
 assert.match(view.untrustedCodexText.content.draftVerificationPreview,/command.*node.*args/);
});
