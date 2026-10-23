/** Observed public error text, never a claim about a private native rejection branch. */
export const DiagnosticRuntimeFailure = {
  ReplayAdmissionRejected: 'replay_admission_rejected',
} as const;
export type DiagnosticRuntimeFailure =
  (typeof DiagnosticRuntimeFailure)[keyof typeof DiagnosticRuntimeFailure];

const replayAdmissionMessage = 'Persisted user turn changed before replay admission';
const replayAdmissionErrors = new Set([
  replayAdmissionMessage,
  `Error: ${replayAdmissionMessage}`,
  `Your request couldn't be completed: ${replayAdmissionMessage}`,
  `Your request couldn't be completed: Error: ${replayAdmissionMessage}`,
]);

/** Call only on error fields of an authenticated failure event or native failure receipt. */
export function identifyDiagnosticRuntimeFailure(
  value: unknown,
): DiagnosticRuntimeFailure | undefined {
  return typeof value === 'string' && replayAdmissionErrors.has(value.trim())
    ? DiagnosticRuntimeFailure.ReplayAdmissionRejected
    : undefined;
}
