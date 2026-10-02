/** Collapsed Git visibility is deterministic advisory evidence, never an execution gate. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {inventory,compareInventory,verificationFingerprint} from "../scripts/hidden-inventory.mjs";
import {captureVisibility,finishVisibility} from "../scripts/visibility.mjs";
import {git,snapshot} from "../scripts/git.mjs";
import {gitSecuritySnapshot,compareGitSecurity} from "../scripts/git-security.mjs";
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"hidden-listing-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 process.env.CODEX_TEAM_STATE=path.join(root,".state");
 git(root,["init","-q"]);const write=(name,text)=>{fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),text);};
 write(".gitignore",".state/\nnode_modules/\n*.pyc\n.venv/\nlarge.dat\n.pytest_cache/\n__pycache__/\n.eslintcache\n");git(root,["add",".gitignore"]);return{root,write};
}
test("collapsed listing includes Git ignore semantics and Codex hints without ignored walks",t=>{
 const {root,write}=fixture(t);write("node_modules/dep/index.js","before");const before=inventory(root);
 write("tests/hidden/.gitignore","*\n");write("tests/hidden/evil.js","evil");write("pytest.pyc","bytecode");write("node_modules/dep/index.js","after");write(".venv/Lib/site-packages/evil.pth","import evil");
 const delta=compareInventory(before,inventory(root),["node_modules/dep/index.js",".venv/Lib/site-packages/evil.pth"],root);
 for(const name of ["tests/","pytest.pyc","node_modules/dep/index.js",".venv/Lib/site-packages/evil.pth"]) assert.ok(delta.entries.some(e=>e.file===name),JSON.stringify(delta));
 assert.ok(!inventory(root).entries.some(e=>e.file==="node_modules/dep/index.js"));assert.equal(delta.sensitive,undefined);
 assert.deepEqual(delta,compareInventory(before,inventory(root),["node_modules/dep/index.js",".venv/Lib/site-packages/evil.pth"],root));
});
test("timestamps and generated ignored caches never change verification/acceptance fingerprints",t=>{
 const {root,write}=fixture(t);write("large.dat",Buffer.alloc(100000,1));const before=inventory(root),content=snapshot(root),stat=fs.statSync(path.join(root,"large.dat"));
 write("large.dat",Buffer.alloc(100000,2));fs.utimesSync(path.join(root,"large.dat"),stat.atime,stat.mtime);
 assert.deepEqual(inventory(root),before);
 for(const file of [".pytest_cache/v/cache/nodeids","__pycache__/test.pyc","node_modules/.vite/index.js",".eslintcache"])write(file,"cache");
 assert.equal(verificationFingerprint(snapshot(root),inventory(root)),content.fingerprint);
 assert.deepEqual(compareInventory(before,inventory(root)),compareInventory(before,inventory(root)));
});
test("core.excludesFile, info/exclude and nested self-ignore use Git listing semantics",t=>{
 const {root,write}=fixture(t);write("excludes","configured-hidden/\n");git(root,["config","core.excludesFile",path.join(root,"excludes")]);write("configured-hidden/module.js","hidden");write(".git/info/exclude","other/\n");write("other/evil","hidden");
 assert.ok(inventory(root).entries.some(e=>e.file==="configured-hidden/"));assert.ok(inventory(root).entries.some(e=>e.file==="other/"));
 const before=gitSecuritySnapshot(root);write(".git/info/exclude","other/\nnext/\n");assert.deepEqual(compareGitSecurity(before,gitSecuritySnapshot(root)).paths,["info/exclude"]);
});
test("visibility is capped, sorted, hash-budgeted and unavailable for legacy revisions",t=>{
 const {root,write}=fixture(t),before=inventory(root);
 for(let i=0;i<210;i++)write(String(i).padStart(3,"0")+".pyc",Buffer.alloc(8192,i));
 const after=inventory(root),delta=compareInventory(before,after,[],root);assert.equal(delta.total,210);assert.equal(delta.entries.length,200);assert.equal(delta.omitted,10);assert.equal(delta.entries.filter(e=>e.hash).length,128);
 const dir=path.join(root,".git","visibility");fs.mkdirSync(dir);const state={executionCwd:root};captureVisibility(state,dir);write("node_modules/dep/index.js","evil");
 const result=finishVisibility(state,dir,['node node_modules/dep/index.js']);assert.ok(result.hiddenChanges.entries.some(e=>e.file==="node_modules/dep/index.js"));assert.equal(result.hiddenBaseline,undefined);assert.equal(result.verificationHidden,undefined);
 assert.equal(finishVisibility({...state,visibilityUnavailable:true},dir).hiddenChanges.status,"unavailable");
});
test("junction fixture produces a collapsed listing without per-target metadata",t=>{
 const {root,write}=fixture(t);write("target/file","safe");try{fs.symlinkSync(path.join(root,"target"),path.join(root,"node_modules"),"junction");}catch(e){t.skip("Link creation unavailable: "+e.code);return;}
 const result=inventory(root);assert.ok(result.entries.some(e=>e.file.startsWith("node_modules")));assert.ok(result.entries.length<10);
});


test("unavailable Git listing is advisory rather than an execution gate",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"no-git-visibility-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));process.env.CODEX_TEAM_STATE=path.join(root,"state");
 const listing=inventory(root);assert.equal(listing.status,"unavailable");const delta=compareInventory(listing,listing);assert.equal(delta.status,"unavailable");assert.equal(delta.sensitive,undefined);assert.ok(delta.error);
});
