import { describe, expect, it, vi } from 'vitest';

import { t } from '../../core/i18n';
import {
  createManagedSessionModelPolicy,
  type ManagedSessionModelConfig,
  reconcilePreparedManagedSessionModel,
} from './managedSessionModels';
import { enqueueSessionModelOperation } from './sessionModelOperations';
import type { GatewayClientLike } from './types';

const key = 'agent:main:justdo:model-prepare';
const sessionId = 'native-model-prepare';
const identity = (ref: string) => {
  const slash = ref.indexOf('/');
  return { modelProvider: ref.slice(0, slash), model: ref.slice(slash + 1) };
};
const configFor = (routes: string[]): ManagedSessionModelConfig => {
  const providers: NonNullable<ManagedSessionModelConfig['models']>['providers'] = {};
  for (const ref of routes) {
    const { modelProvider, model } = identity(ref);
    (providers[modelProvider] ??= { models: [] }).models!.push({ id: model });
  }
  return { models: { providers }, agents: { defaults: { model: routes[0] } } };
};

function harness(persisted: string, selected: string, routes = ['p/default', 'p/chosen']) {
  let persistedRef = persisted;
  let selectedRef = selected;
  let current = true;
  const persistModelRef = vi.fn((ref: string) => { persistedRef = ref; });
  const config = configFor(routes);
  const request = vi.fn(async (method: string, params?: { model?: string }) => {
    if (method === 'config.get') return { config: structuredClone(config) };
    if (method === 'sessions.describe') {
      return { session: { key, sessionId, ...identity(selectedRef) } };
    }
    if (method === 'sessions.patch') {
      selectedRef = params!.model!;
      const resolved = identity(selectedRef);
      return { key, entry: {
        sessionId, providerOverride: resolved.modelProvider, modelOverride: resolved.model,
      }, resolved };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const reconcile = () => reconcilePreparedManagedSessionModel({
    client: { request } as Pick<GatewayClientLike, 'request'>,
    isCurrentConnection: () => current,
    sessionKey: key,
    gatewaySessionId: sessionId,
    agentId: 'main',
    getPersistedModelRef: () => persistedRef,
    persistModelRef,
  });
  return {
    reconcile, config, request, persistModelRef,
    persisted: () => persistedRef,
    select: (ref: string) => { selectedRef = ref; persistedRef = ref; },
    replaceConnection: () => { current = false; },
  };
}

describe('managed session model policy', () => {
  it('shares agent/default fallback and preserves full slash-containing model identities', () => {
    const config = configFor(['builtin_models/vendor/family/model', 'user/family/model']);
    config.agents!.entries = { reviewer: { model: { primary: 'user/family/model' } }, inherited: {} };
    const policy = createManagedSessionModelPolicy(config);
    expect(policy.availableRoute('vendor/family/model')).toBe('builtin_models/vendor/family/model');
    expect(policy.availableRoute('user/family/model')).toBe('user/family/model');
    expect(policy.availableRoute('other/family/model')).toBeUndefined();
    expect(policy.repairTarget('reviewer', 'removed/model')).toBe('user/family/model');
    expect(policy.repairTarget('inherited', undefined)).toBe('builtin_models/vendor/family/model');
    expect(policy.repairTarget('main', 'user/family/model')).toBe('user/family/model');
    expect(policy.repairTarget('unknown', undefined)).toBeUndefined();
  });

  it('prefers an exact configured route over a builtin alias and has no public defaults', () => {
    const policy = createManagedSessionModelPolicy(configFor([
      'builtin_models/vendor/model', 'vendor/model',
    ]));
    expect(policy.availableRoute('vendor/model')).toBe('vendor/model');
    expect(createManagedSessionModelPolicy().hasTargets).toBe(false);
    expect(createManagedSessionModelPolicy().repairTarget('main', 'vendor/model')).toBeUndefined();
  });
});

describe('prepared managed session model reconciliation', () => {
  it('keeps a valid native selection over an old persisted picker value without patching', async () => {
    const h = harness('p/default', 'p/chosen');
    await h.reconcile();
    expect(h.persisted()).toBe('p/chosen');
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['config.get', 'sessions.describe']);
  });

  it.each([
    { persisted: 'removed/old', routes: ['p/default'], expected: 'p/default' },
    { persisted: 'renamed/chosen', routes: ['renamed/default', 'renamed/chosen'], expected: 'renamed/chosen' },
    { persisted: 'vendor/family/model', routes: ['builtin_models/vendor/family/model'], expected: 'builtin_models/vendor/family/model' },
  ])('repairs a removed native route to $expected with exact incarnation binding', async ({ persisted, routes, expected }) => {
    const h = harness(persisted, 'removed/old', routes);
    await h.reconcile();
    expect(h.request).toHaveBeenCalledWith('sessions.patch', {
      key, expectedSessionId: sessionId, model: expected,
    });
    expect(h.persisted()).toBe(expected);
    expect(h.request).not.toHaveBeenCalledWith('sessions.list', expect.anything());
  });

  it('keeps a configured builtin alias without rewriting its native identity', async () => {
    const h = harness('old/model', 'vendor/family/model', ['builtin_models/vendor/family/model']);
    await h.reconcile();
    expect(h.persisted()).toBe('vendor/family/model');
    expect(h.request).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
  });

  it.each([
    {
      target: 'builtin_models/vendor/family/model',
      provider: 'vendor', model: 'family/model', selected: 'vendor/family/model',
    },
    {
      target: 'user/family/model',
      provider: 'user', model: 'family/model', selected: 'user/family/model',
    },
  ])('accepts native patch identity $selected for configured route $target', async ({ target, provider, model, selected }) => {
    const h = harness(target, 'removed/old', [target]);
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, params) => method === 'sessions.patch'
      ? {
          key,
          entry: { sessionId, providerOverride: provider, modelOverride: model },
          resolved: { provider, model },
        }
      : original(method, params));
    await h.reconcile();
    expect(h.request).toHaveBeenCalledWith('sessions.patch', {
      key, expectedSessionId: sessionId, model: target,
    });
    expect(h.persisted()).toBe(selected);
  });

  it('re-reads after a queued user model switch instead of restoring the older choice', async () => {
    const h = harness('removed/old', 'removed/old');
    let release!: () => void;
    const userChoice = enqueueSessionModelOperation(key, async () => {
      await new Promise<void>(resolve => { release = resolve; });
      h.select('p/chosen');
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const preparation = h.reconcile();
    await Promise.resolve();
    expect(h.request).not.toHaveBeenCalled();
    release();
    await userChoice;
    await preparation;
    expect(h.persisted()).toBe('p/chosen');
    expect(h.request).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
  });

  it('reads the catalog after an earlier queued operation restores a route and selects it', async () => {
    const h = harness('removed/old', 'removed/old', ['p/default']);
    let release!: () => void;
    const userChoice = enqueueSessionModelOperation(key, async () => {
      await new Promise<void>(resolve => { release = resolve; });
      Object.assign(h.config, configFor(['p/default', 'p/restored']));
      h.select('p/restored');
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const preparation = h.reconcile();
    await Promise.resolve();
    expect(h.request).not.toHaveBeenCalled();
    release();
    await userChoice;
    await preparation;
    expect(h.persisted()).toBe('p/restored');
    expect(h.request).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
  });

  it.each(['config.get', 'sessions.describe', 'sessions.patch'])(
    'rejects replacement connections while awaiting %s without persisting late results', async phase => {
      const h = harness('removed/old', 'removed/old');
      const original = h.request.getMockImplementation()!;
      h.request.mockImplementation(async (method, params) => {
        const result = await original(method, params);
        if (method === phase) h.replaceConnection();
        return result;
      });
      await expect(h.reconcile()).rejects.toThrow(t('sessionModelPreparationChanged'));
      expect(h.persistModelRef).not.toHaveBeenCalled();
      if (phase !== 'sessions.patch') {
        expect(h.request).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
      }
    },
  );

  it('rejects a replaced session before mutation', async () => {
    const h = harness('removed/old', 'removed/old');
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, params) => method === 'sessions.describe'
      ? { session: { key, sessionId: 'replacement', ...identity('removed/old') } }
      : original(method, params));
    await expect(h.reconcile()).rejects.toThrow(t('sessionModelIdentityChanged'));
    expect(h.request).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
    expect(h.persistModelRef).not.toHaveBeenCalled();
  });

  it.each([
    { key: 'wrong-key' },
    { entry: { sessionId: 'replacement', providerOverride: 'p', modelOverride: 'default' } },
    { entry: { sessionId, providerOverride: 'p', modelOverride: 'different' } },
    { resolved: identity('p/different') },
  ])('rejects unverified patch receipts instead of persisting their model: %j', async replacement => {
    const h = harness('removed/old', 'removed/old');
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, params) => ({
      ...await original(method, params), ...(method === 'sessions.patch' ? replacement : {}),
    }));
    await expect(h.reconcile()).rejects.toThrow(t('sessionModelPreparationUnconfirmed'));
    expect(h.persistModelRef).not.toHaveBeenCalled();
  });

  it('rejects unavailable configuration without guessing a replacement', async () => {
    const h = harness('removed/old', 'removed/old');
    h.request.mockResolvedValueOnce({ config: undefined } as never);
    await expect(h.reconcile()).rejects.toThrow(t('sessionModelConfigurationUnavailable'));
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('does not guess a model when both the saved route and configured defaults are gone', async () => {
    const h = harness('removed/old', 'removed/old', []);
    await expect(h.reconcile()).rejects.toThrow(t('selectedModelUnavailable'));
    expect(h.request).not.toHaveBeenCalledWith('sessions.patch', expect.anything());
    expect(h.persistModelRef).not.toHaveBeenCalled();
  });

  it('does not retry an uncertain model mutation', async () => {
    const h = harness('removed/old', 'removed/old');
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.patch') throw new Error('gateway closed (1006): lost response');
      return original(method, params);
    });
    await expect(h.reconcile()).rejects.toThrow('lost response');
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([
      'config.get', 'sessions.describe', 'sessions.patch',
    ]);
    expect(h.persistModelRef).not.toHaveBeenCalled();
  });
});
