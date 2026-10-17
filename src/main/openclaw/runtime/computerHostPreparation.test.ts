import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayClientLike } from '../../engine/gateway/types';
import { ComputerHostPreparation } from './computerHostPreparation';

const enabledConfig = {
  plugins: { entries: { 'cua-computer': { enabled: true } } },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(config: unknown = enabledConfig) {
  const response = deferred<{ available: boolean }>();
  const request = vi.fn(() => response.promise);
  const client = { request } as unknown as GatewayClientLike;
  const preparer = new ComputerHostPreparation();
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const preparation = { client, config, processGeneration: 1, configGeneration: 2, isCurrent: () => true };
  return { response, request, client, preparer, preparation, log };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => vi.restoreAllMocks());

describe('ComputerHostPreparation', () => {
  it('prepares through status without awaiting startup or issuing computer actions', async () => {
    const h = harness();
    expect(h.preparer.start(h.preparation)).toBeUndefined();
    await flush();
    expect(h.request).toHaveBeenCalledExactlyOnceWith('computer.status', {}, { timeoutMs: 60_000 });
    expect(h.log).not.toHaveBeenCalled();
    h.response.resolve({ available: true });
    await flush();
    expect(h.log).toHaveBeenCalledWith('[ComputerHostPreparation]', {
      elapsedMs: expect.any(Number), available: true,
    });
  });

  it.each([
    undefined,
    {},
    { plugins: { entries: { 'cua-computer': { enabled: false } } } },
    { plugins: { ...enabledConfig.plugins, enabled: false } },
    { plugins: { ...enabledConfig.plugins, deny: ['cua-computer'] } },
    { plugins: { ...enabledConfig.plugins, allow: ['another-plugin'] } },
    { ...enabledConfig, tools: { deny: [' COMPUTER '] } },
    { ...enabledConfig, tools: { deny: ['*'] } },
  ])('does not prepare an unconfigured, disabled or explicitly denied host: %j', async config => {
    const h = harness();
    h.preparer.start({ ...h.preparation, config });
    await flush();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('coalesces in-flight requests but never caches an availability result', async () => {
    const h = harness();
    h.preparer.start(h.preparation);
    h.preparer.start(h.preparation);
    await flush();
    h.preparer.start(h.preparation);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.response.resolve({ available: false });
    await flush();
    h.preparer.start(h.preparation);
    await flush();
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('isolates a replacement client and does not let an old result clear its preparation', async () => {
    const h = harness();
    const nextResponse = deferred<{ available: boolean }>();
    const nextRequest = vi.fn(() => nextResponse.promise);
    const next = { ...h.preparation, client: { request: nextRequest } as unknown as GatewayClientLike };
    h.preparer.start(h.preparation);
    await flush();
    h.preparer.start(next);
    h.response.resolve({ available: false });
    await flush();
    h.preparer.start(next);
    await flush();
    expect(nextRequest).toHaveBeenCalledTimes(1);
    nextResponse.resolve({ available: true });
    await flush();
  });

  it.each(['processGeneration', 'configGeneration'] as const)(
    'isolates a new %s on the same connection', async field => {
      const h = harness();
      const nextResponse = deferred<{ available: boolean }>();
      h.request.mockReturnValueOnce(h.response.promise).mockReturnValue(nextResponse.promise);
      h.preparer.start(h.preparation);
      await flush();
      const next = { ...h.preparation, [field]: h.preparation[field] + 1 };
      h.preparer.start(next);
      h.response.resolve({ available: false });
      await flush();
      h.preparer.start(next);
      await flush();
      expect(h.request).toHaveBeenCalledTimes(2);
      nextResponse.resolve({ available: true });
      await flush();
    },
  );

  it('drops stale work before dispatch and ignores stale completion', async () => {
    const h = harness();
    let current = true;
    const preparation = { ...h.preparation, isCurrent: () => current };
    h.preparer.start(preparation);
    current = false;
    await flush();
    expect(h.request).not.toHaveBeenCalled();
    current = true;
    h.preparer.start(preparation);
    await flush();
    current = false;
    h.response.resolve({ available: true });
    await flush();
    expect(h.log).not.toHaveBeenCalled();
  });

  it('contains startup failure, omits native error content, and allows a later attempt', async () => {
    const h = harness();
    h.preparer.start(h.preparation);
    await flush();
    h.response.reject(new Error('private native details'));
    await flush();
    expect(h.log).toHaveBeenCalledExactlyOnceWith('[ComputerHostPreparation]', {
      elapsedMs: expect.any(Number), available: false,
    });
    h.request.mockResolvedValue({ available: true });
    h.preparer.start(h.preparation);
    await flush();
    expect(h.request).toHaveBeenCalledTimes(2);
  });
});
