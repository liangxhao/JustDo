import { describe, expect, it, vi } from 'vitest';

import type { GatewayClientLike } from '../../../engine/gateway/types';
import type { OpenClawEngineStatus } from '../../runtime/openclawEngineManager';
import {
  maintainStartupAuthProfiles,
  type StartupAuthProfileMaintenanceDependencies,
} from './startupAuthProfileMaintenance';

const managedAuth = (provider = 'retired', source = 'saved') => ({
  providers: [{
    provider,
    profiles: [{ profileId: `${provider}:default`, type: 'api_key', source }],
  }],
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
};

function harness() {
  let phase: OpenClawEngineStatus['phase'] = 'running';
  let generation = 1;
  let discovery: unknown = managedAuth();
  let currentAuth: unknown = managedAuth();
  let config: unknown = { config: { models: { providers: {} } } };
  let authReads = 0;
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === 'config.get') return config;
    if (method === 'models.authStatus') return authReads++ === 0 ? discovery : currentAuth;
    if (method === 'models.authLogout') return { removedProfiles: ['retired:default'] };
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const client: GatewayClientLike = {
    start: vi.fn(),
    stop: vi.fn(),
    request: <T>(method: string, params?: unknown) => request(method, params) as Promise<T>,
  };
  let currentClient: GatewayClientLike | null = client;
  const runExclusive = vi.fn(async (operation: () => Promise<unknown>) => operation());
  const deps: StartupAuthProfileMaintenanceDependencies = {
    getGatewayClient: () => currentClient,
    manager: {
      getStatus: () => ({ phase, version: 'fixture', canRetry: false }),
      getGatewayProcessGeneration: () => generation,
    },
    runExclusive: <T>(operation: () => Promise<T>) => runExclusive(operation) as Promise<T>,
  };
  return {
    deps, client, request, runExclusive,
    setPhase: (value: typeof phase) => { phase = value; },
    advanceGeneration: () => { generation += 1; },
    setClient: (value: GatewayClientLike | null) => { currentClient = value; },
    setDiscovery: (value: unknown) => { discovery = value; },
    setAuth: (value: unknown) => { currentAuth = value; },
    setConfig: (value: unknown) => { config = value; },
  };
}

