/** File-only waiter presence: observers never mutate the job database. */
import fs from "node:fs";
import path from "node:path";
export const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
export const clockTime = until => new Date(until).toLocaleTimeString("en-GB", {hour:"2-digit",minute:"2-digit"});
export function actor(state) {
  const role = state.livePhase === "reviewer" ? "reviewer" : "codex";
  const pid = !state.childRole || state.childRole === role ? state.codexPid : null;
  if (state.livePhase === "reviewer") return {who:`Codex reviewer${pid ? ` (pid ${pid})` : ""}`,phase:"reviewing"};
  if (state.status === "verifying") { const mode=(state.activeCheck ? state.activeCheck.host : (state.checkPlan?.checks || state.assignment?.verification || []).some(c=>c.host)) ? "host" : "sandboxed"; return {who:`plugin check runner, ${mode}`,phase:`running checks (${mode})`}; }
  if (["starting","running"].includes(state.status)) return {who:`Codex implementer${pid ? ` (pid ${pid})` : ""}`,phase:"coding"};
  return {who:"waiting for Claude",phase:"waiting for Claude"};
}
export function registerWatcher(root,jobId,until) {
  if (!/^[a-zA-Z0-9-]+$/.test(jobId)) throw Error("Invalid watcher job ID");
  const dir=path.join(root,"watchers"),file=path.join(dir,`${jobId}.${process.pid}.json`),tmp=file+".tmp";
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,jobId,startedAt:new Date().toISOString(),until:new Date(until).toISOString()}),{mode:0o600}); fs.renameSync(tmp,file);
  const cleanup = () => {try{fs.unlinkSync(file);}catch{} process.off("exit",cleanup);process.off("SIGTERM",terminate);process.off("SIGINT",terminate);};
  const terminate = () => {cleanup();process.exit(0);};
  process.once("exit",cleanup);process.once("SIGTERM",terminate);process.once("SIGINT",terminate);
  return cleanup;
}
export function liveWatchers(root,jobId,now=Date.now()) {
  const dir=path.join(root,"watchers"),result=[];
  try { const handle=fs.opendirSync(dir); try { for(let live=0,entry;live<1024 && (entry=handle.readSync());) {
    if (!entry.name.endsWith(".json")) continue;
    try { const file=path.join(dir,entry.name);if(fs.statSync(file).size>4096)continue;const value=JSON.parse(fs.readFileSync(file,"utf8"));if(Date.parse(value.until)>now && alive(value.pid)) {live++;if(value.jobId===jobId) result.push(value);} else fs.unlinkSync(file); } catch {}
  }} finally{handle.closeSync();} }catch{}
  return result.sort((a,b)=>Date.parse(a.until)-Date.parse(b.until));
}
export function waiterLine(state,until) {
  // Scout-derived labels remain clearly delimited data, even on the opening line.
  const label=String(state.requestId || state.assignment?.objective || state.jobId).replace(/[\r\n\x00-\x1f]/g," ").slice(0,100);
  const drafted=state.provenance?.draftedFields?.includes("objective") && !state.requestId;
  return `codex-team waiter (Claude's, read-only) · job ${drafted ? '[UNTRUSTED TEXT WRITTEN BY CODEX: ' : ''}${JSON.stringify(label)}${drafted ? ']' : ''} [${state.jobId.slice(0,8)}] · working: ${actor(state).who} · wakes Claude by ${clockTime(until)} or on a phase change.`;
}
