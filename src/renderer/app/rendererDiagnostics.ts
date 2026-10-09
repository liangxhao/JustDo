/** Preserve Error stacks when Chromium forwards console messages to Main. */
export function registerRendererDiagnostics(): () => void {
  const originalError = console.error;
  const originalWarn = console.warn;
  const describe = (value: unknown, seen = new Set<unknown>()): string => {
    if (!value || typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[circular error cause]';
    seen.add(value);
    const error = value as {
      stack?: unknown;
      message?: unknown;
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    const text =
      typeof error.stack === 'string'
        ? error.stack
        : [error.name, error.message].filter(part => typeof part === 'string').join(': ');
    const code =
      typeof error.code === 'string' || typeof error.code === 'number'
        ? `\ncode=${error.code}`
        : '';
    const cause = error.cause === undefined ? '' : `\nCaused by: ${describe(error.cause, seen)}`;
    return (text || String(value)) + code + cause;
  };
  const format = (values: unknown[]) =>
    values.map(value => (value instanceof Error ? describe(value) : value));
  console.error = (...values: unknown[]) => originalError(...format(values));
  console.warn = (...values: unknown[]) => originalWarn(...format(values));
  const onError = (event: ErrorEvent) => {
    console.error(
      '[Renderer] Uncaught error:',
      event.error || event.message,
      `${event.filename}:${event.lineno}:${event.colno}`,
    );
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    console.error('[Renderer] Unhandled rejection:', describe(event.reason));
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    console.error = originalError;
    console.warn = originalWarn;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
