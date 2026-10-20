import { expect, it, vi } from 'vitest';

import { t } from '../../core/i18n';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { OpenClawExtensionImportService } from './openclawExtensionImportService';

function fixture() {
  const manager = {
    getStatus: vi.fn(() => ({ phase: 'running' })),
    getGatewayProcessId: vi.fn<() => number | null>(() => 123),
    getGatewayProcessGeneration: vi.fn(() => 1),
    withStoppedGatewayForMutation: vi.fn(),
    restartGateway: vi.fn(),
  };
  let enabled = false;
  const requestGateway = vi.fn(async (method: string, params?: { enabled?: boolean }) => {
    if (method === 'skills.update') enabled = params?.enabled === true;
    return method === 'config.get'
      ? {
          valid: true,
          configRevisionHash: 'revision',
          appliedConfigHash: 'revision',
          config: { skills: { entries: { 'agent-team': { enabled } } } },
        }
      : { ok: true, restartRequired: false };
  });
  const runCommand = vi.fn();
  const ordinaryRequest = vi.fn(async () => { throw new Error('Hot toggles must not ensure/restart the runtime'); });
  const restartGatewayAfterMutation = vi.fn();
  const client = { request: requestGateway };
  const deps = {
    getOpenClawEngineManager: () => manager as unknown as OpenClawEngineManager,
    requiresHotToggle: () => true,
    getNativeSkillIds: (id: string) => (id === 'agent-team' ? [id] : []),
    requestGateway: ordinaryRequest,
    getConnectedGatewayClient: () => client,
    runCommand,
    restartGatewayAfterMutation,
  };
  return { manager, requestGateway, ordinaryRequest, runCommand, restartGatewayAfterMutation, deps };
}

it.each([
  ['agent-team', true],
  ['agent-team', false],
  ['swarm-workflow', true],
  ['swarm-workflow', false],
] as const)(
  'hot-toggles %s to %s without stopping Gateway or using the CLI',
  async (id, enabled) => {
    const f = fixture();
    expect(await new OpenClawExtensionImportService(f.deps).setEnabled(id, enabled)).toEqual({
      success: true,
      warnings: undefined,
    });
    expect(f.requestGateway.mock.calls).toEqual([
      ['plugins.setEnabled', { pluginId: id, enabled }],
      ...(id === 'agent-team'
        ? [
            ['skills.update', { skillKey: id, enabled }],
            ['config.get', {}],
          ]
        : []),
    ]);
    expect(f.manager.withStoppedGatewayForMutation).not.toHaveBeenCalled();
    expect(f.manager.restartGateway).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.ordinaryRequest).not.toHaveBeenCalled();
  },
);

it('does not silently replace hot reload with a restart when Native requests one', async () => {
  const f = fixture();
  f.requestGateway.mockResolvedValueOnce({ ok: true, restartRequired: true });
  expect(await new OpenClawExtensionImportService(f.deps).setEnabled('agent-team', true)).toEqual({
    success: false,
    error: t('extensionHotToggleRestartRequired'),
  });
  expect(f.requestGateway).toHaveBeenCalledOnce();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  expect(f.runCommand).not.toHaveBeenCalled();
});

it('does not use a cold mutation when the hot-reload bridge is unavailable', async () => {
  const f = fixture();
  expect(
    await new OpenClawExtensionImportService({ ...f.deps, getConnectedGatewayClient: undefined }).setEnabled(
      'agent-team',
      true,
    ),
  ).toEqual({ success: false, error: t('extensionHotToggleUnavailable') });
  expect(f.manager.withStoppedGatewayForMutation).not.toHaveBeenCalled();
  expect(f.runCommand).not.toHaveBeenCalled();
});

it.each([false, true, undefined])(
  'does not retry a transport failure with requestSent=%s',
  async requestSent => {
    const f = fixture();
    f.requestGateway.mockRejectedValueOnce(
      Object.assign(new Error('Gateway response lost'), { code: 'CLIENT_CLOSED', requestSent }),
    );
    expect(await new OpenClawExtensionImportService(f.deps).setEnabled('agent-team', true)).toEqual(
      {
        success: false,
        error: requestSent === false ? t('extensionHotToggleUnavailable') : 'Gateway response lost',
        ...(requestSent !== false ? { operationUnconfirmed: true } : {}),
      },
    );
    expect(f.requestGateway).toHaveBeenCalledOnce();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
  },
);

