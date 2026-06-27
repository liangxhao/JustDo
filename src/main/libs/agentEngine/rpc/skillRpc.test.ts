import { afterEach, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../../coworkStore';
import type { GatewayClientLike } from '../gateway/types';
import { SkillRpcHandler } from './skillRpc';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('generateTitle falls back quietly when the gateway title request times out', async () => {
  vi.useFakeTimers();
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const client: GatewayClientLike = {
    start: () => {},
    stop: () => {},
    request: () => new Promise(() => {}),
  };
  const handler = new SkillRpcHandler({
    ensureGatewayClientReady: async () => {},
    requireGatewayClient: () => client,
    getGatewayClient: () => client,
    store: {} as CoworkStore,
  });

  const titlePromise = handler.generateTitle('请帮我介绍一下 JustDo', 1_000);
  await vi.advanceTimersByTimeAsync(1_000);

  await expect(titlePromise).resolves.toBe('请帮我介绍一下 JustDo');
  expect(debugSpy).toHaveBeenCalledWith(
    '[OpenClawRuntime] generateTitle: timed out after 1000ms. Using fallback title.',
  );
  expect(warnSpy).not.toHaveBeenCalledWith(
    expect.stringContaining('[OpenClawRuntime] generateTitle: request failed:'),
    expect.anything(),
  );
});

test('generateTitle deletes the temporary OpenClaw title session after completion', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'agent') {
      return {
        status: 'ok',
        result: {
          payloads: [{ text: '问候与介绍' }],
        },
      };
    }
    if (method === 'sessions.delete') {
      return { ok: true };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const client: GatewayClientLike = {
    start: () => {},
    stop: () => {},
    request,
  };
  const handler = new SkillRpcHandler({
    ensureGatewayClientReady: async () => {},
    requireGatewayClient: () => client,
    getGatewayClient: () => client,
    store: {} as CoworkStore,
  });

  await expect(handler.generateTitle('你好，请介绍一下你自己')).resolves.toBe('问候与介绍');
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith(
      'sessions.delete',
      {
        key: expect.stringMatching(/^title:/),
        deleteTranscript: true,
      },
    );
  });
});