describe('maintainStartupAuthProfiles', () => {
  it.each(['saved', 'inherited'])('precisely removes an unconfigured managed %s profile', async source => {
    const test = harness();
    test.setDiscovery(managedAuth('retired', source));
    test.setAuth(managedAuth('retired', source));

    await maintainStartupAuthProfiles(test.deps);

    expect(test.request.mock.calls.map(([method]) => method)).toEqual([
      'models.authStatus', 'config.get', 'config.get', 'models.authStatus', 'models.authLogout',
    ]);
    expect(test.request).toHaveBeenLastCalledWith('models.authLogout', {
      provider: 'retired', agentId: 'main', profileIds: ['retired:default'],
    });
    expect(test.runExclusive).toHaveBeenCalledOnce();
    expect(test.client.start).not.toHaveBeenCalled();
    expect(test.client.stop).not.toHaveBeenCalled();
  });

  it.each(['ready', 'starting', 'error'] as const)('does not start a Gateway in %s phase', async phase => {
    const test = harness();
    test.setPhase(phase);
    await maintainStartupAuthProfiles(test.deps);
    expect(test.request).not.toHaveBeenCalled();
    expect(test.runExclusive).not.toHaveBeenCalled();
    expect(test.client.start).not.toHaveBeenCalled();
  });

  it('does not connect when no existing client is available', async () => {
    const test = harness();
    test.setClient(null);
    await maintainStartupAuthProfiles(test.deps);
    expect(test.request).not.toHaveBeenCalled();
    expect(test.runExclusive).not.toHaveBeenCalled();
  });

  it('leaves the config queue free while initial authentication discovery is pending', async () => {
    const test = harness();
    const release = deferred();
    const original = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, params) => {
      if (method === 'models.authStatus') await release.promise;
      return original(method, params);
    });
    const maintenance = maintainStartupAuthProfiles(test.deps);
    await vi.waitFor(() => expect(test.request).toHaveBeenCalledTimes(2));
    expect(test.runExclusive).not.toHaveBeenCalled();

    const admission = vi.fn(async () => 'verified');
    await expect(test.deps.runExclusive(admission)).resolves.toBe('verified');
    expect(admission).toHaveBeenCalledOnce();

    release.resolve();
    await maintenance;
  });

  it('protects a provider restored while its cleanup is waiting for the config queue', async () => {
    const test = harness();
    const release = deferred();
    test.runExclusive.mockImplementation(async operation => {
      await release.promise;
      return operation();
    });
    const maintenance = maintainStartupAuthProfiles(test.deps);
    await vi.waitFor(() => expect(test.runExclusive).toHaveBeenCalledOnce());
    test.setConfig({ config: { models: { providers: { Retired: {} } } } });
    release.resolve();

    await maintenance;
    expect(test.request.mock.calls.some(([method]) => method === 'models.authLogout')).toBe(false);
  });

  it('does not enter the config queue for an already configured provider', async () => {
    const test = harness();
    test.setConfig({ config: { models: { providers: { retired: {} } } } });
    await maintainStartupAuthProfiles(test.deps);
    expect(test.request).toHaveBeenCalledTimes(2);
    expect(test.runExclusive).not.toHaveBeenCalled();
  });

  it.each([
    { profiles: [{ profileId: 'retired:personal', type: 'oauth', source: 'saved' }] },
    { profiles: [{ profileId: 'retired:default', type: 'oauth', source: 'saved' }] },
    { profiles: [{ profileId: 'retired:default', type: 'api_key', source: 'environment' }] },
    { profiles: [...managedAuth().providers[0].profiles, { profileId: 'retired:personal', type: 'oauth', source: 'saved' }] },
  ])('protects a changed or newly added manual profile: %j', async ({ profiles }) => {
    const test = harness();
    test.setAuth({ providers: [{ provider: 'retired', profiles }] });
    await maintainStartupAuthProfiles(test.deps);
    expect(test.request.mock.calls.some(([method]) => method === 'models.authLogout')).toBe(false);
  });

  it('excludes manual and ambiguous duplicate provider entries during discovery', async () => {
    const test = harness();
    test.setDiscovery({ providers: [
      ...managedAuth().providers,
      { provider: 'retired', profiles: [{ profileId: 'retired:personal', type: 'oauth', source: 'saved' }] },
    ] });
    await maintainStartupAuthProfiles(test.deps);
    expect(test.request).toHaveBeenCalledTimes(2);
    expect(test.runExclusive).not.toHaveBeenCalled();
  });

  it.each(['generation', 'client', 'stop'] as const)('abandons discovery after a %s change', async change => {
    const test = harness();
    const release = deferred();
    test.request.mockImplementation(async () => {
      await release.promise;
      return managedAuth();
    });
    const maintenance = maintainStartupAuthProfiles(test.deps);
    if (change === 'generation') test.advanceGeneration();
    else if (change === 'client') test.setClient({ ...test.client });
    else test.setPhase('ready');
    release.resolve();
    await maintenance;
    expect(test.request).toHaveBeenCalledTimes(2);
    expect(test.runExclusive).not.toHaveBeenCalled();
  });

  it('does not read or mutate a replacement after cleanup waited in the queue', async () => {
    const test = harness();
    const release = deferred();
    test.runExclusive.mockImplementation(async operation => {
      await release.promise;
      return operation();
    });
    const maintenance = maintainStartupAuthProfiles(test.deps);
    await vi.waitFor(() => expect(test.runExclusive).toHaveBeenCalledOnce());
    test.advanceGeneration();
    release.resolve();
    await maintenance;
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('does not log out after a generation change during candidate revalidation', async () => {
    const test = harness();
    const release = deferred();
    const original = test.request.getMockImplementation()!;
    let configReads = 0;
    test.request.mockImplementation(async (method, params) => {
      if (method === 'config.get' && ++configReads === 2) await release.promise;
      return original(method, params);
    });
    const maintenance = maintainStartupAuthProfiles(test.deps);
    await vi.waitFor(() => expect(test.request).toHaveBeenCalledTimes(4));
    test.advanceGeneration();
    release.resolve();
    await maintenance;
    expect(test.request.mock.calls.some(([method]) => method === 'models.authLogout')).toBe(false);
  });

  it.each([{}, { config: { models: null } }, { config: { models: { providers: [] } } }])(
    'does not infer provider absence from malformed configuration: %j', async config => {
      const test = harness();
      test.setConfig(config);
      await maintainStartupAuthProfiles(test.deps);
      expect(test.request.mock.calls.some(([method]) => method === 'models.authLogout')).toBe(false);
    },
  );

  it.each(['discovery', 'config.get', 'models.authLogout'])('propagates an unexpected %s failure', async failure => {
    const test = harness();
    const original = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, params) => {
      if (failure === 'discovery' || method === failure) throw new Error('fixture failure');
      return original(method, params);
    });
    await expect(maintainStartupAuthProfiles(test.deps)).rejects.toThrow('fixture failure');
  });

  it('reports an unavailable authentication snapshot without authorizing cleanup', async () => {
    const test = harness();
    test.setAuth({ unavailable: true, ...managedAuth() });
    await expect(maintainStartupAuthProfiles(test.deps)).rejects.toThrow('authentication status is unavailable');
    expect(test.request.mock.calls.some(([method]) => method === 'models.authLogout')).toBe(false);
  });
});
