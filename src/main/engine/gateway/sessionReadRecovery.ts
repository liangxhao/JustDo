/** A retired plugin instance reports this exact native failure on read operations. */
export function isRetiredPluginReadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { gatewayCode, code } = error as Error & { gatewayCode?: unknown; code?: unknown };
  return (gatewayCode ?? code) === 'UNAVAILABLE' &&
    /^PluginInstanceUnavailableError: Plugin [^\s]{1,128} was reloaded or disabled; use its current tools\.$/.test(error.message);
}
