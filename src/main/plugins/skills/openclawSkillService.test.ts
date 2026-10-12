import { afterEach, expect, test, vi } from 'vitest';

import type { GatewaySkillEntry, GatewaySkillStatus } from '../../engine/types';
import { OpenClawSkillService } from './openclawSkillService';

afterEach(() => vi.useRealTimers());

const statusWith = (disabled: boolean, overrides: Partial<GatewaySkillEntry> = {}) =>
  ({
    skills: [
      {
        skillKey: 'example',
        disabled,
        eligible: !disabled,
        missing: { bins: [], env: [], config: [], os: [] },
        ...overrides,
      },
    ],
  }) as GatewaySkillStatus;

const createConfirmationService = (request: ReturnType<typeof vi.fn>) => {
  const requestGateway = vi.fn();
  const service = new OpenClawSkillService(
    () => ({ requestGateway }),
    () => ({ request }),
  );
  return { service, requestGateway };
};

test('refreshes skills for the product main assistant rather than the native default agent', async () => {
  const requestGateway = vi.fn().mockResolvedValue({ skills: [] });
  const service = new OpenClawSkillService(() => ({ requestGateway }));
  await service.getStatus();
  expect(requestGateway).toHaveBeenCalledWith('skills.status', { agentId: 'main' });
  await service.getStatus('research');
  expect(requestGateway).toHaveBeenLastCalledWith('skills.status', { agentId: 'research' });
});

test('uses the standard native status parameters when reading installed skills', async () => {
  const report = { skills: [{ name: 'updated' }] };
  const requestGateway = vi.fn().mockResolvedValue(report);
  const service = new OpenClawSkillService(() => ({ requestGateway }));

  await expect(service.getStatus()).resolves.toBe(report);

  expect(requestGateway).toHaveBeenCalledExactlyOnceWith('skills.status', {
    agentId: 'main',
  });
});

test('does not retry an ordinary failed status read or mutate skill configuration', async () => {
  const requestGateway = vi.fn().mockRejectedValue(new Error('Gateway disconnected'));
  const service = new OpenClawSkillService(() => ({ requestGateway }));

  await expect(service.getStatus()).rejects.toThrow('Gateway disconnected');
  expect(requestGateway).toHaveBeenCalledOnce();
});

test.each([true, false])(
  'waits for native config publication before confirming enabled=%s',
  async enabled => {
    vi.useFakeTimers();
    const applied = statusWith(!enabled);
    const request = vi
      .fn()
      .mockResolvedValueOnce(statusWith(enabled))
      .mockResolvedValueOnce(statusWith(enabled))
      .mockResolvedValueOnce(applied);
    const { service, requestGateway } = createConfirmationService(request);
    const done = vi.fn();
    const confirmation = service.waitForEnabledStatus('example', enabled).then(done);

    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await confirmation;

    expect(done).toHaveBeenCalledExactlyOnceWith(applied);
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'skills.status',
      'skills.status',
      'skills.status',
    ]);
    expect(requestGateway).not.toHaveBeenCalled();
  },
);

test('waits for opt-in enablement without requiring unrelated dependencies to become eligible', async () => {
  vi.useFakeTimers();
  const applied = statusWith(false, {
    eligible: false,
    missing: { bins: ['codex'], env: [], config: ['tools.exec.enabled'], os: [] },
  });
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      statusWith(false, {
        missing: {
          bins: ['codex'],
          env: [],
          config: ['skills.entries.example.enabled', 'tools.exec.enabled'],
          os: [],
        },
      }),
    )
    .mockResolvedValueOnce(applied);
  const { service, requestGateway } = createConfirmationService(request);
  const confirmation = service.waitForEnabledStatus('example', true);

  await vi.advanceTimersByTimeAsync(100);

  await expect(confirmation).resolves.toBe(applied);
  expect(request).toHaveBeenCalledTimes(2);
  expect(requestGateway).not.toHaveBeenCalled();
});

