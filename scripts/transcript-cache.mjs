/** Incremental transcript cache: bounded first sight, streaming catch-up and stale pruning. */
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
function prune(dir, now) {
  const marker=path.join(dir,".pruned");
  try { if(now-fs.statSync(marker).mtimeMs<3600000) return; } catch {}
  fs.mkdirSync(dir,{recursive:true});
  const cursorFile=path.join(dir,".prune-cursor");let skip=0;try{skip=Number(fs.readFileSync(cursorFile,"utf8"))||0;}catch{}
  const scan=fs.opendirSync(dir),deadline=performance.now()+20;let position=0,removed=0,complete=false;
  try {let entry;while(performance.now()<deadline) {
    entry=scan.readSync();if(!entry){complete=true;break;}position++;
    if(position<=skip || !entry.name.endsWith(".json")) continue;
    const file=path.join(dir,entry.name);try{if(now-fs.statSync(file).mtimeMs>7*86400000){fs.unlinkSync(file);removed++;}}catch{}
  }} finally{scan.closeSync();}
  fs.writeFileSync(cursorFile,String(complete?0:Math.max(0,position-removed)));
  if(complete)fs.writeFileSync(marker,"");
}
export function incrementalTranscript(file,root,parse,{maxBytes=1048576}={}) {
  const stat=fs.statSync(file),dir=path.join(root,"transcripts"); prune(dir,Date.now());
  const cacheFile=path.join(dir,createHash("sha256").update(path.resolve(file)).digest("hex")+".json");
  let saved;try{if(fs.statSync(cacheFile).size<=4*1048576)saved=JSON.parse(fs.readFileSync(cacheFile,"utf8"));}catch{}
  if(saved?.parserVersion!==(parse.cacheVersion || 0))saved=null;
  if(saved?.ino!==stat.ino || saved.offset>stat.size || (saved.offset===stat.size && saved.mtimeMs!==stat.mtimeMs))saved=null;
  if(saved?.offset===stat.size && !saved.value.historyIncomplete) return saved.value;
  const catchup=!!saved?.value.historyIncomplete;
  let offset=catchup?0:saved?.offset||0, partial=false;
  if(!saved && stat.size>maxBytes) {offset=stat.size-maxBytes;partial=true;}
  let value=catchup?null:saved?.value,skip=partial || !!saved?.skippingLine,dropped=false;
  const fd=fs.openSync(file,"r"),buffer=Buffer.alloc(5*1048576);let position=offset,used=0;
  const consume=bytes=>{if(!parse.acceptsChunk || parse.acceptsChunk(bytes)) value=parse(bytes.toString("utf8"),value);};
  try {
    while(position<stat.size) {
      const n=fs.readSync(fd,buffer,used,Math.min(1048576,buffer.length-used,stat.size-position),position);if(!n)break;position+=n;used+=n;
      if(skip){const end=buffer.subarray(0,used).indexOf(10);if(end<0){used=0;continue;}buffer.copyWithin(0,end+1,used);used-=end+1;skip=false;}
      const end=buffer.subarray(0,used).lastIndexOf(10);
      if(end>=0){consume(buffer.subarray(0,end+1));buffer.copyWithin(0,end+1,used);used-=end+1;}
      if(used===buffer.length){used=0;skip=true;dropped=true;}
    }
  } finally{fs.closeSync(fd);}
  try{if(used){const bytes=buffer.subarray(0,used);JSON.parse(bytes.toString("utf8"));consume(bytes);used=0;}}catch{}
  value ||= parse("",null); value.historyIncomplete=partial;
  if(dropped || saved?.value?.historyGap) value.historyGap=true;
  const next={parserVersion:parse.cacheVersion || 0,ino:stat.ino,mtimeMs:stat.mtimeMs,offset:position-used,skippingLine:skip && !partial,value},serialized=JSON.stringify(next);
  if(serialized.length>4*1048576)throw Error("Transcript state exceeds bound");
  const temp=cacheFile+"."+process.pid+".tmp";fs.writeFileSync(temp,serialized,{mode:0o600});fs.renameSync(temp,cacheFile);return value;
}
