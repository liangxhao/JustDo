import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd(), getVersion: () => 'test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));
vi.mock('../../core/filesystem/projectGit', () => ({ ensureProjectGitRepository: vi.fn() }));

import { t } from '../../core/i18n';
import { enqueueSessionModelOperation } from '../gateway/sessionModelOperations';
import type { GatewayClientLike } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

function fixture(override?: string) {
  const session = {
    id: 'session-1', agentId: 'main', cwd: process.cwd(), permissionMode: 'full', modelRef: 'p/old',
  };
  const updateSession = vi.fn();
  const applyHistorySessionDefaults = vi.fn(() => false);
  let created = false;
  let configGeneration = 1;
  const adapter = new OpenClawRuntimeAdapter({
    getSession: () => session, updateSession, applyHistorySessionDefaults,
  } as never, {
    getGatewayConfigReloadGeneration: () => configGeneration,
  } as never);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.create') {
      created = true;
      return {
        key: 'agent:main:justdo:session-1', sessionId: 'native-1',
        entry: {
          sessionId: 'native-1', permissionMode: 'full', sessionRoot: process.cwd(), modelOverride: override,
        },
      };
    }
    if (method === 'config.get') return {
      config: { models: { providers: { p: { models: [{ id: 'chosen' }] } } } },
    };
    if (method === 'sessions.describe') return !created && !('historyBinding' in session) ? { session: null } : {
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
    adapter, internals, session, request, updateSession, applyHistorySessionDefaults,
    reloadConfig: () => { configGeneration += 1; },
  };
}

const key = 'agent:main:justdo:session-1';
const selectedReceipt = (model = 'chosen', sessionId = 'native-1') => ({
  key, sessionId,
  entry: { sessionId, permissionMode: 'full', sessionRoot: process.cwd(),
    providerOverride: 'p', modelOverride: model },
  resolved: { modelProvider: 'p', model },
});

test('pins the first message selection in sessions.create before global defaults finish reloading', async () => {
  const h = fixture();
  h.request.mockResolvedValueOnce({ session: null } as never);
  h.request.mockResolvedValueOnce(selectedReceipt() as never);
  await expect(h.adapter.prepareSession('session-1', { modelRef: 'p/chosen' })).resolves.toEqual({
    sessionKey: key, gatewaySessionId: 'native-1',
  });
  expect(h.request).toHaveBeenCalledWith('sessions.create', {
    key, cwd: process.cwd(), permissionMode: 'full', model: 'p/chosen',
  });
  expect(h.updateSession).toHaveBeenCalledExactlyOnceWith('session-1', { modelRef: 'p/chosen' });
});

test.each([
  { resolved: { modelProvider: 'p', model: 'old' } },
  { resolved: undefined },
  { key: 'replacement-key' },
  { entry: { ...selectedReceipt().entry, sessionId: 'replacement' } },
  { entry: { ...selectedReceipt().entry, modelOverride: 'old' } },
])('does not accept a different or unconfirmed initial native model: %j', async invalid => {
  const h = fixture();
  h.request.mockResolvedValueOnce({ session: null } as never);
  h.request.mockResolvedValueOnce({ ...selectedReceipt(), ...invalid } as never);
  await expect(h.adapter.prepareSession('session-1', { modelRef: 'p/chosen' }))
    .rejects.toThrow(t('sessionModelPreparationUnconfirmed'));
  expect(h.updateSession).not.toHaveBeenCalled();
});

test('accepts a confirmed initial selection while model defaults reload on the same connection', async () => {
  const h = fixture();
  h.request.mockResolvedValueOnce({ session: null } as never);
  h.request.mockImplementationOnce(async () => {
    h.reloadConfig();
    return selectedReceipt() as never;
  });
  await expect(h.adapter.prepareSession('session-1', { modelRef: 'p/chosen' }))
    .resolves.toEqual({ sessionKey: key, gatewaySessionId: 'native-1' });
  expect(h.updateSession).toHaveBeenCalledWith('session-1', { modelRef: 'p/chosen' });
});

