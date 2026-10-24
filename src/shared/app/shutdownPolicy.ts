import policy from './shutdownPolicy.json';

const gatewayGrace = policy.nativeShutdownMs + policy.nativeExitMarginMs;
const gatewayStop = gatewayGrace + policy.forceExitObservationMs;
const startupRetirement = policy.startupAbortMs + policy.forceExitObservationMs;
const applicationCleanup = startupRetirement + policy.otherAppCleanupMs + gatewayStop;
const applicationExit = applicationCleanup + policy.outerSchedulingMarginMs;

export const SHUTDOWN_BUDGET_MS = Object.freeze({
  nativeShutdown: policy.nativeShutdownMs,
  nativeExitMargin: policy.nativeExitMarginMs,
  gatewayGrace,
  gatewayStop,
  startupAbort: policy.startupAbortMs,
  startupRetirement,
  otherAppCleanup: policy.otherAppCleanupMs,
  forceExitObservation: policy.forceExitObservationMs,
  outerSchedulingMargin: policy.outerSchedulingMarginMs,
  applicationCleanup,
  applicationExit,
  launcherGrace: applicationExit + policy.outerSchedulingMarginMs,
});
