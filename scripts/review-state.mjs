/** Review observations are captured outside database write transactions. */
import {reviewFingerprint,verificationCommands} from "./sandbox-checks.mjs";
import {planChecks} from "./gates.mjs";
import {changes} from "./git.mjs";
export function storedReview(state,current,{includeProfileChecks}={}) {
  try {
    const checkPlan=state.profile ? planChecks(state,current,changes(state.baseline,current,state.assignment.scope).files,{preview:true,includeProfileChecks}) : state.checkPlan;
    const observed={...state,...(checkPlan?{checkPlan}:{})};
    let withoutProfile;
    try {
      const plan=state.profile ? planChecks(state,current,changes(state.baseline,current,state.assignment.scope).files,{preview:true,includeProfileChecks:false}) : null;
      withoutProfile={reviewFingerprintWithoutProfile:reviewFingerprint({...state,checkPlan:plan},current.fingerprint),reviewWithoutProfileReason:null,reviewCommandsWithoutProfile:plan?.checks || state.assignment.verification};
    } catch(error) {withoutProfile={reviewFingerprintWithoutProfile:null,reviewWithoutProfileReason:error.message.slice(0,300)};}
    return {...withoutProfile,reviewBaseline:current,reviewVisibility:{hiddenChanges:state.hiddenChanges,gitConfigChanged:state.gitConfigChanged},reviewFingerprint:reviewFingerprint(observed,current.fingerprint),reviewFingerprintReason:null,reviewVerificationCommands:verificationCommands(observed),reviewObservedAt:new Date().toISOString()};
  }catch(error){return {reviewFingerprint:null,reviewFingerprintReason:error.message.slice(0,300),reviewFingerprintWithoutProfile:null,reviewWithoutProfileReason:error.message.slice(0,300)};}
}
