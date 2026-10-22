import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveManagedCredentialReloadTimeoutMs } from './credentialTimeouts';
import {
  ManagedCredentialReloadOutcome,
  reloadManagedCredentials,
} from './managedCredentialReload';

afterEach(() => {
  vi.restoreAllMocks();
});

const createHarness = () => {
  let current = true;
  const request = vi.fn<(timeoutMs: number) => Promise<{ ok?: boolean }>>()
    .mockResolvedValue({ ok: true });
  const wait = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
  return {
    request,
    wait,
    errorLog,
    infoLog,
    setCurrent: (value: boolean) => { current = value; },
    reload: () => reloadManagedCredentials({
      reason: 'credential-rotation',
      isCurrent: () => current,
      getGatewayPhase: () => 'running',
      request,
      wait,
    }),
  };
};

describe('managed credential snapshot reload', () => {
  it('retries native UNAVAILABLE refusals even when their generic retryable flag is false', async () => {
    const harness = createHarness();
    const unavailable = Object.assign(new Error('secrets.reload failed'), {
      gatewayCode: 'UNAVAILABLE', retryable: false,
    });
    harness.request.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable);

    await expect(harness.reload()).resolves.toEqual({ outcome: ManagedCredentialReloadOutcome.Applied });

    expect(harness.request.mock.calls).toEqual(Array.from({ length: 3 }, () => [resolveManagedCredentialReloadTimeoutMs()]));
    expect(harness.wait.mock.calls).toEqual([[500], [1_500]]);
    expect(harness.infoLog).toHaveBeenCalledWith(
      '[OpenClaw] Managed model provider credentials refreshed after retry:',
      expect.objectContaining({ reason: 'credential-rotation', attempts: 3 }),
    );
  });

  it('retries a sent CLIENT_TIMEOUT only through the snapshot reload callback', async () => {
    const harness = createHarness();
    const nativeRequest = vi.fn<(method: string, params: unknown, options: { timeoutMs: number }) => Promise<{ ok?: boolean }>>()
      .mockRejectedValueOnce(Object.assign(new Error('request timed out'), {
        code: 'CLIENT_TIMEOUT', requestSent: true, retryable: false,
      }))
      .mockResolvedValue({ ok: true });
    harness.request.mockImplementation(timeoutMs => nativeRequest('secrets.reload', undefined, { timeoutMs }));

    await expect(harness.reload()).resolves.toEqual({ outcome: ManagedCredentialReloadOutcome.Applied });

    expect(nativeRequest.mock.calls).toEqual([
      ['secrets.reload', undefined, { timeoutMs: resolveManagedCredentialReloadTimeoutMs() }],
      ['secrets.reload', undefined, { timeoutMs: resolveManagedCredentialReloadTimeoutMs() }],
    ]);
    expect(harness.wait).toHaveBeenCalledOnce();
  });

  it.each(['FORBIDDEN', 'INVALID_REQUEST'])('does not retry %s even when its generic retryable flag is true', async gatewayCode => {
    const harness = createHarness();
    harness.request.mockRejectedValueOnce(Object.assign(new Error('native refusal'), {
      gatewayCode, retryable: true, requestSent: false,
    }));

    await expect(harness.reload()).resolves.toEqual({
      outcome: ManagedCredentialReloadOutcome.Failed, retryable: false,
    });

    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.wait).not.toHaveBeenCalled();
  });

  it.each([{ ok: false }, {}, null])('rejects an unconfirmed acknowledgement %j', async acknowledgement => {
    const harness = createHarness();
    harness.request.mockResolvedValueOnce(acknowledgement as { ok?: boolean });

    await expect(harness.reload()).resolves.toEqual({
      outcome: ManagedCredentialReloadOutcome.Failed, retryable: false,
    });

    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.wait).not.toHaveBeenCalled();
    expect(harness.errorLog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: expect.stringContaining('Secret snapshot was not refreshed.') }),
    );
  });

  it('reports failure after three retryable attempts instead of reporting an applied snapshot', async () => {
    const harness = createHarness();
    harness.request.mockRejectedValue(Object.assign(new Error('secrets.reload failed'), {
      gatewayCode: 'UNAVAILABLE',
    }));

    await expect(harness.reload()).resolves.toEqual({
      outcome: ManagedCredentialReloadOutcome.Failed, retryable: true,
    });

    expect(harness.request).toHaveBeenCalledTimes(3);
    expect(harness.wait.mock.calls).toEqual([[500], [1_500]]);
    expect(harness.infoLog).not.toHaveBeenCalled();
    expect(harness.errorLog.mock.calls.map(([, entry]) => entry.willRetry)).toEqual([true, true, false]);
  });

  it('abandons the refresh when its owner changes during retry backoff', async () => {
    const harness = createHarness();
    harness.request.mockRejectedValueOnce(Object.assign(new Error('secrets.reload failed'), {
      gatewayCode: 'UNAVAILABLE',
    }));
    harness.wait.mockImplementationOnce(async () => { harness.setCurrent(false); });

    await expect(harness.reload()).resolves.toEqual({ outcome: ManagedCredentialReloadOutcome.Superseded });

    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.wait).toHaveBeenCalledOnce();
    expect(harness.infoLog).not.toHaveBeenCalled();
  });

  it('does not apply a late acknowledgement after its owner has changed', async () => {
    const harness = createHarness();
    let acknowledge!: (value: { ok: boolean }) => void;
    harness.request.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));

    const reloading = harness.reload();
    harness.setCurrent(false);
    acknowledge({ ok: true });

    await expect(reloading).resolves.toEqual({ outcome: ManagedCredentialReloadOutcome.Superseded });
    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.wait).not.toHaveBeenCalled();
    expect(harness.infoLog).not.toHaveBeenCalled();
    expect(harness.errorLog).not.toHaveBeenCalled();
  });

  it('retains stack traces, attempt numbers and timeout budgets while masking credentials', async () => {
    const harness = createHarness();
    const failure = Object.assign(new Error('exec provider timed out; token=reload-token-fixture\nAuthorization: Bearer reload-jwt-fixture'), {
      gatewayCode: 'UNAVAILABLE', credentials: { apiKey: 'reload-key-fixture' },
    });
    harness.request.mockRejectedValueOnce(failure);

    await expect(harness.reload()).resolves.toEqual({ outcome: ManagedCredentialReloadOutcome.Applied });

    expect(harness.errorLog).toHaveBeenCalledWith(
      '[OpenClaw] Failed to refresh managed model provider credentials (secrets.reload):',
      expect.objectContaining({
        reason: 'credential-rotation', gatewayPhase: 'running', attempt: 1, maxAttempts: 3,
        elapsedMs: expect.any(Number), timeoutMs: resolveManagedCredentialReloadTimeoutMs(), willRetry: true,
        error: expect.stringContaining('exec provider timed out; token=[REDACTED]'),
      }),
    );
    expect(harness.errorLog.mock.calls[0][1].error).toContain('managedCredentialReload.test.ts:');
    expect(JSON.stringify(harness.errorLog.mock.calls)).not.toMatch(/reload-(?:token|jwt|key)-fixture/);
  });
});
