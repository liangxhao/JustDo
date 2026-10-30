import { expect, it, vi } from 'vitest';

import type {
  AppMainHost,
  AppMainRegistration,
  AppSession,
} from '../../../../plugins/sdk/app-plugin-sdk/main';
import type { VerifiedAppArtifact } from './artifact';
import { type AppHostResources, AppPluginRegistry } from './registry';

const query = {
  sessionKey: 'agent:role:worker:fixture',
  nativeSessionId: 'native-a',
  runId: 'run-a',
};
const artifact = (id: string, nativePluginId = id): VerifiedAppArtifact => ({
  root: `C:/fixture/${id}`,
  artifact: {
    manifest: {
      manifestVersion: 1,
      apiVersion: 1,
      id,
      nativePluginId,
      version: '1.0.0',
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      capabilities: [],
      commands: [],
      slots: [],
    },
    hash: (id === 'first' ? 'a' : 'b').repeat(64),
    files: {},
  },
});
const binding = (id: string) => ({
  pluginId: id,
  registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  processId: 123,
  gatewayMethods: [],
});
function fixture() {
  const hosts = new Map<string, AppMainHost>();
  const states = new Map<
    string,
    { enabled: boolean; confirmed: boolean; binding: ReturnType<typeof binding> }
  >();
  const owners = new Map<string, AppSession>([
    [
      'product-root',
      {
        id: 'product-root',
        title: 'Source',
        agentId: 'role',
        cwd: 'C:/project',
        executionMode: 'local',
        permissionMode: 'ask',
      },
    ],
  ]);
  const registry = new AppPluginRegistry(
    id => states.get(id) ?? { enabled: false, confirmed: false },
  );
  const resources = {
    getSessions: () => ({ getSession: (id: string) => owners.get(id) ?? null }),
  } as AppHostResources;
  return {
    registry,
    states,
    owners,
    hosts,
    async add(
      id: string,
      resolveExecutionSession: NonNullable<AppMainRegistration['resolveExecutionSession']>,
      nativePluginId = id,
      metadataCommand = false,
    ) {
      states.set(nativePluginId, {
        enabled: true,
        confirmed: true,
        binding: binding(nativePluginId),
      });
      const candidate = artifact(id, nativePluginId);
      if (metadataCommand) candidate.artifact.manifest.commands = ['source.metadata'];
      await registry.prepare(candidate, resources, async () => ({
        register: host => {
          hosts.set(id, host);
          return {
            commands: metadataCommand
              ? [{ id: 'source.metadata', invoke: () => host.executionSessionsChanged() }]
              : [],
            resolveExecutionSession,
          };
        },
      }));
      registry.activate();
    },
  };
}

it('stamps the actual plugin epoch on a proven existing product owner or standalone label', async () => {
  const f = fixture();
  try {
    await f.add('first', () => ({
      ownerSessionId: 'product-root',
      label: 'Member',
      pluginId: 'foreign',
      epoch: 'foreign',
    }));
    expect(await f.registry.resolveExecutionSession(query)).toEqual({
      pluginId: 'first',
      nativePluginId: 'first',
      epoch: f.registry.snapshot()[0].epoch,
      ownerSessionId: 'product-root',
      label: 'Member',
    });
    f.owners.clear();
    expect(await f.registry.resolveExecutionSession(query)).toBeNull();
  } finally {
    f.registry.dispose();
  }
  const standalone = fixture();
  try {
    await standalone.add('first', () => ({ label: 'Independent group member' }));
    expect(await standalone.registry.resolveExecutionSession(query)).toMatchObject({
      pluginId: 'first',
      label: 'Independent group member',
    });
  } finally {
    standalone.registry.dispose();
  }
});

it('keeps Native owner hints separate from an independently named App companion', async () => {
  const f = fixture();
  try {
    await f.add('first', () => ({ label: 'Member' }), 'native-first');
    expect(
      await f.registry.resolveExecutionSession({ ...query, ownerPluginId: 'native-first' }),
    ).toMatchObject({
      pluginId: 'first',
      nativePluginId: 'native-first',
      label: 'Member',
    });
    expect(
      await f.registry.resolveExecutionSession({ ...query, ownerPluginId: 'first' }),
    ).toBeNull();
  } finally {
    f.registry.dispose();
  }
});

it('rejects conflicting claims and limits a Native owner hint to its actual registration', async () => {
  const f = fixture();
  try {
    await f.add('first', () => ({ ownerSessionId: 'product-root' }));
    await f.add('second', () => ({ ownerSessionId: 'product-root' }));
    expect(await f.registry.resolveExecutionSession(query)).toBeNull();
    expect(
      await f.registry.resolveExecutionSession({ ...query, ownerPluginId: 'first' }),
    ).toMatchObject({ pluginId: 'first' });
    f.states.get('first')!.enabled = false;
    f.registry.refresh();
    expect(
      await f.registry.resolveExecutionSession({ ...query, ownerPluginId: 'first' }),
    ).toBeNull();
  } finally {
    f.registry.dispose();
  }
});