test('does not publish an initial selection from a replaced connection generation', async () => {
  const h = fixture();
  h.request.mockResolvedValueOnce({ session: null } as never);
  h.request.mockImplementationOnce(async () => {
    h.internals.gatewayClientGeneration += 1;
    return selectedReceipt() as never;
  });
  await expect(h.adapter.prepareSession('session-1', { modelRef: 'p/chosen' }))
    .rejects.toThrow(t('sessionModelPreparationChanged'));
  expect(h.updateSession).not.toHaveBeenCalled();
});

test('pins an adopted App model on its exact existing incarnation without recreating it', async () => {
  const h = fixture();
  h.request.mockResolvedValueOnce({ session: selectedReceipt().entry } as never);
  h.request.mockResolvedValueOnce(selectedReceipt() as never);
  await expect(h.adapter.prepareSession('session-1', {
    expectedSessionId: 'native-1', modelRef: 'p/chosen',
  })).resolves.toEqual({ sessionKey: key, gatewaySessionId: 'native-1' });
  expect(h.request.mock.calls).toEqual([
    ['sessions.describe', { key, agentId: 'main' }],
    ['sessions.patch', { key, expectedSessionId: 'native-1', model: 'p/chosen' }],
  ]);
});

test('accepts an adopted App selection while model defaults reload without replacing its owner', async () => {
  const h = fixture();
  h.request.mockResolvedValueOnce({ session: selectedReceipt().entry } as never);
  h.request.mockImplementationOnce(async () => {
    h.reloadConfig();
    return selectedReceipt() as never;
  });
  await expect(h.adapter.prepareSession('session-1', {
    expectedSessionId: 'native-1', modelRef: 'p/chosen',
  })).resolves.toEqual({ sessionKey: key, gatewaySessionId: 'native-1' });
  expect(h.updateSession).toHaveBeenCalledWith('session-1', { modelRef: 'p/chosen' });
  expect(h.request).toHaveBeenCalledTimes(2);
});

