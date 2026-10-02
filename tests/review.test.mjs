/** Job F: fake CLI only, isolated projects/state; no network or real model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, S, R } from './job-b-fixture.mjs';
import { reviewOptions, validateFindings, mergeFindings, findingDispositions, findingPacketBinding } from '../scripts/review-findings.mjs';
import { buildReviewerPrompt, runReviewer, reviewGroups, largeReview } from '../scripts/reviewer.mjs';
import { instructionSnapshot, assertReviewInstructions } from '../scripts/review-instructions.mjs';
import { fileReads, reviewerEvidenceFloor, scoutEvidenceFloor } from '../scripts/review-evidence.mjs';
import { nativeArgs, nativeEligibility, parseNativeFindings, parseNativeReview, runNativeReview } from '../scripts/native-review.mjs';
import { boundedPacket, resolvePacketEvidence } from '../scripts/decision-packet.mjs';
import { snapshot, git } from '../scripts/git.mjs';
import { captureBytes } from '../scripts/baseline-bytes.mjs';
import { reviewAttempt } from '../scripts/review-order.mjs';
const F = fixture('review');
const done = F.done;
// Large/concurrent phases can exceed a single status long-poll on Windows.
F.done = async job => {
  const deadline=Date.now()+180000;
  while(Date.now()<deadline) {
    const state=await R.statusJob({cwd:job.cwd,jobId:job.jobId,waitSeconds:30});
    if(!S.active.has(state.status)) return done(job);
  }
  assert.fail('Job did not finish within the review fixture deadline.');
};
const control = value => { const file=path.join(F.root,'control.json');fs.writeFileSync(file,JSON.stringify(value));process.env.CODEX_TEAM_FAKE_REVIEWER=file; };
const stateFor = cwd => ({cwd,executionCwd:cwd,assignment:F.assignment(),verification:{checks:[{id:'answer',status:'passed',exitCode:0,criteria:[0]}]}});
const finding = extra => ({severity:'high',confidence:0.8,file:'answer.mjs',startLine:1,endLine:1,title:'Incorrect answer',body:'A caller receives an incorrect answer.',evidence:['answer.mjs:1-1'],...extra});
const read = file => ({type:'item.completed',item:{type:'command_execution',command:'Get-Content '+file,status:'completed',exit_code:0,aggregated_output:'content'}});
const commandEvent = (command, output='') => ({type:'item.completed',item:{type:'command_execution',command,status:'completed',exit_code:0,aggregated_output:output}});
// Exact text from the lead's pinned 0.153.2 CLI run; substitute its shortened root.
const nativeSample = [
  'The changed loop breaks average calculations for ordinary nonempty numeric arrays. Direct execution confirmed the regression on three representative inputs.',
  '', 'Review comment:', '',
  '- [P1] Iterate over valid zero-based array indices — <ROOT>/stats.mjs:3-3',
  '  For every nonempty numeric array, this loop skips `xs[0]` and reads `xs[xs.length]`, which is `undefined`, causing the result to become `NaN`. Running `average([1, 2, 3])` confirms it now returns `NaN` instead of `2`. Start at index `0` and stop before `xs.length` to preserve the previous behavior.',
].join('\n');

test('finding validation: scope, literal paths, ranges, bounds, confidence and evidence',()=>{
  const cwd=F.project();fs.writeFileSync(path.join(cwd,'answer.mjs'),'one\ntwo\n');const state=stateFor(cwd);
  assert.equal(validateFindings([finding()],state).length,1);
  validateFindings([finding({evidence:['answer']})],state);
  for(const invalid of [
    {file:'existing.txt'},{file:'../answer.mjs'},{file:'answer*.mjs'},{file:'missing.mjs'},
    {startLine:0},{startLine:1.5},{endLine:3},{startLine:2,endLine:1},{severity:'urgent'},
    {confidence:-0.1},{confidence:1.1},{confidence:NaN},{confidence:'0.5'},
    {title:'x'.repeat(121)},{body:'x'.repeat(1501)},{title:''},{body:''},
    {evidence:[]},{evidence:['failed']},{evidence:['answer.mjs:1-99']},{extra:true},
  ]) assert.throws(()=>validateFindings([finding(invalid)],state),JSON.stringify(invalid));
  assert.throws(()=>validateFindings(Array(9).fill(finding()),state));
  assert.deepEqual(validateFindings(undefined,state),[]);
});
test('packet sorts by severity then confidence, isolates untrusted findings and counts overflow; legacy readable',()=>{
  const findings=mergeFindings([finding({severity:'low',source:'native'}),finding({confidence:0.6,source:'reviewer'}),finding({severity:'critical',confidence:0.1,source:'native'}),finding({confidence:0.9,source:'reviewer'})]);
  assert.deepEqual(findings.map(f=>f.confidence),[0.1,0.9,0.6,0.8]);
  assert.deepEqual(mergeFindings([finding({confidence:null,source:'native'}),finding({confidence:0.6,source:'reviewer'})]).map(f=>f.confidence),[0.6,null]);
  const base={risks:[],blockers:[],hunks:[],checks:[],criteria:[],omittedHunks:0};
  const packet=boundedPacket({...base,findings});assert.equal(packet.findings,undefined);assert.equal(packet.untrustedCodexText.content.findings[0].source,'native');
  const big=boundedPacket({...base,findings:mergeFindings(Array(40).fill(finding({body:'x'.repeat(1500),source:'reviewer'})))});
  assert.ok(JSON.stringify(big).length<=6000);assert.ok(big.omittedFindings>0);assert.equal(big.omittedFindings+big.untrustedCodexText.content.findings.length,40);
  assert.doesNotThrow(()=>boundedPacket(base));
});
test('disposition validation and unresolved high findings block; low findings never block',()=>{
  const state={decisionPacket:{findings:[finding()]},findingPacketHash:'hash'};
  assert.throws(()=>findingDispositions(state,[],true),/findingDispositions/);
  const d={findingIndex:0,disposition:'fixed',observation:'Rechecked correction'};
  assert.deepEqual(findingDispositions(state,[d],true),[d]);
  for(const invalid of [{...d,findingIndex:1},{...d,observation:''},{...d,disposition:'ignored'}]) assert.throws(()=>findingDispositions(state,[invalid],true));
  assert.throws(()=>findingDispositions(state,[d,d],true));
  findingDispositions({...state,reviews:[{findingPacketHash:'hash',findingDispositions:[d]}]},[],true);
  assert.throws(()=>findingDispositions({...state,reviews:[{findingPacketHash:'old',findingDispositions:[d]}]},[],true));
  for(const f of [finding({severity:'low'}),finding({severity:'medium'}),finding({confidence:0.49})]) findingDispositions({decisionPacket:{findings:[f]}},[],true);
});
test('recorded finding dispositions retain packet binding under secret redaction',()=>{
  const hash='a'.repeat(64),jobId=randomUUID(),cwd=F.project();
  S.save({jobId,cwd,startedAt:S.now(),status:'verified',findingPacketHash:hash,decisionPacket:{findings:[finding()]},
    profile:{components:{secrets:{level:'enforce',patterns:['[a-f0-9]{64}']}}},
    reviews:[{findingPacketHash:findingPacketBinding(hash),findingDispositions:[{findingIndex:0,disposition:'accepted-risk',observation:'Lead assessed the scenario.'}]}]});
  const state=S.read(jobId);assert.deepEqual(state.reviews[0].findingPacketHash,findingPacketBinding(hash));
  assert.doesNotThrow(()=>findingDispositions(state,[],true));
});
test('review settings validate, adversarial prompt requires failure scenarios, revisions inherit',async()=>{
  for(const input of [{native:1},{mode:'other'},{focus:Array(11).fill('x')},{focus:['x'.repeat(201)]},{maxReviewers:0},{maxReviewers:5},{maxReviewers:1.5},{extra:1}]) assert.throws(()=>reviewOptions(input));
  control({});const cwd=F.project(), review={mode:'adversarial',focus:['HTTP inputs'],native:false,maxReviewers:2};
  const job=F.start(cwd,{review,prompt:'WRITE_CODE'});await F.done(job);
  const revision=F.start(cwd,{resumeJobId:job.jobId,assignment:undefined});const done=await F.done(revision);
  assert.deepEqual(done.review,review);
  const prompt=buildReviewerPrompt({...stateFor(cwd),review},{available:true,hunks:[]});
  for(const term of ['hostile inputs','authorization','injection','path traversal','secrets','concurrency','resource exhaustion','exploit or failure scenario','HTTP inputs','One strong finding','none rather than speculate']) assert.ok(prompt.includes(term),term);
});
test('real review API requires dispositions for packet AND explicit evidence, records them',async()=>{
  control({findings:[finding()]});
  for(const evidence of ['packet',F.evidence]) {
    const job=F.start(F.project(),{prompt:'WRITE_CODE',autoVerify:true,review:{native:false}}),done=await F.done(job);
    assert.equal(done.decisionPacket.findings.length,1);
    assert.throws(()=>F.accept(done,{evidence}),/findingDispositions/);
    const findingDispositions=[{findingIndex:0,disposition:'accepted-risk',observation:'Lead assessed the reported scenario.'}];
    assert.equal(F.accept(done,{evidence,findingDispositions}).status,'accepted');
    assert.deepEqual(S.read(job.jobId).reviews.at(-1).findingDispositions,findingDispositions);
  }
  control({findings:[finding({severity:'low'})]});
  const done=await F.done(F.start(F.project(),{prompt:'WRITE_CODE',autoVerify:true,review:{native:false}}));
  assert.equal(F.accept(done,{evidence:'packet'}).status,'accepted');control({});
});
test('native review runs, dirty baseline skips, opt-out persists, failure still produces packet',async()=>{
  for(const mode of ['run','dirty','disabled','fail']) {
    control({nativeFail:mode==='fail'});const cwd=F.project();
    if(mode==='dirty') fs.writeFileSync(path.join(cwd,'answer.mjs'),'dirty baseline\n');
    const done=await F.done(F.start(cwd,{prompt:'WRITE_CODE',autoVerify:true,review:{native:mode!=='disabled'}}));
    assert.equal(done.decisionPacket.status,'ready',JSON.stringify(done.decisionPacket));
    assert.equal(done.nativeReview.status,mode==='run'?'completed':mode==='fail'?'failed':'skipped');
    if(mode==='dirty') assert.match(done.nativeReview.reason,/Dirty/);
    if(mode==='disabled') assert.match(done.nativeReview.reason,/native=false/);
  }
  control({});
});
test('native parser retains secondary JSON payload support and read-only args',()=>{
  const cwd=F.project(),baseline=snapshot(cwd);fs.writeFileSync(path.join(cwd,'answer.mjs'),'code\n');const state={...stateFor(cwd),baseline,isolation:'worktree'};
  assert.equal(nativeEligibility(state,snapshot(cwd)),null);
  assert.match(nativeEligibility(state,baseline),/differ from uncommitted/);
  const value={findings:[{priority:1,confidence_score:0.8,title:'Defect',body:'Failure scenario',code_location:{absolute_file_path:path.join(cwd,'answer.mjs'),line_range:{start:1,end:1}}}]};
  assert.equal(parseNativeFindings(JSON.stringify(value),state)[0].source,'native');
  assert.deepEqual(parseNativeFindings('plain prose',state),[]);assert.deepEqual(parseNativeFindings('{}',state),[]);
  const args=nativeArgs({...state,jobId:randomUUID()},R.buildArgs);
  assert.ok(args.includes('review')&&args.includes('--uncommitted')&&args.includes('--json'));
  assert.equal(args[args.indexOf('--sandbox')+1],'read-only');assert.ok(args.includes('project_doc_max_bytes=0'));assert.ok(!args.includes('--output-schema'));
});
test('native timeout uses fake CLI and returns failed; default timeout is 300 seconds',async t=>{
  control({nativeDelay:1800});const cwd=F.project(),baseline=snapshot(cwd);fs.writeFileSync(path.join(cwd,'answer.mjs'),'code\n');
  const state={...stateFor(cwd),baseline,jobId:randomUUID(),startedAt:S.now(),status:'verifying',reviewInstructionBaseline:instructionSnapshot(cwd)};
  fs.mkdirSync(S.jobDir(state.jobId),{recursive:true});S.save(state);
  let timeout;
  const dependencies={directory:S.jobDir(state.jobId),buildArgs:R.buildArgs,resolveCodex:()=>({command:process.execPath,prefix:[path.resolve('tests/fake-codex.mjs')]})};
  await runNativeReview(state,snapshot(cwd),{...dependencies,runProcess:async(_state,command,args,options)=>{timeout=options.timeoutSeconds;return {code:1};}});
  assert.equal(timeout,300);
  const result=await runNativeReview(state,snapshot(cwd),{...dependencies,timeoutSeconds:0.1,runProcess:async(_state,command,args,options)=>{
    timeout=options.timeoutSeconds;
    return R.runProcess(_state,command,args,options);
  }});
  assert.equal(timeout,0.1);assert.equal(result.status,'failed');assert.match(result.reason,/timed_out/);
  if(S.read(state.jobId).cancellationError) t.diagnostic('Sandbox limit: '+S.read(state.jobId).cancellationError);
  control({});
});
test('non-inline evidence requires tool reads of cited changed files; failed verdict cannot seed packet acceptance',()=>{
  const cwd=F.project(),state={...stateFor(cwd),changes:{files:['answer.mjs']}};
  const report=()=>({criteria:[{criterionIndex:0,verdict:'met',checkIds:['answer'],evidence:'checked',hunks:[{file:'answer.mjs'}]}],findings:[finding()]});
  const hunks={inline:false,files:[]};
  let r=report();assert.equal(reviewerEvidenceFloor(r,hunks,[],state),'failed');assert.equal(r.criteria[0].evidenceFloor,'failed');
  assert.equal(reviewerEvidenceFloor(report(),hunks,[read('answer.mjs')],state),'passed');
  assert.equal(reviewerEvidenceFloor(report(),hunks,[{type:'item.completed',item:{type:'agent_message',text:'Get-Content answer.mjs'}}],state),'failed');
  const echoed=read('answer.mjs');echoed.item.command='echo powershell -Command "Get-Content answer.mjs"';
  assert.equal(reviewerEvidenceFloor(report(),hunks,[echoed],state),'failed');
  assert.equal(reviewerEvidenceFloor(report(),{inline:true},[],state),'passed');
});
test('scout no reads or no existing citation fails and cannot seed implementation',async()=>{
  for(const prompt of ['NO_SCOUT_READ','NO_SCOUT_CITATION']) {
    const job=F.start(F.project(),{mode:'scout',prompt}),done=await F.done(job);
    assert.equal(done.status,'failed');assert.equal(done.evidenceFloor.reason,'no-evidence');
    assert.throws(()=>F.start(done.cwd,{fromScout:job.jobId}),/completed, validated/);
  }
});
test('large threshold, disjoint split and reviewer cap',()=>{
  assert.equal(largeReview({hunks:[],omitted:0},30),false);assert.equal(largeReview({hunks:[],omitted:0},31),true);
  assert.equal(largeReview({hunks:[{after:'x'.repeat(60001)}],omitted:0},1),true);
  const files=Array.from({length:31},(_,i)=>'file'+i);
  const groups=reviewGroups(files,true,4);assert.equal(groups.length,4);assert.equal(new Set(groups.flat()).size,31);
  assert.equal(reviewGroups(files,true,2).length,2);assert.equal(reviewGroups(files,false,4).length,1);
  assert.deepEqual(reviewGroups([...files].reverse(),true,4),groups);
  assert.equal(reviewAttempt({execs:[{role:'reviewer',attempt:0},{role:'reviewer',attempt:4}]}),5);
  assert.equal(reviewAttempt({execs:[{role:'reviewer',attempt:5},{role:'reviewer',attempt:9}]},4),14);
});
test('large review supplies external copies, concurrently merges disjoint findings, and enforces reads',async()=>{
  for (const readFiles of [false,true]) {
    control({readFiles,groupFindings:true});
    const cwd=F.project(),job=F.start(cwd,{prompt:'WRITE_CODE',assignment:F.assignment({scope:['.']}),review:{native:false,maxReviewers:3,mode:'adversarial'}});
    await F.done(job);
    for(let i=0;i<31;i++) fs.writeFileSync(path.join(cwd,'changed-'+String(i).padStart(2,'0')+'.mjs'),'export const x = 1;\n');
    R.verifyJob({cwd,jobId:job.jobId});const done=await F.done(job);
    assert.equal(done.decisionPacket.status,'ready',JSON.stringify(done.decisionPacket));
    assert.equal(done.decisionPacket.reviewMode,'adversarial');
    assert.equal(done.execs.filter(e=>e.role==='reviewer').length,3);
    assert.equal(done.reviewer.criteria.length,1);assert.equal(done.decisionPacket.findings.length,3);
    assert.equal(new Set(done.decisionPacket.findings.map(f=>f.file)).size,3);
    assert.equal(done.decisionPacket.evidenceFloor,readFiles?'passed':'failed');
    const captured=JSON.parse(fs.readFileSync(path.join(S.jobDir(job.jobId),'reviewer-captured.json')));
    const input=JSON.parse(captured.prompt.split('\nREVIEW_INPUT\n')[1]);
    assert.equal(input.hunks.inline,false);assert.equal(input.hunks.hunks[0].after,undefined);
    for(const file of input.hunks.files) {assert.ok(fs.existsSync(file.beforePath)&&fs.existsSync(file.afterPath));assert.ok(!file.afterPath.startsWith(cwd));}
    const packetFileObservations=done.decisionPacket.changedFiles.map(file=>({file,observation:'Lead inspected the full changed file.'}));
    if (!readFiles) assert.throws(()=>F.accept(done,{evidence:'packet',packetFileObservations}),/overrides required/);
    else assert.equal(F.accept(done,{evidence:'packet',packetFileObservations}).status,'accepted');
  }
  control({});
});
test('native findings merge with advisory findings and carry their source',async()=>{
  const cwd=F.project();control({findings:[finding({severity:'low'})],nativeFindings:[{priority:1,confidence_score:0.9,title:'Native defect',body:'A caller fails.',code_location:{absolute_file_path:path.join(cwd,'answer.mjs'),line_range:{start:1,end:1}}}]});
  const done=await F.done(F.start(cwd,{prompt:'WRITE_CODE',autoVerify:true}));
  assert.deepEqual(done.decisionPacket.findings.map(f=>f.source),['native','reviewer']);
  assert.throws(()=>F.accept(done),/findingDispositions/);control({});
});
test('H13 detects tracked, untracked and ignored configuration/instructions, including post-verification creation',()=>{
  for(const file of ['AGENTS.md','AGENTS.override.md','.codex/config.toml']) {
    const cwd=F.project();fs.writeFileSync(path.join(cwd,'.gitignore'),'.codex/\nnested/\n');
    const state={executionCwd:cwd,baseline:snapshot(cwd),reviewInstructionBaseline:instructionSnapshot(cwd)};
    assertReviewInstructions(state);fs.mkdirSync(path.dirname(path.join(cwd,file)),{recursive:true});fs.writeFileSync(path.join(cwd,file),'unsafe');
    assert.throws(()=>assertReviewInstructions(state),/instructions\/configuration changed/);
  }
  const cwd=F.project();fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\n.codex/\n');
  fs.mkdirSync(path.join(cwd,'.codex'));fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'original ignored config');
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'original tracked instructions');git(cwd,['add','AGENTS.md']);
  const state={executionCwd:cwd,baseline:snapshot(cwd),reviewInstructionBaseline:instructionSnapshot(cwd)};
  assertReviewInstructions(state);
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'changed tracked instructions');assert.throws(()=>assertReviewInstructions(state),/AGENTS.md/);
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'original tracked instructions');
  fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'changed ignored config');assert.throws(()=>assertReviewInstructions(state),/config.toml/);
});
test('H13 late ignored config blocks both reviewer launches and leaves incomplete packet',async()=>{
  control({});const cwd=F.project();fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\n.codex/\n');
  const job=F.start(cwd,{prompt:'WRITE_CODE'});await F.done(job);
  // A check creates ignored configuration after the implementation visibility observation.
  const saved=S.read(job.jobId);saved.assignment.verification=[{id:'answer',command:process.execPath,args:['-e',"require('fs').mkdirSync('.codex',{recursive:true});require('fs').writeFileSync('.codex/config.toml','unsafe')"],allowInline:true,criteria:[0],timeoutSeconds:10}];S.save(saved);
  R.verifyJob({cwd,jobId:job.jobId});const done=await F.done(job);
  assert.equal(done.decisionPacket.status,'incomplete');assert.match(done.decisionPacket.reviewerError,/instructions\/configuration changed/);
  assert.equal(done.execs.filter(e=>e.role==='reviewer').length,0);
});
test('H13 repeats after argument preparation immediately before every native/advisory launch',async()=>{
  const cwd=F.project();fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\n.codex/\n');
  const baseline=snapshot(cwd),jobId=randomUUID();
  const state={...stateFor(cwd),jobId,startedAt:S.now(),baseline,reviewInstructionBaseline:instructionSnapshot(cwd),status:'verifying',execs:[],result:{blockers:[]}};
  state.baselineBytes=captureBytes(cwd,baseline,['answer.mjs'],path.join(S.jobDir(jobId),'baseline-bytes'));
  fs.writeFileSync(path.join(cwd,'answer.mjs'),'export const answer=42;\n');
  const current=snapshot(cwd);state.verifiedFingerprint=current.fingerprint;S.save(state);
  let launches=0;
  await runReviewer(state,current,true,{
    buildArgs:(s,output)=>{fs.mkdirSync(path.join(cwd,'.codex'),{recursive:true});fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'changed');return R.buildArgs(s,output);},
    resolveCodex:()=>({command:'unused',prefix:[]}),runProcess:async()=>{launches++;throw Error('must not launch');},
    persist:async(id,patch)=>S.patch(id,patch),retryBusy:async fn=>fn(),
  });
  assert.equal(launches,0);assert.equal(S.read(jobId).decisionPacket.status,'incomplete');
  assert.equal(S.read(jobId).nativeReview.status,'failed');assert.match(S.read(jobId).nativeReview.reason,/instructions\/configuration changed/);
});

test('H13 snapshot ignores 120,000 ignored dependency files and nested instructions without traversing them',t=>{
  const cwd=F.project(), baseline=snapshot(cwd);
  fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\nnode_modules/\n.codex/\n');
  const modules=path.join(cwd,'node_modules');fs.mkdirSync(modules);
  for(let directory=0;directory<120;directory++) {
    const folder=path.join(modules,'pkg-'+directory);fs.mkdirSync(folder);
    for(let file=0;file<1000;file++)fs.writeFileSync(path.join(folder,'file-'+file),'');
  }
  fs.mkdirSync(path.join(modules,'pkg-0','.codex'));
  fs.writeFileSync(path.join(modules,'pkg-0','AGENTS.md'),'Dependency instructions must not affect the root reviewer.');
  fs.writeFileSync(path.join(modules,'pkg-0','.codex','config.toml'),'dependency config');
  fs.mkdirSync(path.join(cwd,'.codex'));fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'pre-existing ignored root config');
  const original=fs.opendirSync, started=Date.now(), visited=[];
  fs.opendirSync=function(file,...args) {visited.push(path.resolve(file));assert.ok(!String(file).includes('node_modules'),'must not enumerate ignored dependencies');return original.call(this,file,...args);};
  try {
    const state={executionCwd:cwd,baseline,reviewInstructionBaseline:instructionSnapshot(cwd)};
    assert.deepEqual(Object.keys(state.reviewInstructionBaseline),['.codex/config.toml']);
    assertReviewInstructions(state);
    fs.writeFileSync(path.join(modules,'pkg-0','AGENTS.md'),'changed dependency instructions');
    assertReviewInstructions(state);
    assert.deepEqual(visited,Array(3).fill(path.join(cwd,'.codex')),'one relevant directory visit per snapshot, independent of dependency count');
    t.diagnostic('Three instruction inventories including Git root lookup: '+(Date.now()-started)+'ms; dependency directories visited: 0.');
    fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'changed root config');
    assert.throws(()=>assertReviewInstructions(state),/config.toml/);
  } finally {fs.opendirSync=original;}
});

test('H13 observes execution ancestors, bounds instruction entries/bytes and preserves legacy fallback',()=>{
  const cwd=F.project(), executionCwd=path.join(cwd,'src');fs.mkdirSync(executionCwd);
  fs.mkdirSync(path.join(executionCwd,'.codex'));fs.writeFileSync(path.join(executionCwd,'.codex/config.toml'),'config');
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'root instructions');
  fs.writeFileSync(path.join(executionCwd,'AGENTS.override.md'),'execution instructions');
  const state={executionCwd,baseline:snapshot(cwd),reviewInstructionBaseline:instructionSnapshot(executionCwd)};
  assert.deepEqual(Object.keys(state.reviewInstructionBaseline),['AGENTS.md','src/.codex/config.toml','src/AGENTS.override.md']);
  assertReviewInstructions(state);
  assertReviewInstructions({...state,reviewInstructionBaseline:undefined});
  for(const file of ['AGENTS.md','src/.codex/config.toml','src/AGENTS.override.md']) {
    const target=path.join(cwd,file),previous=fs.readFileSync(target);fs.writeFileSync(target,'changed');
    assert.throws(()=>assertReviewInstructions(state),/instructions\/configuration changed/);fs.writeFileSync(target,previous);
  }
  fs.mkdirSync(path.join(executionCwd,'nested','.codex'),{recursive:true});
  fs.writeFileSync(path.join(executionCwd,'nested','.codex','config.toml'),'ignored nested config');
  fs.writeFileSync(path.join(executionCwd,'nested','AGENTS.md'),'ignored nested instructions');
  assertReviewInstructions(state);
  assert.throws(()=>instructionSnapshot(executionCwd,{maxEntries:1}),/entry limit/);
  assert.throws(()=>instructionSnapshot(executionCwd,{maxBytes:1}),/byte limit/);
  assert.throws(()=>instructionSnapshot(executionCwd,{maxFileBytes:1}),/oversized/);
});

test('H13 non-Git prompt jobs retain instruction checks and reject broken Git metadata',()=>{
  const cwd=path.join(F.root,'non-git-instructions');fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'original instructions');
  fs.mkdirSync(path.join(cwd,'.codex'));fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'original config');
  const state={executionCwd:cwd,baseline:snapshot(cwd),reviewInstructionBaseline:instructionSnapshot(cwd)};
  assert.equal(state.baseline.available,false);
  assert.deepEqual(Object.keys(state.reviewInstructionBaseline),['.codex/config.toml','AGENTS.md']);
  assertReviewInstructions(state);
  for(const file of ['AGENTS.md','.codex/config.toml']) {
    const target=path.join(cwd,file),before=fs.readFileSync(target);fs.writeFileSync(target,'changed');
    assert.throws(()=>assertReviewInstructions(state),/instructions\/configuration changed/);fs.writeFileSync(target,before);
  }
  fs.writeFileSync(path.join(cwd,'AGENTS.override.md'),'new instructions');
  assert.throws(()=>assertReviewInstructions(state),/AGENTS.override.md/);
  assert.throws(()=>instructionSnapshot(cwd,{maxEntries:1}),/entry limit/);
  assert.throws(()=>instructionSnapshot(cwd,{maxBytes:1}),/byte limit/);
  fs.writeFileSync(path.join(cwd,'.git'),'gitdir: missing-repository\n');
  assert.throws(()=>instructionSnapshot(cwd),/Cannot inspect Git filters safely|Cannot determine instruction root/);
});

test('H13 non-Git fallback rejects damaged Git markers in execution folders and ancestors',()=>{
  for(const kind of ['directory','gitfile']) for(const level of [0,1,2]) {
    const family=path.join(F.root,`damaged-git-${kind}-${level}`),cwd=path.join(family,'parent','child');
    fs.mkdirSync(cwd,{recursive:true});
    let folder=cwd;for(let i=0;i<level;i++)folder=path.dirname(folder);
    const marker=path.join(folder,'.git');
    if(kind==='directory')fs.mkdirSync(marker);else fs.writeFileSync(marker,'gitdir: missing-repository\n');
    assert.throws(()=>instructionSnapshot(cwd),/Git metadata|Cannot inspect Git filters safely|Cannot determine instruction root/,`${kind} marker at ancestor level ${level}`);
  }
});

test('H13 recorded Git baselines reject metadata loss even with no instruction files',async()=>{
  const cwd=F.project(),job=F.start(cwd,{assignment:undefined,prompt:'Git prompt fixture'});
  assert.equal((await F.done(job)).status,'implementation_finished');
  const state=S.read(job.jobId),baseline=state.baseline;
  assert.equal(baseline.available,true);assert.deepEqual(state.reviewInstructionBaseline,{});assertReviewInstructions(state);
  const metadata=path.join(cwd,'.git'),backup=path.join(cwd,'saved-git-metadata');
  assert.equal(path.dirname(metadata),cwd);assert.equal(path.dirname(backup),cwd);
  fs.renameSync(metadata,backup);
  try {
    assert.equal(snapshot(cwd).available,false);
    assert.throws(()=>assertReviewInstructions(state),/Recorded Git repository/);
    assert.throws(()=>assertReviewInstructions({...state,attemptBaseline:{available:false},reviewInstructionBaseline:undefined}),/Recorded Git repository/);
    assert.throws(()=>assertReviewInstructions({...state,baseline:{available:false}}),/Recorded Git repository/);
    assert.throws(()=>instructionSnapshot(cwd,{requireGit:true}),/Recorded Git repository/);
    assert.throws(()=>F.start(cwd,{assignment:undefined,resumeJobId:job.jobId,prompt:'Revise after metadata loss'}),/Recorded Git repository/);
  } finally {fs.renameSync(backup,metadata);}
  assertReviewInstructions(state);
});

test('H13 job-start baseline permits pre-existing ignored root configuration for both reviewers',async()=>{
  control({nativeText:'No defects found.'});const cwd=F.project();
  fs.appendFileSync(path.join(cwd,'.git/info/exclude'),'\n.codex/\nnode_modules/\n');
  fs.mkdirSync(path.join(cwd,'.codex'));fs.writeFileSync(path.join(cwd,'.codex/config.toml'),'# original ignored configuration');
  fs.mkdirSync(path.join(cwd,'node_modules','pkg'),{recursive:true});fs.writeFileSync(path.join(cwd,'node_modules/pkg/AGENTS.md'),'nested instructions');
  const done=await F.done(F.start(cwd,{prompt:'WRITE_CODE',autoVerify:true}));
  assert.ok(done.reviewInstructionBaseline['.codex/config.toml']);assert.equal(done.decisionPacket.status,'ready');
  assert.equal(done.nativeReview.status,'completed');assert.equal(done.execs.filter(e=>e.role==='reviewer').length,2);
  // The same ignored file changing in a later verification must block new launches.
  const saved=S.read(done.jobId);saved.assignment.verification=[{id:'answer',command:process.execPath,args:['-e',"require('fs').writeFileSync('.codex/config.toml','changed after verification began')"],allowInline:true,criteria:[0],timeoutSeconds:10}];S.save(saved);
  R.verifyJob({cwd,jobId:done.jobId});const repeated=await F.done(done);
  assert.equal(repeated.decisionPacket.status,'incomplete');assert.match(repeated.decisionPacket.reviewerError,/config.toml/);
  assert.equal(repeated.execs.filter(e=>e.role==='reviewer').length,2,'neither reviewer launches again');
  control({});
});

test('native plain-text fixture parses exact lead capture, relative paths, Windows spaces and multiline bodies',()=>{
  const root=F.project(),cwd=path.join(root,'Windows path with spaces');fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd,'stats.mjs'),'export function average(xs) {\n  let sum = 0;\n  for (let i = 1; i <= xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}\n');
  const state={...stateFor(cwd),assignment:F.assignment({scope:['stats.mjs']})};
  for(const location of [cwd.replaceAll('\\','/')+'/stats.mjs',path.join(cwd,'stats.mjs'),'stats.mjs','./stats.mjs']) {
    const text=nativeSample.replace('<ROOT>/stats.mjs',location);
    const parsed=parseNativeReview(text,state);assert.equal(parsed.droppedNativeFindings,0);
    assert.equal(parsed.findings.length,1);const f=parsed.findings[0];
    assert.equal(f.file,'stats.mjs');assert.equal(f.startLine,3);assert.equal(f.endLine,3);
    assert.equal(f.confidence,null);assert.equal(f.severity,'high');assert.equal(f.source,'native');
    assert.equal(f.title,'Iterate over valid zero-based array indices');assert.match(f.body,/average\(\[1, 2, 3\]\)/);
  }
  const multiple=Array.from({length:4},(_,priority)=>`- [P${priority}] Finding ${priority} — stats.mjs:2-3\n  First body line.\n  Second body line.`).join('\n\n');
  const parsed=parseNativeReview(multiple,state);
  assert.deepEqual(parsed.findings.map(f=>f.severity),['critical','high','medium','low']);
  assert.ok(parsed.findings.every(f=>f.body==='First body line.\nSecond body line.'));
  assert.deepEqual(parseNativeReview('The changes look correct.\nNo actionable findings.',state),{findings:[],droppedNativeFindings:0});
});

test('native drops individual out-of-scope, forbidden and invalid ranges without losing valid findings',()=>{
  const cwd=F.project();fs.writeFileSync(path.join(cwd,'answer.mjs'),'answer\n');
  const state=stateFor(cwd);
  const comment=(location,priority=1)=>`- [P${priority}] Defect — ${location}\n  A reproducible failure.`;
  const parsed=parseNativeReview([
    comment('existing.txt:1-1'),comment('answer.mjs:0-1'),comment('answer.mjs:1-2'),
    comment('../answer.mjs:1-1'),comment('answer.mjs:1-1'),
  ].join('\n'),state);
  assert.equal(parsed.droppedNativeFindings,4);assert.equal(parsed.findings.length,1);
  fs.writeFileSync(path.join(cwd,'.env'),'secret\n');
  const forbidden=parseNativeReview(comment('.env:1-1'),{...state,assignment:F.assignment({scope:['.']}),profile:{components:{secrets:{level:'enforce',forbiddenPaths:['.env']}}}});
  assert.equal(forbidden.droppedNativeFindings,1);assert.equal(forbidden.findings.length,0);
  assert.throws(()=>validateFindings([finding({confidence:null})],state),/confidence/);
  assert.throws(()=>validateFindings([finding({confidence:null,source:'reviewer'})],state,{native:true}),/source native/);
  assert.doesNotThrow(()=>validateFindings(parsed.findings,state,{native:true}));
});

test('native unknown confidence blocks both acceptance paths and records dropped findings',async()=>{
  const nativeText='- [P1] Native defect — answer.mjs:1-1\n  A caller fails.\n\n- [P0] Outside scope — existing.txt:1-1\n  Drop this finding.';
  control({nativeText});
  for(const evidence of ['packet',F.evidence]) {
    const done=await F.done(F.start(F.project(),{prompt:'WRITE_CODE',autoVerify:true}));
    assert.equal(done.nativeReview.status,'completed');assert.equal(done.nativeReview.droppedNativeFindings,1);
    assert.equal(done.decisionPacket.nativeReview.droppedNativeFindings,1);
    assert.equal(done.decisionPacket.findings[0].confidence,null);
    assert.throws(()=>F.accept(done,{evidence}),/findingDispositions/);
    assert.equal(F.accept(done,{evidence,findingDispositions:[{findingIndex:0,disposition:'accepted-risk',observation:'Lead assessed the failure.'}]}).status,'accepted');
  }
  for(const severity of ['critical','high'])assert.throws(()=>findingDispositions({decisionPacket:{findings:[finding({source:'native',confidence:null,severity})]}},[],true),/findingDispositions/);
  for(const severity of ['medium','low'])assert.doesNotThrow(()=>findingDispositions({decisionPacket:{findings:[finding({source:'native',confidence:null,severity})]}},[],true));
  control({});
});

test('evidence unwraps real PowerShell, bash and cmd compounds, ignoring listings and printed command text',()=>{
  const cwd=F.project(),files=['stats.mjs','other.mjs'];
  const observed=command=>[...fileReads([commandEvent(command)],files,cwd)];
  const real='"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'git diff; git diff --cached; Get-Content stats.mjs; $p = (Get-Location).Path; ...\'';
  assert.deepEqual(observed(real),['stats.mjs']);
  assert.deepEqual(observed('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'Get-Location; git status --short; Get-ChildItem -Force -Name\''),[]);
  for(const command of [
    'powershell -Command "Get-Location; Get-Content stats.mjs"',
    'bash -lc \'pwd && cat stats.mjs || cat stats.mjs | head\'',
    'cmd /c "echo ready && type stats.mjs || more stats.mjs"',
    'git status --short\nGet-Content stats.mjs',
  ])assert.deepEqual(observed(command),['stats.mjs'],command);
  for(const command of ['echo "cat stats.mjs; Get-Content other.mjs"','Write-Output \'cat stats.mjs; cat other.mjs\'','echo cat stats.mjs','git status --short','git log','Get-ChildItem stats.mjs'])assert.deepEqual(observed(command),[],command);
  for(const reader of ['Get-Content','gc','cat','type','more','head','tail','sed','awk','less'])assert.deepEqual(observed(`echo ready; ${reader} stats.mjs`),['stats.mjs'],reader);
  assert.equal(fileReads([{type:'item.completed',item:{type:'agent_message',text:real}}],files,cwd).size,0);
});

test('evidence git reads honor paths and searches credit filenames in output',()=>{
  const cwd=F.project(),files=['answer.mjs','existing.txt'];
  const observed=(command,output='')=>[...fileReads([commandEvent(command,output)],files,cwd)];
  for(const command of ['git diff','git diff --cached','git show','git show HEAD','git log -p'])assert.deepEqual(observed(command),[],command);
  for(const command of ['git diff -- answer.mjs','git show HEAD:answer.mjs','git blame answer.mjs','git log -p -- answer.mjs','git diff answer.mjs',`git diff -- "${path.join(cwd,'answer.mjs')}"`])assert.deepEqual(observed(command),['answer.mjs'],command);
  for(const search of ['rg','grep','Select-String','sls','findstr','git grep']) {
    assert.deepEqual(observed(`${search} -n answer .`,'answer.mjs:1:export const answer = 42;'),['answer.mjs'],search);
    assert.deepEqual(observed(`${search} -n answer .`,'No named files'),[],search);
    assert.deepEqual(observed(`${search} -n answer.mjs .`,'No named files'),[],search+' pattern is not a read');
  }
  assert.deepEqual(observed('echo "answer.mjs:1:read"','answer.mjs:1:read'),[]);
  const event=commandEvent('cat answer.mjs');event.item.exit_code=1;assert.equal(fileReads([event],files,cwd).size,0);
});

test('compound reads satisfy reviewer and scout floors and allow a validated scout to seed implementation',async()=>{
  const cwd=F.project();fs.writeFileSync(path.join(cwd,'answer.mjs'),'answer\n');
  const state={...stateFor(cwd),baseline:snapshot(cwd),changes:{files:['answer.mjs']}};
  const events=[commandEvent('pwsh -Command \'Get-Location; Get-Content answer.mjs; Get-Content existing.txt\'')];
  const report={criteria:[{hunks:[{file:'answer.mjs'}]}],findings:[finding()]};
  assert.equal(reviewerEvidenceFloor(report,{inline:false,files:[]},events,state),'passed');
  assert.equal(scoutEvidenceFloor(state,{files:[{path:'existing.txt',lines:[{startLine:1,endLine:1}]}]},events).status,'passed');
  control({});const scout=await F.done(F.start(F.project(),{mode:'scout',prompt:'COMPOUND_SCOUT_READ'}));
  assert.equal(scout.status,'implementation_finished');assert.equal(scout.evidenceFloor.status,'passed');
  const implementation=await F.done(F.start(scout.cwd,{fromScout:scout.jobId,prompt:'WRITE_CODE'}));
  assert.equal(implementation.status,'implementation_finished');
});
