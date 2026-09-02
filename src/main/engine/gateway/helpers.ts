/** Minimal helpers shared by the Main-process Gateway lifecycle adapter. */

export const OPENCLAW_GATEWAY_TOOL_EVENTS_CAP = 'tool-events';
export const GATEWAY_READY_TIMEOUT_MS = 90_000;

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

export const waitWithTimeout = async (
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> => {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`OpenClaw gateway client connect timeout after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};
