import { redactLogText } from '../diagnostics/redaction';

export const StartupFailureSource = {
  Main: 'main',
  Renderer: 'renderer',
  Preload: 'preload',
  Page: 'page',
} as const;

export type StartupErrorDetail = {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: StartupErrorDetail;
};

export type StartupFailure = {
  source: (typeof StartupFailureSource)[keyof typeof StartupFailureSource];
  occurredAt: number;
  error: StartupErrorDetail;
  context: Record<string, string>;
};

// Bound exception material without serializing config objects or arbitrary properties.
// Mask before truncating so a cut-off credential cannot evade the redactor.
export function captureStartupFailure(
  source: StartupFailure['source'],
  error: unknown,
  context: Record<string, string> = {},
  occurredAt = Date.now(),
): StartupFailure {
  const seen = new Set<unknown>();
  const text = (value: unknown, limit: number): string | undefined => {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    return redactLogText(String(value)).slice(0, limit);
  };
  const read = (value: unknown, key: string): unknown => {
    try {
      return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
    } catch {
      return undefined;
    }
  };
  const describe = (value: unknown, depth: number): StartupErrorDetail => {
    seen.add(value);
    const cause = read(value, 'cause');
    return {
      name: text(read(value, 'name'), 120) || 'Error',
      message: text(read(value, 'message'), 4000) ?? text(value, 4000) ?? 'Unknown error',
      code: text(read(value, 'code'), 120),
      stack: text(read(value, 'stack'), 8000),
      ...(cause !== undefined && depth < 3 && !seen.has(cause)
        ? { cause: describe(cause, depth + 1) }
        : {}),
    };
  };
  return {
    source,
    occurredAt,
    error: describe(error, 0),
    context: Object.fromEntries(
      Object.entries(context)
        .slice(0, 12)
        .map(([key, value]) => [key, text(value, 1000) ?? '']),
    ),
  };
}

export function startupFailureText(failure: StartupFailure): string {
  const describe = (error: StartupErrorDetail): string =>
    [
      `${error.name}${error.code ? ` [${error.code}]` : ''}: ${error.message}`,
      error.stack,
      error.cause && `Caused by: ${describe(error.cause)}`,
    ]
      .filter(Boolean)
      .join('\n');
  return [
    `${failure.source} · ${new Date(failure.occurredAt).toISOString()}`,
    ...Object.entries(failure.context).map(([key, value]) => `${key}: ${value}`),
    describe(failure.error),
  ].join('\n');
}
