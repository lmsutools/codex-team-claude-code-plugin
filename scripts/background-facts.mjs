/** Keep worker heartbeats alive during bounded synchronous Git/content observations. */
import {Worker,isMainThread,parentPort,workerData} from "node:worker_threads";
/**
 * Observations hash every tracked file and list hidden changes. On a loaded
 * machine (parallel cargo builds) that took far longer than the old fixed
 * 60 s, and a passed check run ended as "verification failed". The bound is
 * now load-aware: at least 3 minutes, or 8× the cost measured when this
 * verification started, capped at 15 minutes. CODEX_TEAM_OBSERVATION_TIMEOUT_MS
 * overrides it (1 s to 1 h).
 */
export const OBSERVATION_MIN_MS=180000, OBSERVATION_MAX_MS=900000;
export function observationTimeoutMs(state={},env=process.env) {
  const configured=Number(env.CODEX_TEAM_OBSERVATION_TIMEOUT_MS);
  if(Number.isFinite(configured) && configured>=1000) return Math.min(configured,3600000);
  const cost=Number(state?.verification?.observationCostMs ?? state?.observationCostMs);
  return Math.min(OBSERVATION_MAX_MS,Math.max(OBSERVATION_MIN_MS,Number.isFinite(cost) && cost>0 ? Math.ceil(cost*8) : 0));
}
/** A typed error: callers distinguish "the observer timed out" from "a check failed". */
export function observerTimeoutError(operation,timeoutMs) {
  const error=Error(`Post-check observation timed out: ${operation} (no result within ${Math.round(timeoutMs/1000)} s; the machine is likely under heavy load). This is not a check failure.`);
  error.observerTimeout=true;error.operation=operation;error.timeoutMs=timeoutMs;
  return error;
}
export function backgroundFacts(operation,state,{timeoutMs=observationTimeoutMs(state),url=new URL(import.meta.url)}={}) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(url,{workerData:{operation,state}});let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{worker.unref();void worker.terminate();finish(observerTimeoutError(operation,timeoutMs));},timeoutMs);
    worker.on("message",message=>finish(message.error?Error(message.error):null,message.value));
    worker.on("error",error=>finish(error));
    worker.on("exit",code=>{if(!settled)finish(Error("Post-check observation exited without a result: "+code));});
  });
}
/**
 * One retry with a doubled bound, only for an observer timeout. The returned
 * attempts record each bound and duration; a final timeout carries them too.
 */
export async function observeWithRetry(operation,state,{timeoutMs=observationTimeoutMs(state),retries=1,run=backgroundFacts,onRetry}={}) {
  const attempts=[];
  for(let attempt=0;;attempt++) {
    const bound=Math.min(3600000,timeoutMs*2**attempt), started=Date.now();
    try {
      const value=await run(operation,state,{timeoutMs:bound});
      attempts.push({timeoutMs:bound,durationMs:Date.now()-started,outcome:"observed"});
      return {value,attempts};
    } catch(error) {
      attempts.push({timeoutMs:bound,durationMs:Date.now()-started,outcome:error?.observerTimeout?"timed_out":"failed"});
      if(!error?.observerTimeout || attempt>=retries) { if(error && typeof error==="object") error.attempts=attempts; throw error; }
      await onRetry?.(attempt+1,Math.min(3600000,timeoutMs*2**(attempt+1)));
    }
  }
}
if(!isMainThread && workerData?.operation) {
  try {
    const {operation,state}=workerData;
    // Test-only timing injection, like CODEX_TEAM_TEST_BACKOFF_MS: emulate a slow, loaded disk.
    let delay=Number(process.env.CODEX_TEAM_TEST_OBSERVATION_DELAY_MS);
    // ..._DELAY_ONCE names a marker file: only the observation that creates it is delayed.
    const once=process.env.CODEX_TEAM_TEST_OBSERVATION_DELAY_ONCE;
    if(once && delay>0) { const fs=await import("node:fs"); try { fs.writeFileSync(once,"1",{flag:"wx"}); } catch { delay=0; } }
    if(Number.isFinite(delay) && delay>0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(delay,60000));
    const {snapshot}=await import("./git.mjs");
    let value;
    if(operation==="snapshot") value=snapshot(state.executionCwd);
    else if(operation==="hunks") {const {exactHunks}=await import("./baseline-bytes.mjs");value=exactHunks(state,state.current,state.hunkOptions);}
    else if(operation==="host") {const {inspectHostCheck}=await import("./verification-request.mjs");value=inspectHostCheck(state);}
    else if(operation==="verification") {const {finishVisibility}=await import("./visibility.mjs"),{jobDirectory}=await import("./state-reader.mjs");value={after:snapshot(state.executionCwd),...finishVisibility(state,jobDirectory(state.jobId))};}
    else throw Error("Unknown observation operation");
    parentPort.postMessage({value});
  }catch(error){parentPort.postMessage({error:error.message});}
}
