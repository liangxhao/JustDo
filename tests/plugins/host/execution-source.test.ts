import {
  createAppExecutionSourceBindings,
  isAppExecutionSessionQuery,
  readAppExecutionSourceBinding,
} from '@app-plugin/sdk/execution-source';
import { describe, expect, it } from 'vitest';

const identity = {
  sessionKey: 'agent:role:delegate:fixture',
  nativeSessionId: 'native-a',
  lifecycleRevision: 'revision-a',
};

describe('Native execution source bindings', () => {
  it('keeps the producer owner out of model arguments and binds it to the exact incarnation', () => {
    const bindings = createAppExecutionSourceBindings({
      ...identity,
      ownerPluginId: 'fixture-plugin',
    });
    expect(readAppExecutionSourceBinding(bindings, identity)).toEqual({
      ...identity,
      version: 1,
      ownerPluginId: 'fixture-plugin',
    });
    expect(
      readAppExecutionSourceBinding(bindings, { ...identity, nativeSessionId: 'native-b' }),
    ).toBeNull();
    expect(
      readAppExecutionSourceBinding(bindings, { ...identity, lifecycleRevision: 'revision-b' }),
    ).toBeNull();
    expect(
      readAppExecutionSourceBinding(bindings, {
        ...identity,
        sessionKey: 'agent:other:delegate:fixture',
      }),
    ).toBeNull();
    expect(readAppExecutionSourceBinding({ ownerPluginId: 'fixture-plugin' }, identity)).toBeNull();
  });

  it('preserves absent and null lifecycle identities and rejects unvalidated fields or accessors', () => {
    const nullIdentity = { ...identity, lifecycleRevision: null };
    const bindings = createAppExecutionSourceBindings({
      ...nullIdentity,
      ownerPluginId: 'fixture-plugin',
    });
    expect(readAppExecutionSourceBinding(bindings, nullIdentity)?.lifecycleRevision).toBeNull();
    expect(readAppExecutionSourceBinding(bindings, identity)).toBeNull();
    const getter = {
      get executionSource() {
        throw new Error('Must not execute a foreign getter');
      },
    };
    expect(readAppExecutionSourceBinding(getter, identity)).toBeNull();
    expect(
      readAppExecutionSourceBinding(
        {
          executionSource: {
            ...identity,
            version: 1,
            ownerPluginId: 'fixture-plugin',
            permission: 'full',
          },
        },
        identity,
      ),
    ).toBeNull();
    expect(() =>
      createAppExecutionSourceBindings({ ...identity, ownerPluginId: 'fixture\nplugin' }),
    ).toThrow();
  });

  it('requires the Native session ID and accepts no model-authored additions', () => {
    expect(
      isAppExecutionSessionQuery({ ...identity, runId: 'run-a', ownerPluginId: 'fixture-plugin' }),
    ).toBe(true);
    expect(isAppExecutionSessionQuery({ sessionKey: identity.sessionKey })).toBe(false);
    expect(isAppExecutionSessionQuery({ ...identity, nativeSessionId: 'native\0a' })).toBe(false);
    expect(isAppExecutionSessionQuery({ ...identity, parentPermissionMode: 'full' })).toBe(false);
    expect(
      isAppExecutionSessionQuery({
        ...identity,
        get runId() {
          throw new Error('Untrusted getter');
        },
      }),
    ).toBe(false);
  });
});