test('does not retry an uncertain adopted App model mutation', async () => {
  const h = fixture();
  h.request.mockResolvedValueOnce({ session: selectedReceipt().entry } as never);
  h.request.mockRejectedValueOnce(new Error('gateway closed (1012): selection response lost'));
  await expect(h.adapter.prepareSession('session-1', {
    expectedSessionId: 'native-1', modelRef: 'p/chosen',
  })).rejects.toThrow('selection response lost');
  expect(h.updateSession).not.toHaveBeenCalled();
  expect(h.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.patch']);
});

test('pins a worktree first-message model on the described native identity', async () => {
  const h = fixture();
  Object.assign(h.session, { nativeSessionKey: key });
  h.request.mockResolvedValueOnce({ session: {
    ...selectedReceipt().entry, worktree: { id: 'tree-1' },
  } } as never);
  h.request.mockResolvedValueOnce(selectedReceipt() as never);
  await expect(h.adapter.prepareSession('session-1', { modelRef: 'p/chosen' }))
    .resolves.toEqual({ sessionKey: key, gatewaySessionId: 'native-1' });
  expect(h.request.mock.calls).toEqual([
    ['sessions.describe', { key }],
    ['sessions.patch', { key, expectedSessionId: 'native-1', model: 'p/chosen' }],
  ]);
});

test('orders first-message pinning after an earlier model operation for the same native session', async () => {
  const h = fixture();
  let release!: () => void;
  const previous = enqueueSessionModelOperation(key, () => new Promise<void>(resolve => {
    release = resolve;
  }));
  h.request.mockResolvedValueOnce({ session: null } as never);
  h.request.mockResolvedValueOnce(selectedReceipt() as never);
  const prepared = h.adapter.prepareSession('session-1', { modelRef: 'p/chosen' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(h.request).not.toHaveBeenCalled();
  release();
  await previous;
  await prepared;
  expect(h.request).toHaveBeenCalledTimes(2);
});

test.each([undefined, '', '   '])('prepares a fresh managed session with no extra model RPCs (%j)', async override => {
  const h = fixture(override);
  await expect(h.adapter.prepareSession('session-1')).resolves.toEqual({
    sessionKey: 'agent:main:justdo:session-1', gatewaySessionId: 'native-1',
  });
  expect(h.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.create']);
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
  expect(h.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.create', 'config.get']);
  expect(h.updateSession).not.toHaveBeenCalled();
});

test('cancels managed-model reconciliation before its next native operation', async () => {
  const h = fixture('removed');
  const cancellation = new AbortController();
  const original = h.request.getMockImplementation()!;
  let releaseConfig!: (value: unknown) => void;
  h.request.mockImplementation(async method => method === 'config.get'
    ? new Promise(resolve => { releaseConfig = resolve; }) as never
    : original(method));
  const preparation = h.adapter.prepareSession('session-1', { signal: cancellation.signal });
  await vi.waitFor(() => expect(releaseConfig).toBeTypeOf('function'));
  cancellation.abort();
  releaseConfig({ config: { models: { providers: { p: { models: [{ id: 'chosen' }] } } } } });
  await expect(preparation).rejects.toThrow(t('sessionModelPreparationChanged'));
  expect(h.request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.describe', 'sessions.create', 'config.get',
  ]);
  expect(h.updateSession).not.toHaveBeenCalled();
});

test('checks an existing managed override and preserves the current native selection', async () => {
  const h = fixture('removed');
  await h.adapter.prepareSession('session-1');
  expect(h.request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.describe', 'sessions.create', 'config.get', 'sessions.describe',
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

test('prepares imported history with its exact native identity and current workspace permissions', async () => {
  const h = fixture();
  const key = 'agent:main:justdo:session-1';
  Object.assign(h.session, { nativeSessionKey: key, historyBinding: {
    sessionKey: key, nativeSessionId: 'native-1', availability: 'native',
  } });
  await expect(h.adapter.prepareSession('session-1')).resolves.toEqual({ sessionKey: key, gatewaySessionId: 'native-1' });
  expect(h.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.describe', 'sessions.create']);
});

test('an imported binding cannot silently open a new empty session after identity or connection changes', async () => {
  const h = fixture();
  const key = 'agent:main:justdo:session-1';
  Object.assign(h.session, { nativeSessionKey: key, historyBinding: {
    sessionKey: key, nativeSessionId: 'original-missing-identity', availability: 'native',
  } });
  await expect(h.adapter.prepareSession('session-1')).rejects.toThrow(/identity changed/);
  expect(h.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.describe']);
});

test('preparing unopened history adopts current new-conversation permissions before native admission', async () => {
  const h = fixture();
  const key = 'agent:main:justdo:session-1';
  Object.assign(h.session, { nativeSessionKey: key, historyBinding: { sessionKey: key, nativeSessionId: 'native-1', availability: 'native' } });
  h.applyHistorySessionDefaults.mockImplementation(() => {
    h.session.permissionMode = 'ask'; h.session.modelRef = ''; return true;
  });
  const original = h.request.getMockImplementation()!;
  h.request.mockImplementation(async method => {
    if (method === 'sessions.create') return { key, sessionId: 'native-1', entry: { sessionId: 'native-1', sessionRoot: process.cwd(), permissionMode: 'guarded' } };
    return original(method);
  });
  await h.adapter.prepareSession('session-1', { permissionMode: 'full' });
  expect(h.applyHistorySessionDefaults).toHaveBeenCalledWith('session-1');
  expect(h.request).toHaveBeenCalledWith('sessions.create', { key, cwd: process.cwd(), permissionMode: 'guarded' });
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
  expect(h.request).toHaveBeenCalledTimes(2);
  expect(h.updateSession).not.toHaveBeenCalled();
});
