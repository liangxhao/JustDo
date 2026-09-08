/** A transport failure after dispatch does not prove Gateway rejected the work. */
export function isGatewayRequestOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & {
    gatewayCode?: unknown;
    code?: unknown;
    requestSent?: unknown;
  };
  if (typeof failure.gatewayCode === 'string' || failure.requestSent === false) return false;
  return (failure.code === 'CLIENT_TIMEOUT' && failure.requestSent === true) ||
    /^(?:request timeout:|gateway closed \(\d+\)(?::|$)|gateway client stopped|connection (?:closed|lost))/i.test(failure.message);
}
