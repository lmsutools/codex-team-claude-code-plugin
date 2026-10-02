/** Bounded exact line accounting. Unknown is preferable to attributing unchanged context. */
export const textLines = text => String(text).replace(/\r\n/g, "\n").match(/[^\n]*\n|[^\n]+$/g) || [];
export function lineDifference(before, after, { maxSteps = 1000000 } = {}) {
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > 512 * 1024) return null;
  const a = textLines(before), b = textLines(after);
  let start=0, aEnd=a.length, bEnd=b.length, steps=0;
  while(start<aEnd && start<bEnd && a[start]===b[start]) start++;
  while(aEnd>start && bEnd>start && a[aEnd-1]===b[bEnd-1]) {aEnd--;bEnd--;}
  const n=aEnd-start,m=bEnd-start;
  if(!n || !m) return {added:m,removed:n};
  const frontier=new Map([[1,0]]);
  for(let d=0;d<=n+m;d++) for(let k=-d;k<=d;k+=2) {
    if(++steps>maxSteps) return null;
    let x=k===-d || (k!==d && (frontier.get(k-1) ?? -1)<(frontier.get(k+1) ?? -1)) ? frontier.get(k+1) || 0 : (frontier.get(k-1) || 0)+1;
    let y=x-k;
    while(x<n && y<m && a[start+x]===b[start+y]) {x++;y++;if(++steps>maxSteps)return null;}
    frontier.set(k,x);
    if(x>=n && y>=m) return {added:(d+m-n)/2,removed:(d+n-m)/2};
  }
  return null;
}
/** Claude tool results may include exact structured patches or the original bytes. */
export function editLineStats(use, result) {
  const input=use.input || {};
  if(use.name==="NotebookEdit" && (input.cell_type==="markdown" || result?.cell_type==="markdown"))return {added:0,removed:0};
  if(Array.isArray(result?.structuredPatch) && result.structuredPatch.length) {
    let added=0,removed=0;
    let visited=0;
    for(const hunk of result.structuredPatch) {
      if(!Array.isArray(hunk?.lines))return null;
      for(const line of hunk.lines) {
      if(++visited>65536 || typeof line!=="string")return null;
      if(line.startsWith("+")) added++;
      else if(line.startsWith("-")) removed++;
      }
    }
    return {added,removed};
  }
  if(use.name==="Edit" || use.name==="MultiEdit") {
    let added=0,removed=0;
    const edits=use.name==="MultiEdit" ? input.edits : [input];
    if(!Array.isArray(edits) || edits.length>1000)return null;
    for(const edit of edits) {
      if(typeof edit.old_string!=="string" || typeof edit.new_string!=="string" || edit.replace_all) return null;
      const diff=lineDifference(edit.old_string,edit.new_string);if(!diff)return null;
      added+=diff.added;removed+=diff.removed;
    }
    return {added,removed};
  }
  if(use.name==="Write") {
    if(typeof input.content!=="string")return null;
    if(result?.type==="create")return lineDifference("",input.content);
    const before=result?.originalFile ?? result?.old_content;
    return typeof before==="string" ? lineDifference(before,input.content) : null;
  }
  if(use.name==="NotebookEdit") {
    if(input.cell_type==="markdown" || result?.cell_type==="markdown")return {added:0,removed:0};
    if(input.edit_mode==="insert")return lineDifference("",input.new_source || "");
    const before=result?.old_source ?? result?.originalSource;
    return typeof before==="string" ? lineDifference(before,input.edit_mode==="delete" ? "" : input.new_source || "") : null;
  }
  return null;
}
