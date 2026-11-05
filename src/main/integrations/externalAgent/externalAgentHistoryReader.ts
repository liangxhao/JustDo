import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import type { ExternalAgentHistoryInput, ExternalAgentHistorySnapshot } from './externalAgentTypes';

type HistoryRuntime = Pick<OpenClawRuntimeAdapter,
  'getGatewayClient' | 'getGatewayClientGeneration' | 'fetchSessionHistoryByKey'>;

/** Read authenticated history without starting Gateway or resolving another session alias. */
export const createExternalAgentHistoryReader = (
  getRuntime: () => HistoryRuntime | null,
  timeoutMs = 30_000,
): ((input: ExternalAgentHistoryInput) => Promise<ExternalAgentHistorySnapshot>) => async input => {
  if (!input.sessionKey || !input.nativeSessionId || !input.lifecycleRevision)
    throw new Error('Native history identity is unavailable.');
  const runtime = getRuntime();
  const client = runtime?.getGatewayClient();
  if (!runtime || !client) throw new Error('Gateway is unavailable for history reads.');
  const generation = runtime.getGatewayClientGeneration();
  const controller = new AbortController();
  const assertCurrent = () => {
    if (controller.signal.aborted) throw new Error('Native history read timed out.');
    if (getRuntime() !== runtime || runtime.getGatewayClient() !== client ||
        runtime.getGatewayClientGeneration() !== generation)
      throw new Error('Gateway changed while reading native history.');
  };
  const describe = async () => {
    assertCurrent();
    const result = await client.request<{
      session?: { key?: string; sessionId?: string; lifecycleRevision?: string } | null;
    }>('sessions.describe', { key: input.sessionKey }, { signal: controller.signal, timeoutMs });
    assertCurrent();
    if (result?.session?.key !== input.sessionKey ||
        result.session.sessionId !== input.nativeSessionId ||
        result.session.lifecycleRevision !== input.lifecycleRevision)
      throw new Error('Native history identity changed.');
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Native history read timed out.'));
    }, timeoutMs);
  });
  const read = async (): Promise<ExternalAgentHistorySnapshot> => {
    await describe();
    const history = await runtime.fetchSessionHistoryByKey(input.sessionKey, undefined, {
      forceFullSnapshot: true,
      signal: controller.signal,
    });
    assertCurrent();
    if (!history || history.sessionKey !== input.sessionKey || !Array.isArray(history.messages))
      throw new Error('Native history snapshot is unavailable.');
    await describe();
    return { messages: history.messages };
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};
