/** Reviewer instruction guard uses content deltas and stored visibility, never a filesystem walk. */
import {changes} from "./git.mjs";
export const instructionPath=file=>/(?:^|\/)(?:AGENTS(?:\.override)?\.md|\.codex(?:\/|$))/i.test(file.replaceAll("\\","/"));
export function reviewerInstructionGate(state,current) {
 const paths=[...new Set([...changes(state.baseline,current,["."]).files,...(state.hiddenChanges?.entries||[]).map(e=>e.file)].filter(instructionPath))];
 return paths.length?{reason:"Project instructions/configuration changed; reviewer configuration cannot be reliably disabled.",paths}:null;
}
