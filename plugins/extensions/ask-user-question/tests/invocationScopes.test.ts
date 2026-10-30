import { expect, test } from 'vitest';

import { createAppExecutionSourceBindings } from '@app-plugin/sdk/execution-source';

import { AskUserInvocationScopes } from '../invocation';

const context = {
  toolName: 'ask_user_question',
  sessionKey: 'agent:main:subagent:worker',
  sessionId: 'native-child',
  runId: 'run-one',
  toolCallId: 'tool-one',
};

test('requires the exact live Native hook and V2 guard, without trusting model arguments', () => {
  let entry = {
    sessionId: 'native-child',
    lifecycleRevision: 'revision-one',
    pluginOwnerId: 'swarm-workflow',
  };
  const scopes = new AskUserInvocationScopes(() => entry);
  scopes.activate();
  const factory = { ...context, assertInvocationCurrent() {} };
  expect(() => scopes.claim(factory, context.toolCallId)).toThrow('current native');
  scopes.prepare(context);
  const call = scopes.claim(factory, context.toolCallId);
  expect(call.source).toMatchObject({
    runId: 'run-one',
    nativeSessionId: 'native-child',
    lifecycleRevision: 'revision-one',
    ownerPluginId: 'swarm-workflow',
  });
  expect(() => scopes.claim(factory, context.toolCallId)).toThrow();
  entry = { ...entry, sessionId: 'replacement' };
  expect(call.assertCurrent).toThrow();
});

test('exact run binding overrides borrowed source metadata and cannot follow another incarnation', () => {
  const scopes = new AskUserInvocationScopes(() => ({
    sessionId: 'native-child',
    lifecycleRevision: 'r',
  }));
  scopes.activate();
  scopes.prepare(context);
  const toolBindings = createAppExecutionSourceBindings({
    sessionKey: context.sessionKey,
    nativeSessionId: context.sessionId,
    lifecycleRevision: 'r',
    ownerPluginId: 'agent-team',
  });
  const call = scopes.claim(
    { ...context, toolBindings, assertInvocationCurrent() {} },
    context.toolCallId,
  );
  expect(call.source.ownerPluginId).toBe('agent-team');
  scopes.clear();
  expect(call.assertCurrent).toThrow();
  scopes.activate();
  scopes.prepare({ ...context, runId: 'run-two', toolCallId: 'tool-two' });
  const wrongBinding = createAppExecutionSourceBindings({
    sessionKey: context.sessionKey,
    nativeSessionId: 'different-native',
    ownerPluginId: 'agent-team',
  });
  expect(() =>
    scopes.claim(
      { ...context, toolBindings: wrongBinding, assertInvocationCurrent() {} },
      'tool-two',
    ),
  ).toThrow('current native');
  scopes.prepare({ ...context, runId: 'ordinary-run', toolCallId: 'ordinary-call' });
  const ordinary = scopes.claim({ ...context, assertInvocationCurrent() {} }, 'ordinary-call');
  expect(ordinary.source.ownerPluginId).toBeUndefined();
});

test('a sibling after-hook cannot retire another run, while own abort does', () => {
  const scopes = new AskUserInvocationScopes(() => ({
    sessionId: 'native-child',
  }));
  scopes.activate();
  const abort = new AbortController();
  scopes.prepare({ ...context, abortSignal: abort.signal });
  const call = scopes.claim({ ...context, assertInvocationCurrent() {} }, context.toolCallId);
  scopes.finish({ ...context, runId: 'sibling-run' });
  expect(call.assertCurrent).not.toThrow();
  abort.abort();
  expect(call.assertCurrent).toThrow();
});
