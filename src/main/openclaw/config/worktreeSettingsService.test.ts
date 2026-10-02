import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { WorktreeSettingsService } from './worktreeSettingsService';

afterEach(() => vi.unstubAllEnvs());

const snapshot = (config: unknown = {}) => ({
  valid: true, hash: 'viewed', configRevisionHash: 'resolved', appliedConfigHash: 'resolved', config,
});
function fixture(config: unknown = {}) {
  const request = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => snapshot(config));
  return { request, service: new WorktreeSettingsService(request as never, () => path.resolve('test-state')) };
}

test('reads native defaults and projects only worktree settings', async () => {
  const { service, request } = fixture({ models: { secret: 'private-credential' } });
  expect(await service.getSettings()).toEqual({ success: true, value: {
    root: null, effectiveRoot: path.resolve('test-state', 'worktrees'), acceleration: true,
    revision: 'viewed', applied: true,
  } });
  expect(request).toHaveBeenCalledTimes(1);
});

test('keeps native normalized directory under an overridden OpenClaw home', async () => {
  const home = path.resolve('isolated-home');
  vi.stubEnv('OPENCLAW_HOME', home);
  const root = path.join(home, '工作目录');
  const { service } = fixture({ worktreeRoot: root, worktreeAcceleration: false });
  expect(await service.getSettings()).toMatchObject({ value: {
    root, effectiveRoot: root, acceleration: false,
  } });
  expect(await service.saveSettings({ root, acceleration: false, revision: 'viewed' }))
    .toMatchObject({ success: true, value: { root, effectiveRoot: root } });
});

test.each([
  { worktreeRoot: 'relative/path' }, { worktreeRoot: null }, { worktreeRoot: '' },
  { worktreeAcceleration: 'false' }, null, [],
])('rejects malformed native configuration %j', async config => {
  const { service } = fixture(config);
  expect(await service.getSettings()).toEqual({ success: false, code: 'configuration' });
});

test.each([{ valid: false }, { hash: '' }])('rejects diagnostic snapshots %j', async override => {
  const { service, request } = fixture();
  request.mockResolvedValueOnce({ ...snapshot(), ...override });
  expect(await service.getSettings()).toEqual({ success: false, code: 'configuration' });
});

test('does not claim application while native revisions differ', async () => {
  const { service, request } = fixture();
  request.mockResolvedValueOnce({ ...snapshot(), appliedConfigHash: 'old' });
  expect(await service.getSettings()).toMatchObject({ value: { applied: false } });
});

test('patches only the two fields with the displayed revision and reads back', async () => {
  const root = path.resolve('工作目录 with spaces');
  const { service, request } = fixture({ worktreeRoot: root, worktreeAcceleration: false });
  expect(await service.saveSettings({ root, acceleration: false, revision: 'viewed' }))
    .toMatchObject({ success: true, value: { root, acceleration: false } });
  expect(request).toHaveBeenNthCalledWith(1, 'config.patch', {
    baseHash: 'viewed', raw: JSON.stringify({ worktreeRoot: root, worktreeAcceleration: false }),
  });
  expect(request).toHaveBeenNthCalledWith(2, 'config.get', {});
});

test('restores the native default by removing only the root override', async () => {
  const { service, request } = fixture();
  await service.saveSettings({ root: '  ', acceleration: true, revision: 'viewed' });
  expect(request).toHaveBeenCalledWith('config.patch', {
    baseHash: 'viewed', raw: JSON.stringify({ worktreeRoot: null, worktreeAcceleration: true }),
  });
});

test.each([
  null, [], {}, { root: '../project' }, { root: '/valid', acceleration: 'true' },
  { root: null, acceleration: true, revision: '' },
  { root: null, acceleration: true, revision: 'viewed', models: {} },
  { root: '/bad\0path', acceleration: true, revision: 'viewed' },
  { root: '~', acceleration: true, revision: 'viewed' },
  { root: '~/worktrees', acceleration: true, revision: 'viewed' },
  { root: '~\\worktrees', acceleration: true, revision: 'viewed' },
])('rejects invalid edits before any Gateway mutation: %j', async input => {
  const { service, request } = fixture();
  expect(await service.saveSettings(input)).toEqual({ success: false, code: 'invalid' });
  expect(request).not.toHaveBeenCalled();
});

test.each([
  ['config changed; baseHash mismatch', 'conflict'], ['missing scope operator.admin', 'forbidden'],
  ['Gateway disconnected', 'unavailable'], ['timeout with private credentials', 'unavailable'],
])('reports %s without retrying or exposing raw diagnostics', async (message, code) => {
  const { service, request } = fixture();
  request.mockRejectedValueOnce(new Error(message));
  expect(await service.saveSettings({ root: null, acceleration: true, revision: 'viewed' }))
    .toEqual({ success: false, code });
  expect(request).toHaveBeenCalledTimes(1);
});

test('rejects overlapping saves while an uncertain write is still pending', async () => {
  const { service, request } = fixture();
  let settle!: (value: unknown) => void;
  request.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
  const first = service.saveSettings({ root: null, acceleration: true, revision: 'viewed' });
  expect(await service.saveSettings({ root: null, acceleration: false, revision: 'viewed' }))
    .toEqual({ success: false, code: 'busy' });
  settle({ ok: true });
  expect(await first).toMatchObject({ success: true });
});

test('does not report success when the readback contains a different saved policy', async () => {
  const { service, request } = fixture({ worktreeRoot: path.resolve('other') });
  expect(await service.saveSettings({ root: null, acceleration: true, revision: 'viewed' }))
    .toEqual({ success: false, code: 'conflict' });
  expect(request).toHaveBeenCalledTimes(2);
});

test('keeps an unconfirmed apply state after a successful native write', async () => {
  const { service, request } = fixture();
  request.mockResolvedValueOnce({ ok: true });
  request.mockResolvedValueOnce({ ...snapshot(), appliedConfigHash: 'old' });
  expect(await service.saveSettings({ root: null, acceleration: true, revision: 'viewed' }))
    .toMatchObject({ success: true, value: { applied: false } });
});
