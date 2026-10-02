/** Keep worker heartbeats alive during bounded synchronous Git/content observations. */
import {Worker,isMainThread,parentPort,workerData} from "node:worker_threads";
export function backgroundFacts(operation,state,{timeoutMs=60000,url=new URL(import.meta.url)}={}) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(url,{workerData:{operation,state}});let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{worker.unref();void worker.terminate();finish(Error("Post-check observation timed out: "+operation));},timeoutMs);
    worker.on("message",message=>finish(message.error?Error(message.error):null,message.value));
    worker.on("error",error=>finish(error));
    worker.on("exit",code=>{if(!settled)finish(Error("Post-check observation exited without a result: "+code));});
  });
}
if(!isMainThread && workerData?.operation) {
  try {
    const {operation,state}=workerData;
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
