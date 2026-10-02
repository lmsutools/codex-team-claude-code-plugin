/** Opt-in UserPromptSubmit hook. No plugin imports on the non-command path. */
import fs from "node:fs";
const cli=process.argv[2] === "--cli";
let input, match;
try {
  if(cli) input={cwd:process.cwd(),prompt:"/codex-team:"+process.argv.slice(3).join(" ")};
  else input=JSON.parse(fs.readFileSync(0,"utf8"));
  match=/^\s*\/codex-team:(status|result|cancel|stats)\b/.exec(input.prompt || "");
} catch { process.exit(0); }
if(!match && !cli) process.exit(0);
const clean = text => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const cleanValue = value => typeof value === "string" ? clean(value) : Array.isArray(value) ? value.map(cleanValue) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key,item])=>[clean(key),cleanValue(item)])) : value;
let output;
// Never truncate an encoded envelope or its closing delimiter. Bound the nested
// hook serialization too, so CLI and hook users see the identical intact frame.
async function framed(value) {
  const {untrustedOutput}=await import("./untrusted-output.mjs");
  let safe=cleanValue(value), text;
  const encode=()=>"--- BEGIN UNTRUSTED CODEX OUTPUT ---\n"+JSON.stringify(untrustedOutput(safe))+"\n--- END OF UNTRUSTED CODEX TEXT ---";
  text=encode();
  if(text.length>6000 || JSON.stringify({decision:"block",reason:text}).length>7999) {
    let report=JSON.stringify(safe);
    do { report=report.slice(0,Math.floor(report.length*.8));safe={report:report+" [truncated]"};text=encode(); }
    while(text.length>6000 || JSON.stringify({decision:"block",reason:text}).length>7999);
  }
  return text;
}
try {
  if(!match) throw Error("Usage: commands.mjs --cli status|result|cancel|stats [job prefix]");
  const {git}=await import("./git.mjs");
  const path=await import("node:path");
  const {stateRoot,openReadOnlyStore,readJob,jobDirectory}=await import("./state-reader.mjs");
  const cwd=fs.realpathSync(git(input.cwd,["rev-parse","--show-toplevel"]).stdout.trim());
  const key=value=>process.platform === "win32" ? value.toLowerCase() : value;
  const args=input.prompt.slice(match[0].length).trim().split(/\s+/).filter(Boolean), command=match[1];
  if(command === "stats") {
    if(args.length) throw Error("Usage: /codex-team:stats");
    const {statsCommand}=await import("./stats.mjs");output=statsCommand(["--project",cwd]);
  } else {
    const prefix=args[0];
    let jobs=[],selected=[];
    if(fs.existsSync(path.join(stateRoot(),"state.sqlite"))) {
      const db=openReadOnlyStore();
      try {
        const columns="id AS jobId,json_extract(state,'$.status') AS status,json_extract(state,'$.autoVerify') AS autoVerify";
        jobs=db.prepare(`SELECT ${columns} FROM jobs WHERE cwd=? ORDER BY created DESC LIMIT 30`).all(key(cwd));
        if(prefix)selected=db.prepare(`SELECT ${columns} FROM jobs WHERE cwd=? AND substr(id,1,?)=? ORDER BY created DESC LIMIT 30`).all(key(cwd),prefix.length,prefix);
        for(const job of [...jobs,...selected])job.autoVerify=job.autoVerify==null ? undefined : !!job.autoVerify;
      }
      finally {db.close();}
    }
    const line=job=>`${job.jobId} ${job.status}${job.autoVerify === undefined ? "" : " autoVerify="+job.autoVerify}`;
    const candidates=values=>values.length ? values.slice(0,30).map(line).join("\n") : "No jobs in this project.";
    if(args.length>1) output="Expected one job ID prefix. Candidates:\n"+candidates(jobs);
    else if(command === "status" && !prefix) output=candidates(jobs);
    else if(selected.length!==1) output=(!prefix ? "Missing job ID prefix." : selected.length ? "Ambiguous job ID prefix." : "Unknown job ID prefix.")+" Candidates:\n"+candidates(selected.length?selected:jobs);
    else {
      const job=readJob(selected[0].jobId);
      if(command === "status") {
        const {compactJob}=await import("./tool-output.mjs");output=await framed(compactJob(job));
      } else if(command === "result") {
        let report=job.decisionPacket || job.result;
        if(!report) {
          const file=path.join(jobDirectory(job.jobId),"report.txt");
          const {readBounded}=await import("./observer.mjs");
          report=fs.existsSync(file) ? readBounded(file,6000).text : "No report available yet.";
        }
        output=await framed({report});
      } else {
        const {cancelJob}=await import("./runtime.mjs");output=await framed(cancelJob({cwd,jobId:job.jobId}));
      }
    }
  }
} catch(error) {output="codex-team: "+String(error.message || "Command failed").split(/\r?\n/)[0].slice(0,500);}
output=clean(output);
while(JSON.stringify({decision:"block",reason:output}).length>7999) output=output.slice(0,Math.floor(output.length*.9));
if(cli) console.log(output);
else {
  // Bound the serialized hook response too, including escape expansion and the final newline.
  while(JSON.stringify({decision:"block",reason:output}).length>7999) output=output.slice(0,Math.floor(output.length*.9));
  console.log(JSON.stringify({decision:"block",reason:output}));
}
