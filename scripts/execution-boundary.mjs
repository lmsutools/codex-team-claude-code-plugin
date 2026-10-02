/** Older runtimes must see read-only rows; only this runtime decodes execution intent. */
export function encodeBoundary(state) {
  return state.containmentVersion === 1 ? { ...state, executionReadOnly: state.readOnly === true, executionWorkerProfile: state.workerProfile || "inherit", readOnly: true, workerProfile: "requires-1.1.6-reconnect" } : state;
}
export function decodeBoundary(state) {
  return state?.containmentVersion === 1 && state.executionReadOnly !== undefined ? { ...state, readOnly: state.executionReadOnly, workerProfile: state.executionWorkerProfile || "inherit" } : state;
}
