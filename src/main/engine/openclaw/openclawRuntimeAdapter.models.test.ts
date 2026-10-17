import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd(), getVersion: () => 'test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));
vi.mock('../../core/filesystem/projectGit', () => ({ ensureProjectGitRepository: vi.fn() }));

import { t } from '../../core/i18n';
import type { GatewayClientLike } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

function fixture(override?: string) {
  const session = {
    id: 'session-1', agentId: 'main', cwd: process.cwd(), permissionMode: 'full', modelRef: 'p/old',
  };
  const updateSession = vi.fn();
  let configGeneration = 1;
  const adapter = new OpenClawRuntimeAdapter({
    getSession: () => session, updateSession,
  } as never, {
    getGatewayConfigReloadGeneration: () => configGeneration,
  } as never);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.create') return {
      key: 'agent:main:justdo:session-1', sessionId: 'native-1',
      entry: {
        sessionId: 'native-1', permissionMode: 'full', sessionRoot: process.cwd(), modelOverride: override,
      },
    };
    if (method === 'config.get') return {
      config: { models: { providers: { p: { models: [{ id: 'chosen' }] } } } },
    };
    if (method === 'sessions.describe') return {
      session: { key: 'agent:main:justdo:session-1', sessionId: 'native-1', modelProvider: 'p', model: 'chosen' },
    };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike;
    gatewayClientGeneration: number;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  return {
    adapter, internals, session, request, updateSession,
    reloadConfig: () => { configGeneration += 1; },
  };
}

test.each([undefined, '', '   '])('prepares a fresh managed session with no extra model RPCs (%j)', async override => {
  const h = fixture(override);
  await expect(h.adapter.prepareSession('session-1')).resolves.toEqual({
    sessionKey: 'agent:main:justdo:session-1', gatewaySessionId: 'native-1',
  });
  expect(h.request.mock.calls.map(([method]) => method)).toEqual(['sessions.create']);
  expect(h.updateSession).not.toHaveBeenCalled();
});

test('rejects a model policy from before a same-process configuration reload', async () => {
  const h = fixture('removed');
  const original = h.request.getMockImplementation()!;
  h.request.mockImplementation(async method => {
    const result = await original(method);
    if (method === 'config.get') h.reloadConfig();
    return result;
  });
  await expect(h.adapter.prepareSession('session-1')).rejects.toThrow(t('sessionModelPreparationChanged'));
  expect(h.request.mock.calls.map(([method]) => method)).toEqual(['sessions.create', 'config.get']);
  expect(h.updateSession).not.toHaveBeenCalled();
});

test('checks an existing managed override and preserves the current native selection', async () => {
  const h = fixture('removed');
  await h.adapter.prepareSession('session-1');
  expect(h.request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.create', 'config.get', 'sessions.describe',
  ]);
  expect(h.updateSession).toHaveBeenCalledWith('session-1', { modelRef: 'p/chosen' });
});

test('keeps explicitly bound worktree sessions outside ordinary managed-model repair', async () => {
  const h = fixture('removed');
  const nativeKey = 'agent:main:subagent:worktree-child';
  Object.assign(h.session, { nativeSessionKey: nativeKey });
  h.request.mockResolvedValueOnce({
    session: {
      sessionId: 'native-1', worktree: { id: 'tree-1' }, sessionRoot: process.cwd(),
      permissionMode: 'full', modelOverride: 'removed',
    },
  } as never);
  await expect(h.adapter.prepareSession('session-1')).resolves.toEqual({
    sessionKey: nativeKey, gatewaySessionId: 'native-1',
  });
  expect(h.request.mock.calls).toEqual([['sessions.describe', { key: nativeKey }]]);
  expect(h.updateSession).not.toHaveBeenCalled();
});

test('does not query configuration when the create receipt came from a replaced client generation', async () => {
  const h = fixture('removed');
  const original = h.request.getMockImplementation()!;
  h.request.mockImplementation(async method => {
    const result = await original(method);
    if (method === 'sessions.create') h.internals.gatewayClientGeneration += 1;
    return result;
  });
  await expect(h.adapter.prepareSession('session-1')).rejects.toThrow(t('sessionModelPreparationChanged'));
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(h.updateSession).not.toHaveBeenCalled();
});