it('keeps native capability consent authoritative during hot enablement', async () => {
  const f = fixture();
  f.requestGateway.mockRejectedValueOnce(
    Object.assign(new Error('Plugin capability policy rejected the mutation'), {
      gatewayCode: 'UNAVAILABLE',
      code: 'CLIENT_CLOSED',
      requestSent: false,
    }),
  );
  expect(await new OpenClawExtensionImportService(f.deps).setEnabled('agent-team', true)).toEqual({
    success: false,
    error: 'Plugin capability policy rejected the mutation',
  });
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
});

it.each(['ready', 'starting', 'error'])('does not start or recover a %s Gateway for a hot toggle', async phase => {
  const f = fixture();
  f.manager.getStatus.mockReturnValue({ phase });
  expect(await new OpenClawExtensionImportService(f.deps).setEnabled('agent-team', true))
    .toEqual({ success: false, error: t('extensionHotToggleUnavailable') });
  expect(f.requestGateway).not.toHaveBeenCalled();
  expect(f.ordinaryRequest).not.toHaveBeenCalled();
  expect(f.manager.withStoppedGatewayForMutation).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
});

it.each(['process-generation', 'connection'])('does not continue the mutation in a replacement %s', async replacement => {
  const f = fixture();
  const otherRequest = vi.fn();
  const request = f.requestGateway.getMockImplementation()!;
  f.requestGateway.mockImplementation(async (method, params) => {
    const result = await request(method, params);
    if (method === 'plugins.setEnabled') {
      if (replacement === 'process-generation') f.manager.getGatewayProcessGeneration.mockReturnValue(2);
      else f.deps.getConnectedGatewayClient = () => ({ request: otherRequest });
    }
    return result;
  });
  expect(await new OpenClawExtensionImportService(f.deps).setEnabled('agent-team', true))
    .toEqual({ success: false, error: t('extensionSkillSyncFailed') });
  expect(f.requestGateway).toHaveBeenCalledOnce();
  expect(otherRequest).not.toHaveBeenCalled();
  expect(f.ordinaryRequest).not.toHaveBeenCalled();
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
});

it('reports skill-update failure without restarting or replaying plugin enablement', async () => {
  const f = fixture();
  f.requestGateway.mockResolvedValueOnce({ ok: true, restartRequired: false });
  f.requestGateway.mockRejectedValueOnce(new Error('Skill update failed'));
  expect(await new OpenClawExtensionImportService(f.deps).setEnabled('agent-team', true)).toEqual({
    success: false,
    error: t('extensionSkillSyncFailed'),
  });
  expect(f.requestGateway).toHaveBeenCalledTimes(2);
  expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  expect(f.runCommand).not.toHaveBeenCalled();
});

it('waits for the native applied revision after a skill write without repeating mutations', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    let reads = 0;
    const request = f.requestGateway.getMockImplementation()!;
    f.requestGateway.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === 'config.get' && ++reads === 1)
        return { ...result, configRevisionHash: 'new', appliedConfigHash: 'old' };
      return result;
    });
    const operation = new OpenClawExtensionImportService(f.deps).setEnabled('agent-team', true);
    await vi.runAllTimersAsync();
    expect(await operation).toMatchObject({ success: true });
    expect(reads).toBe(2);
    expect(
      f.requestGateway.mock.calls.filter(([method]) => method === 'plugins.setEnabled'),
    ).toHaveLength(1);
    expect(
      f.requestGateway.mock.calls.filter(([method]) => method === 'skills.update'),
    ).toHaveLength(1);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});


it('rejects a replaced client while waiting for hot native admission without using recovery', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const f = fixture();
    let client = f.deps.getConnectedGatewayClient();
    const replacement = { request: vi.fn() };
    f.requestGateway.mockRejectedValueOnce(Object.assign(
      new Error('Another plugin or config operation is already running; retry when it completes.'),
      { gatewayCode: 'UNAVAILABLE', retryable: true, retryAfterMs: 1000 },
    ));
    const service = new OpenClawExtensionImportService({
      ...f.deps, getConnectedGatewayClient: () => client,
    });
    const pending = service.setEnabled('swarm-workflow', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requestGateway).toHaveBeenCalledOnce();
    client = replacement;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({
      success: false, error: t('extensionHotToggleUnavailable'),
    });
    expect(f.requestGateway).toHaveBeenCalledOnce();
    expect(replacement.request).not.toHaveBeenCalled();
    expect(f.ordinaryRequest).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.restartGatewayAfterMutation).not.toHaveBeenCalled();
    expect(f.manager.withStoppedGatewayForMutation).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
