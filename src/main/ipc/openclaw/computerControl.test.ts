import { afterEach, expect, test, vi } from 'vitest';

import { ComputerControlIpc } from '../../../shared/security/computerControl';
import { registerComputerControlHandlers } from './computerControl';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), policy: vi.fn().mockResolvedValue(true) }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../../plugins/extensions/openclawLocalExtensions', () => ({
  hasBundledOpenClawExtension: () => true,
}));
vi.mock('../../openclaw/config/computerControlNativePolicy', () => ({
  evaluateComputerControlNativePolicy: mocks.policy,
}));
afterEach(() => vi.clearAllMocks());

test('serializes the combined write through the application config mutation boundary', async () => {
  const requestGateway = vi
    .fn()
    .mockResolvedValueOnce({
      valid: true,
      hash: 'revision',
      config: { plugins: { entries: { 'cua-computer': { enabled: false } } } },
    })
    .mockResolvedValueOnce({ ok: true });
  const runConfigMutationExclusive = vi.fn(async operation => operation());
  registerComputerControlHandlers({
    requestGateway,
    runConfigMutationExclusive,
    getRuntimeRoot: () => 'bundled-runtime',
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === ComputerControlIpc.SetEnabled,
  )![1];
  expect(await handler({}, true)).toEqual({ success: true, enabled: true });
  expect(runConfigMutationExclusive).toHaveBeenCalledOnce();
  expect(mocks.policy).toHaveBeenCalledWith('bundled-runtime', {
    deny: [],
    alsoAllow: ['computer'],
  });
  expect(requestGateway.mock.calls.map(([method]) => method)).toEqual([
    'config.get',
    'config.patch',
  ]);
});

test('rejects a renderer configuration object without passing it to the gateway', async () => {
  const requestGateway = vi.fn();
  registerComputerControlHandlers({
    requestGateway,
    getRuntimeRoot: () => 'bundled-runtime',
    runConfigMutationExclusive: async operation => operation(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === ComputerControlIpc.SetEnabled,
  )![1];
  expect(await handler({}, { enabled: true, tools: { allow: ['*'] } })).toEqual({
    success: false,
    code: 'invalid',
  });
  expect(requestGateway).not.toHaveBeenCalled();
  expect(mocks.policy).not.toHaveBeenCalled();
});
