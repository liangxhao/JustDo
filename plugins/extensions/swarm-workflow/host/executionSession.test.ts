import type { AppExecutionSessionQuery, AppMainHost, AppSession } from '@app-plugin/sdk/main';
import { expect, test, vi } from 'vitest';

import { FLOW_RPC } from '../contracts/flow';
import { resolveWorkflowExecutionSession } from './executionSession';

function fixture(imported = false) {
  const query: AppExecutionSessionQuery = {
    sessionKey: 'agent:worker:subagent:flow-node',
    nativeSessionId: 'child-native',
    lifecycleRevision: 'child-revision',
    runId: 'child-run',
    ownerPluginId: 'swarm-workflow',
  };
  const parentKey = 'agent:organizer:justdo:source';
  let owner: AppSession | null = {
    id: imported ? 'imported-source' : 'source',
    agentId: 'organizer',
    title: 'Source',
    cwd: 'C:/project',
    executionMode: 'local',
    permissionMode: 'ask',
    ...(imported
      ? { historyBinding: { sessionKey: parentKey, nativeSessionId: 'parent-native' } }
      : {}),
  };
  const source = {
    sessionKey: query.sessionKey,
    nativeSessionId: query.nativeSessionId,
    runId: query.runId!,
    parentKey,
    parentNativeSessionId: 'parent-native',
    label: 'Worker · Read inputs',
  };
  let responseCurrent = true;
  const ownedKeys = vi.fn(() => [parentKey]);
  const originalRuntime = {
    getSessionKeysForSession: ownedKeys,
    captureGatewayResponseContext: () => ({ isCurrent: () => responseCurrent }),
  };
  let runtime: typeof originalRuntime | null = originalRuntime;
  const request = vi.fn(async () => ({ executionSession: source }));
  const assertActive = vi.fn();
  const byKey = vi.fn((key: string) => (imported && key === parentKey ? owner : null));
  const host = {
    getRuntime: () => runtime,
    getSessions: () => ({
      getSession: (id: string) => (owner?.id === id ? owner : null),
      getSessionByNativeKey: byKey,
    }),
    requestConnectedGateway: request,
    assertActive,
  } as unknown as AppMainHost;
  return {
    host,
    query,
    source,
    request,
    ownedKeys,
    byKey,
    assertActive,
    originalRuntime,
    owner: () => owner,
    replaceOwner: (next: AppSession | null) => {
      owner = next;
    },
    replaceRuntime: (next: typeof originalRuntime | null) => {
      runtime = next;
    },
    revokeResponse: () => {
      responseCurrent = false;
    },
  };
}

test('locates an ordinary source chat through its exact derived key without requiring a persisted binding', async () => {
  const f = fixture();
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'source',
    label: f.source.label,
  });
  expect(f.request).toHaveBeenCalledExactlyOnceWith(FLOW_RPC.executionSession, f.query);
  expect(f.ownedKeys).toHaveBeenCalledWith('source');
});

test('keeps imported product identities rather than using the ID embedded in their historical key', async () => {
  const f = fixture(true);
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toEqual({
    ownerSessionId: 'imported-source',
    label: f.source.label,
  });
  expect(f.ownedKeys).toHaveBeenCalledWith('imported-source');
});

test('does not trust a parsed product ID when another assistant namespace owns the source', async () => {
  const f = fixture();
  f.source.parentKey = 'agent:other:justdo:source';
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('requires exact runtime key ownership even when the session store returns an imported match', async () => {
  const f = fixture(true);
  f.ownedKeys.mockReturnValue(['agent:other:justdo:source']);
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('rejects a binding whose key was replaced while the Native SID stayed the same', async () => {
  const f = fixture(true);
  f.owner()!.historyBinding!.sessionKey = 'agent:other:justdo:source';
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('rejects a parent incarnation different from the product history binding', async () => {
  const f = fixture(true);
  f.source.parentNativeSessionId = 'replacement-parent';
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('does not accept a Native execution reply for a different child incarnation', async () => {
  const f = fixture(true);
  f.source.nativeSessionId = 'replacement-child';
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('refuses an incomplete parent identity rather than projecting it to the current chat', async () => {
  const f = fixture();
  f.source.parentNativeSessionId = '';
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('does not query Native without a current runtime response context', async () => {
  const f = fixture();
  f.replaceRuntime(null);
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
  expect(f.request).not.toHaveBeenCalled();
});

test('discards an awaited source response after the authenticated connection context retires', async () => {
  const f = fixture(true);
  f.request.mockImplementation(async () => {
    f.revokeResponse();
    return { executionSession: f.source };
  });
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('discards an awaited source response when the runtime instance has changed', async () => {
  const f = fixture(true);
  f.request.mockImplementation(async () => {
    f.replaceRuntime({ ...f.originalRuntime });
    return { executionSession: f.source };
  });
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('rejects a source deleted during Native lookup', async () => {
  const f = fixture(true);
  f.request.mockImplementation(async () => {
    f.replaceOwner(null);
    return { executionSession: f.source };
  });
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('rechecks exact key ownership after Native lookup', async () => {
  const f = fixture(true);
  f.request.mockImplementation(async () => {
    f.ownedKeys.mockReturnValue(['agent:organizer:justdo:replacement']);
    return { executionSession: f.source };
  });
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('does not publish when key lookup itself retires the runtime', async () => {
  const f = fixture(true);
  f.ownedKeys.mockImplementation(() => {
    f.replaceRuntime(null);
    return [f.source.parentKey];
  });
  expect(await resolveWorkflowExecutionSession(f.host, f.query)).toBeNull();
});

test('propagates a revoked plugin epoch instead of reviving the old source', async () => {
  const f = fixture(true);
  f.assertActive.mockImplementation(() => {
    throw new Error('retired');
  });
  await expect(resolveWorkflowExecutionSession(f.host, f.query)).rejects.toThrow('retired');
});
