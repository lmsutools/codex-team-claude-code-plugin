/** Auto-verification defaults on for lead-authored sandboxed checks and restricted to sandboxed checks. */
export function autoVerifyGate(state,changed,checks=state.checkPlan?.checks || state.assignment?.verification || []) {
  return checks.some(check=>check.host===true)?{reason:"Host checks never run automatically; review and supply hostAck.",paths:[]}:null;
}