it.each(['epoch', 'native-registration', 'product-deletion'] as const)(
  'withdraws an awaited association after %s changes',
  async change => {
    const f = fixture();
    let complete!: (value: { ownerSessionId: string }) => void;
    try {
      await f.add(
        'first',
        () =>
          new Promise(resolve => {
            complete = resolve;
          }),
      );
      const resolving = f.registry.resolveExecutionSession(query);
      if (change === 'epoch') f.registry.retireEpoch('first');
      else if (change === 'native-registration')
        f.states.get('first')!.binding = { ...binding('first'), processId: 456 };
      else f.owners.clear();
      complete({ ownerSessionId: 'product-root' });
      expect(await resolving).toBeNull();
    } finally {
      f.registry.dispose();
    }
  },
);

it('accepts a refreshed same-owner binding and rechecks an earlier owner after another provider awaits', async () => {
  const f = fixture();
  let finish!: () => void;
  try {
    await f.add('first', async () => {
      f.states.get('first')!.binding = { ...binding('first') };
      return { ownerSessionId: 'product-root' };
    });
    expect(await f.registry.resolveExecutionSession(query)).toMatchObject({ pluginId: 'first' });
    await f.add(
      'second',
      () =>
        new Promise(resolve => {
          finish = () => resolve(null);
        }),
    );
    const resolving = f.registry.resolveExecutionSession(query);
    await Promise.resolve();
    f.states.get('first')!.enabled = false;
    finish();
    expect(await resolving).toBeNull();
  } finally {
    f.registry.dispose();
  }
});

it('does not invoke providers for malformed identities', async () => {
  const f = fixture();
  const resolve = vi.fn(() => ({ label: 'Member' }));
  try {
    await f.add('first', resolve);
    expect(await f.registry.resolveExecutionSession({ ...query, nativeSessionId: '' })).toBeNull();
    expect(
      await f.registry.resolveExecutionSession({ ...query, runId: 'foreign\nrun' }),
    ).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    f.registry.dispose();
  }
});

it('keeps the original producer selection when the caller changes its query during a provider await', async () => {
  const f = fixture();
  let finish!: (value: null) => void;
  const second = vi.fn(() => ({ ownerSessionId: 'product-root' }));
  try {
    await f.add(
      'first',
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    await f.add('second', second);
    const mutableQuery = { ...query, ownerPluginId: 'first' };
    const resolving = f.registry.resolveExecutionSession(mutableQuery);
    mutableQuery.ownerPluginId = 'second';
    finish(null);
    expect(await resolving).toBeNull();
    expect(second).not.toHaveBeenCalled();
  } finally {
    f.registry.dispose();
  }
});

it('preserves a pending execution association without claiming that its UI effects are ready', async () => {
  const f = fixture();
  try {
    await f.add('first', () => ({ ownerSessionId: 'product-root', pending: true }));
    expect(await f.registry.resolveExecutionSession(query)).toMatchObject({
      pluginId: 'first',
      ownerSessionId: 'product-root',
      pending: true,
    });
  } finally {
    f.registry.dispose();
  }
});

it('only accepts source metadata invalidation from a live plugin invocation', async () => {
  const f = fixture();
  const changed = vi.fn();
  const lifecycleChanged = vi.fn();
  let notifyInsideLookup = false;
  try {
    await f.add(
      'first',
      () => {
        if (notifyInsideLookup) f.hosts.get('first')!.executionSessionsChanged();
        return { ownerSessionId: 'product-root' };
      },
      'first',
      true,
    );
    const release = f.registry.onExecutionSessionsChanged(changed);
    const releaseLifecycle = f.registry.subscribe(lifecycleChanged);
    expect(() => f.hosts.get('first')!.executionSessionsChanged()).toThrow();
    expect(changed).not.toHaveBeenCalled();
    await f.registry.invoke({
      id: 'first',
      epoch: f.registry.snapshot()[0].epoch,
      command: 'source.metadata',
      args: [],
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(lifecycleChanged).not.toHaveBeenCalled();
    changed.mockClear();
    notifyInsideLookup = true;
    expect(await f.registry.resolveExecutionSession(query)).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    release();
    releaseLifecycle();
    f.registry.retireEpoch('first');
    expect(() => f.hosts.get('first')!.executionSessionsChanged()).toThrow();
  } finally {
    f.registry.dispose();
  }
});
