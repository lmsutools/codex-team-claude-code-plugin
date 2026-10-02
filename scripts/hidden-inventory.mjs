/** Deterministic advisory visibility; never walks ignored folders or gates execution. */
import fs from "node:fs";
import path from "node:path";
import { git, hash } from "./git.mjs";
import { boundedBytes } from "./baseline-bytes.mjs";
export function inventory(root) {
  let result;
  try {result=git(root,["status","--porcelain=v1","-z","--ignored=traditional","--untracked-files=normal"],true);}catch(error){return {status:"unavailable",entries:[],error:error.message.slice(0,500)};}
  if(result.status!==0 || result.error) return {status:"unavailable",entries:[],error:String(result.error?.message || result.stderr || "Git listing failed").slice(0,500)};
  const rows=result.stdout.split("\0"),entries=[];
  for (let i=0;i<rows.length;i++) { const row=rows[i]; if (/^[RC]|^.[RC]/.test(row)) i++; if (row.startsWith("?? ") || row.startsWith("!! ")) entries.push({file:row.slice(3),ignored:row.startsWith("!!")}); }
  entries.sort((a,b)=>a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { entries, fingerprint:hash(JSON.stringify(entries)) };
}
export function compareInventory(before, after, eventPaths=[], root=null) {
  if (!before || before.status === "unavailable" || after.status === "unavailable") return {heading:"hidden changes",status:"unavailable",entries:[],total:0,omitted:0,reason:!before?"No stored listing for this revision.":"Git listing unavailable; visibility is advisory.",...((before?.error||after.error)?{error:before?.error||after.error}:{})};
  const old=new Map(before.entries.map(e=>[e.file,e])), next=new Map(after.entries.map(e=>[e.file,e])), changes=new Map();
  for(const file of [...new Set([...old.keys(),...next.keys()])].sort()) if(JSON.stringify(old.get(file))!==JSON.stringify(next.get(file))) changes.set(file,{file,kind:!old.has(file)?"new":!next.has(file)?"removed":"changed"});
  const ignored=[...old.values(),...next.values()].filter(e=>e.ignored).map(e=>e.file);
  for(const file of eventPaths) if(ignored.some(p=>file===p || file.startsWith(p.endsWith("/")?p:p+"/"))) changes.set(file,{file,kind:"reported",...changes.get(file),source:"Codex file event or command"});
  const all=[...changes.values()].sort((a,b)=>a.file < b.file ? -1 : a.file > b.file ? 1 : 0); let bytes=0;
  for(const entry of all.slice(0,200)) if(root && entry.kind==="new") {try {const target=path.resolve(root,entry.file),stat=fs.lstatSync(target);if(stat.isFile()&&bytes+stat.size<=1048576){const content=boundedBytes(target,1048576-bytes);entry.hash=hash(content);bytes+=content.length;}}catch{entry.hashUnavailable=true;}}
  return {heading:"hidden changes",status:"available",entries:all.slice(0,200),total:all.length,omitted:Math.max(0,all.length-200),counts:{new:all.filter(e=>e.kind==="new").length,changed:all.filter(e=>["changed","reported"].includes(e.kind)).length,removed:all.filter(e=>e.kind==="removed").length},listingHash:after.fingerprint};
}
export const verificationFingerprint = snapshot => snapshot.fingerprint;
export const hiddenState = state => ({changes:state.hiddenChanges || compareInventory(null,{entries:[]}),current:null});
