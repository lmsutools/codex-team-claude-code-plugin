/** Only structured job IDs from correlated codex-team MCP results establish attribution. */
export const jobIdPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const codexTeamTool=name=>/^mcp__[^\s]*codex[-_]team[^\s]*__codex_[a-z_]+$/i.test(name || "");
export function resultJobIds(content, use) {
  if(!codexTeamTool(use?.name))return [];
  const name=use.name.split("__").at(-1).toLowerCase(), input=use.input || {};
  const individual=typeof input.jobId==="string" && !!input.jobId.trim();
  const batch=name==="codex_batch" && (input.action==="start" ||
    (["status","integrate"].includes(input.action) && typeof input.batchId==="string" && !!input.batchId.trim()));
  // Context/status listings describe a project, not the session that requested work.
  // Query arguments establish intent only; IDs still come exclusively from results.
  if(name!=="codex_start" && !batch &&
    !(individual && ["codex_status","codex_doctor","codex_cancel","codex_verify","codex_review","codex_integrate","codex_push","codex_report","codex_hygiene"].includes(name)))return [];
  const ids=new Set(), pending=[content];
  let visited=0;
  while(pending.length && visited++<4096) {
    let item=pending.pop();
    if(typeof item==="string") {if(item.length>1048576)throw Error("MCP attribution result exceeds bound");try{item=JSON.parse(item);}catch{continue;}}
    if(!item || typeof item!=="object")continue;
    if(Array.isArray(item)){if(item.length+visited+pending.length>4096)throw Error("MCP attribution traversal exceeds bound");pending.push(...item);continue;}
    if(item.type==="text" && typeof item.text==="string") {pending.push(item.text);continue;}
    if(typeof item.jobId==="string" && jobIdPattern.test(item.jobId))ids.add(item.jobId.toLowerCase());
    // Only transport/job/delegation containers. Never project jobs arrays, contributor
    // result/report objects, assignments, context, or untrusted envelopes.
    for(const key of ["job","content","structuredContent","revision","resumedJob","children"]) {
      if(item[key] && typeof item[key]==="object")pending.push(item[key]);
    }
    if(ids.size>256)throw Error("Session attribution exceeds job bound");
  }
  if(pending.length)throw Error("MCP attribution traversal exceeds bound");
  return [...ids];
}
/** A notification may cause a reply, but it does not start an owner's task. */
export function ownerPrompt(entry) {
  if(entry.isMeta || entry.isCompactSummary || entry.isSidechain || entry.toolUseResult || entry.source?.type==="hook")return false;
  const content=entry.message?.content;
  if(Array.isArray(content) && content.some(b=>b?.type==="tool_result"))return false;
  let text=typeof content==="string" ? content : Array.isArray(content) ? content.filter(b=>b?.type==="text").map(b=>b.text || "").join("\n") : "";
  text=text.replace(/<(task-notification|system-reminder|hook-feedback|hook-result|local-command-stdout|local-command-stderr)\b[^>]*>[\s\S]*?<\/\1>/gi, "").trim();
  if(/^(?:(?:Stop|PreToolUse|PostToolUse|UserPromptSubmit|SubagentStop|SessionEnd|PermissionRequest|PreCompact|PostCompact)\s+)?hook (?:feedback|result|error|additional context):|^SessionStart hook/i.test(text))return false;
  return !!text || (Array.isArray(content) && content.some(block=>["image","document"].includes(block?.type)));
}