test.each(['unchanged', 'missing', 'unresponsive'])(
  'does not claim success when native state is %s after saving',
  async state => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockImplementation(() =>
        state === 'unresponsive'
          ? new Promise(() => undefined)
          : Promise.resolve(state === 'missing' ? { skills: [] } : statusWith(false)),
      );
    const { service, requestGateway } = createConfirmationService(request);
    const confirmation = expect(service.waitForEnabledStatus('example', false)).rejects.toThrow(
      /已保存|was saved/,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await confirmation;
    const reads = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(request).toHaveBeenCalledTimes(reads);
    expect(request.mock.calls.every(call => call[0] === 'skills.status')).toBe(true);
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThan(45);
    expect(requestGateway).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('confirms a saved setting when a brief Gateway disconnect recovers', async () => {
  vi.useFakeTimers();
  const disconnected = new Error('Gateway not connected');
  const applied = statusWith(true);
  const request = vi.fn().mockRejectedValueOnce(disconnected).mockResolvedValueOnce(applied);
  const { service, requestGateway } = createConfirmationService(request);
  const confirmation = service.waitForEnabledStatus('example', false);

  await vi.advanceTimersByTimeAsync(1_000);

  await expect(confirmation).resolves.toBe(applied);
  expect(request).toHaveBeenCalledTimes(2);
  expect(requestGateway).not.toHaveBeenCalled();
});

test.each([{ code: 'CLIENT_TIMEOUT' }, { gatewayCode: 'UNAVAILABLE' }])(
  'retries a transient status failure %j without replaying the write',
  async failure => {
    vi.useFakeTimers();
    const applied = statusWith(true);
    const request = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Temporary status failure'), failure))
      .mockResolvedValueOnce(applied);
    const { service, requestGateway } = createConfirmationService(request);
    const confirmation = service.waitForEnabledStatus('example', false);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(confirmation).resolves.toBe(applied);
    expect(request.mock.calls.map(call => call[0])).toEqual(['skills.status', 'skills.status']);
    expect(requestGateway).not.toHaveBeenCalled();
  },
);

test('allows config publication to finish after the previous five-second window', async () => {
  vi.useFakeTimers();
  const publishedAt = Date.now() + 7_000;
  const applied = statusWith(true);
  const request = vi.fn(async () => (Date.now() >= publishedAt ? applied : statusWith(false)));
  const { service, requestGateway } = createConfirmationService(request);
  const done = vi.fn();
  const confirmation = service.waitForEnabledStatus('example', false).then(done);

  await vi.advanceTimersByTimeAsync(6_000);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  await confirmation;

  expect(done).toHaveBeenCalledExactlyOnceWith(applied);
  expect(requestGateway).not.toHaveBeenCalled();
});

test('cancels a hung status read and confirms through a later read', async () => {
  vi.useFakeTimers();
  let finishHung!: (status: GatewaySkillStatus) => void;
  const applied = statusWith(true);
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<GatewaySkillStatus>(resolve => {
          finishHung = resolve;
        }),
    )
    .mockResolvedValueOnce(applied);
  const { service, requestGateway } = createConfirmationService(request);
  const done = vi.fn();
  const confirmation = service.waitForEnabledStatus('example', false).then(done);

  await vi.advanceTimersByTimeAsync(6_000);
  await confirmation;

  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][2]).toMatchObject({ timeoutMs: 5_000 });
  expect(request.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  expect(request.mock.calls[0][2].signal.aborted).toBe(true);
  expect(done).toHaveBeenCalledExactlyOnceWith(applied);
  finishHung(statusWith(false));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(done).toHaveBeenCalledOnce();
  expect(requestGateway).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['INVALID_REQUEST', 'FORBIDDEN'])(
  'does not retry a permanent native status error %s',
  async gatewayCode => {
    vi.useFakeTimers();
    const denied = Object.assign(new Error('Status denied'), { gatewayCode });
    const request = vi.fn().mockRejectedValue(denied);
    const { service, requestGateway } = createConfirmationService(request);

    await expect(service.waitForEnabledStatus('example', false)).rejects.toMatchObject({
      cause: denied,
      gatewayOffline: false,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    expect(requestGateway).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('waits for an existing connection without entering the Gateway startup path', async () => {
  vi.useFakeTimers();
  const requestGateway = vi.fn();
  const request = vi.fn().mockResolvedValue(statusWith(true));
  let connected = false;
  const service = new OpenClawSkillService(
    () => ({ requestGateway }),
    () => (connected ? { request } : null),
  );
  const confirmation = service.waitForEnabledStatus('example', false);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(request).not.toHaveBeenCalled();
  connected = true;
  await vi.advanceTimersByTimeAsync(1_000);

  await expect(confirmation).resolves.toMatchObject({ skills: [{ disabled: true }] });
  expect(request).toHaveBeenCalledOnce();
  expect(requestGateway).not.toHaveBeenCalled();
});

test('does not settle again when an expired status read eventually succeeds', async () => {
  vi.useFakeTimers();
  let finishLate!: (status: GatewaySkillStatus) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<GatewaySkillStatus>(resolve => {
          finishLate = resolve;
        }),
    )
    .mockResolvedValue(statusWith(false));
  const { service, requestGateway } = createConfirmationService(request);
  const settled = vi.fn();
  const confirmation = service.waitForEnabledStatus('example', false).then(settled, settled);

  await vi.advanceTimersByTimeAsync(30_000);
  await confirmation;
  expect(settled).toHaveBeenCalledOnce();
  expect(settled.mock.calls[0][0]).toBeInstanceOf(Error);
  const reads = request.mock.calls.length;
  finishLate(statusWith(true));
  await vi.advanceTimersByTimeAsync(5_000);

  expect(settled).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(reads);
  expect(requestGateway).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('preserves offline classification after the bounded recovery window expires', async () => {
  vi.useFakeTimers();
  const disconnected = new Error('Gateway not connected');
  const request = vi.fn().mockRejectedValue(disconnected);
  const { service, requestGateway } = createConfirmationService(request);
  const confirmation = expect(service.waitForEnabledStatus('example', false)).rejects.toMatchObject(
    {
      message: expect.stringMatching(/已保存|was saved/),
      gatewayOffline: true,
      cause: disconnected,
    },
  );

  await vi.advanceTimersByTimeAsync(30_000);
  await confirmation;

  expect(request.mock.calls.length).toBeGreaterThan(1);
  expect(requestGateway).not.toHaveBeenCalled();
});

test('does not fall back to a startup-capable resolver when no connected resolver is supplied', async () => {
  vi.useFakeTimers();
  const requestGateway = vi.fn();
  const service = new OpenClawSkillService(() => ({ requestGateway }));
  const confirmation = expect(service.waitForEnabledStatus('example', false)).rejects.toMatchObject(
    {
      gatewayOffline: true,
    },
  );

  await vi.advanceTimersByTimeAsync(30_000);
  await confirmation;
  expect(requestGateway).not.toHaveBeenCalled();
});
