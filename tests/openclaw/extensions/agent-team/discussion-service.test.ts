import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSessionEntry, patchSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { afterEach, expect, it, vi } from 'vitest';

import { registerDiscussionService } from '../../../../plugins/extensions/agent-team/discussion/discussion-service';
import { TeamDiscussionGateway } from '../../../../src/shared/cowork/agent-team/teamDiscussion';

const sdk = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../../../plugins/extensions/agent-team/discussion/discussion-execution', () => ({
  executeGroupDiscussion: sdk.execute,
}));
vi.mock('../../../../plugins/extensions/agent-team/discussion/discussion-summary', () => ({
  registerDiscussionSummary: vi.fn(),
}));
vi.mock('../../../../plugins/extensions/agent-team/discussion/discussion-channel', () => ({
  discussionChannel: {},
  bindDiscussionTransport: () => () => {},
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: vi.fn(),
  patchSessionEntry: vi.fn(),
}));
vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({ getGroupThreadDeliverySession: vi.fn() }));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function sourcePolicyFixture(policy: Record<string, unknown> = {}, participates = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-service-source-policy-'));
  roots.push(root);
  const methods = new Map<
    string,
    (input: { params: Record<string, unknown>; respond: ReturnType<typeof vi.fn> }) => unknown
  >();
  let service: { start: (context: { stateDir: string }) => void; stop: () => Promise<void> };
  const source = {
    agentId: 'main',
    sessionKey: 'agent:main:justdo:source',
    sessionId: 'native-source',
    lifecycleRevision: 'source-revision',
  };
  let sourceEntry = {
    ...source,
    sessionRoot: root,
    permissionMode: 'guarded',
    ...policy,
  };
  const entries = new Map(
    ['alice', 'bob'].map(agentId => [
      agentId,
      {
        sessionId: `native-${agentId}`,
        lifecycleRevision: 'revision',
        sessionRoot: root,
        permissionMode: 'guarded',
        ...policy,
      },
    ]),
  );
  vi.mocked(getSessionEntry).mockImplementation(({ agentId }) =>
    agentId === 'main' ? (sourceEntry as never) : (entries.get(agentId!) as never),
  );
  vi.mocked(patchSessionEntry).mockImplementation(async params => {
    const entry = entries.get(params.agentId!)!;
    const patch = await params.update(entry as never, { existingEntry: entry as never });
    params.assertCommitAllowed?.();
    const updated = { ...entry, ...patch };
    entries.set(params.agentId!, updated);
    return updated as never;
  });
  const gateway = vi.fn(async (_method, params) => {
    const agentId = params.key.split(':')[1];
    entries.set(agentId, { ...entries.get(agentId)!, permissionMode: params.permissionMode });
  });
  const config = {
    plugins: { entries: { 'agent-team': { enabled: true } } },
    agents: {
      entries: {
        main: { model: 'internal/source-model', tools: { allow: ['read', 'exec'] } },
        alice: { workspace: '/roles/alice', tools: { allow: ['read'] } },
        bob: {},
      },
    },
  };
  const toolPolicy = vi.fn();
  sdk.execute.mockResolvedValue(undefined);
  registerDiscussionService({
    runtime: {
      config: {
        current: () => config,
      },
      channel: { commands: { isControlCommandMessage: () => false } },
      events: { onAgentEvent: vi.fn() },
      gateway: { request: gateway },
    },
    registerService: (value: typeof service) => {
      service = value;
    },
    registerChannel: vi.fn(),
    registerTrustedToolPolicy: toolPolicy,
    registerGatewayMethod: (
      name: string,
      method: typeof methods extends Map<string, infer M> ? M : never,
    ) => {
      methods.set(name, method);
    },
  } as never);
  service!.start({ stateDir: root });
  const members = ['alice', 'bob'].map(agentId => ({
    agentId,
    sessionId: `native-${agentId}`,
    lifecycleRevision: 'revision',
    ownership: 'room',
  }));
  if (participates) members.push({ ...source, ownership: 'source' });
  const room = {
    id: 'room',
    revision: 1,
    cwd: root,
    permissionMode: 'ask',
    readOnly: true,
    sourceSessionId: 'source',
    summarySource: source,
    members,
  };
  const send = {
    roomId: 'room',
    requestId: 'request',
    expectedRevision: 1,
    message: 'Topic',
    selectedAgentIds: [],
    rounds: 1,
  };
  return {
    methods,
    params: { room, send, discussionId: 'batch', members },
    entries,
    source,
    root,
    gateway,
    config,
    toolPolicy,
    prepare: async () => {
      const respond = vi.fn();
      await methods.get(TeamDiscussionGateway.Prepare)!({
        params: {
          roomId: room.id,
          cwd: root,
          permissionMode: room.permissionMode,
          sourceSessionId: room.sourceSessionId,
          summarySource: source,
          agentIds: ['alice', 'bob'],
          members: members.filter(member => member.ownership !== 'source'),
        },
        respond,
      });
      return respond;
    },
    changeSource: (changes: Record<string, unknown>) => {
      sourceEntry = { ...sourceEntry, ...changes };
    },
  };
}

it.each([{ sandbox: 'required' }])(
  'rejects immutable source isolation before dispatch: %j',
  async policy => {
    const fixture = sourcePolicyFixture();
    // Native sessions.patch preserves SID and lifecycleRevision for policy edits.
    fixture.changeSource(policy);
    const validate = vi.fn();
    await fixture.methods.get(TeamDiscussionGateway.Validate)!({
      params: fixture.params,
      respond: validate,
    });
    expect(validate).toHaveBeenCalledWith(true, {
      valid: false,
      error: 'teamDiscussionSourcePolicyUnsupported',
    });
    const accepted = vi.fn();
    await fixture.methods.get(TeamDiscussionGateway.Start)!({
      params: fixture.params,
      respond: accepted,
    });
    expect(accepted).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: 'teamDiscussionSourcePolicyUnsupported' }),
    );
    expect(sdk.execute).not.toHaveBeenCalled();
  },
);

it('refreshes existing member policy from the exact source without replacing sessions', async () => {
  const fixture = sourcePolicyFixture();
  fixture.changeSource({
    permissionMode: 'full',
    execHost: 'node',
    execNode: 'internal-node',
    inheritedToolAllow: ['read', 'exec'],
    inheritedToolDeny: ['web_search'],
    toolOverrides: { mcpServers: { internal: false }, skills: { research: false } },
  });
  const prepared = await fixture.prepare();
  expect(prepared).toHaveBeenCalledWith(true, {
    members: expect.arrayContaining([
      expect.objectContaining({
        agentId: 'alice',
        sessionId: 'native-alice',
        permissionMode: 'full',
      }),
    ]),
  });
  expect(fixture.gateway).not.toHaveBeenCalled();
  expect(patchSessionEntry).toHaveBeenCalledTimes(2);
  expect(fixture.entries.get('alice')).toMatchObject({
    permissionMode: 'full',
    execHost: 'node',
    execNode: 'internal-node',
    inheritedToolDeny: ['web_search'],
    toolOverrides: { mcpServers: { internal: false }, skills: { research: false } },
  });
  fixture.changeSource({
    execHost: undefined,
    execNode: undefined,
    inheritedToolAllow: undefined,
    inheritedToolDeny: undefined,
    toolOverrides: undefined,
  });
  await fixture.prepare();
  expect(fixture.entries.get('alice')).toMatchObject({
    execHost: undefined,
    execNode: undefined,
    inheritedToolAllow: undefined,
    inheritedToolDeny: undefined,
    toolOverrides: undefined,
  });
  expect(fixture.toolPolicy).not.toHaveBeenCalled();
});

it('creates independent members and copies source selection without linking its operator-owned session', async () => {
  const fixture = sourcePolicyFixture();
  fixture.changeSource({
    providerOverride: 'internal',
    modelOverride: 'selected-model',
    modelOverrideSource: 'user',
    toolOverrides: { webSearch: false },
  });
  const prepared = vi.fn();
  await fixture.methods.get(TeamDiscussionGateway.Prepare)!({
    params: {
      roomId: 'room',
      cwd: fixture.root,
      permissionMode: 'ask',
      sourceSessionId: 'source',
      summarySource: fixture.source,
      agentIds: ['alice', 'bob'],
    },
    respond: prepared,
  });
  expect(prepared).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ members: expect.any(Array) }),
  );
  expect(fixture.gateway).toHaveBeenCalledTimes(2);
  for (const [method, params] of fixture.gateway.mock.calls) {
    expect(method).toBe('sessions.create');
    expect(params).not.toHaveProperty('parentSessionKey');
    expect(params).not.toHaveProperty('fork');
  }
  expect(fixture.entries.get('alice')).toMatchObject({
    sessionId: 'native-alice',
    providerOverride: 'internal',
    modelOverride: 'selected-model',
    modelOverrideSource: 'user',
    toolOverrides: { webSearch: false },
  });
  expect(patchSessionEntry).toHaveBeenCalledTimes(2);
});

it('preserves source tools and model config while retaining each member role workspace', async () => {
  const fixture = sourcePolicyFixture({ toolOverrides: { webSearch: false } });
  await fixture.methods.get(TeamDiscussionGateway.Start)!({
    params: fixture.params,
    respond: vi.fn(),
  });
  const options = sdk.execute.mock.calls[0][0];
  expect(options.cfg.agents.entries.alice).toMatchObject({
    workspace: '/roles/alice',
    model: 'internal/source-model',
    tools: { allow: ['read', 'exec'] },
  });
  expect(fixture.config.agents.entries.alice.tools).toEqual({ allow: ['read'] });
  fixture.changeSource({
    authProfileOverride: 'automatically-selected-profile',
    authProfileOverrideSource: 'auto',
    authProfileOverrideCompactionCount: 0,
    providerOverride: 'internal',
    modelOverride: 'fallback-model',
    modelOverrideSource: 'auto',
    modelOverrideFallbackOriginProvider: 'internal',
    modelOverrideFallbackOriginModel: 'source-model',
  });
  expect(() => options.assertSourceCurrent()).not.toThrow();
  fixture.changeSource({ toolOverrides: { webSearch: true } });
  expect(() => options.assertSourceCurrent()).toThrow('teamDiscussionSessionChanged');
});

it('rechecks the complete inherited selection between validation and admission', async () => {
  const fixture = sourcePolicyFixture();
  const validated = vi.fn();
  await fixture.methods.get(TeamDiscussionGateway.Validate)!({
    params: fixture.params,
    respond: validated,
  });
  expect(validated).toHaveBeenCalledWith(true, { valid: true });
  fixture.changeSource({ modelOverride: 'new-selected-model', modelOverrideSource: 'user' });
  const started = vi.fn();
  await fixture.methods.get(TeamDiscussionGateway.Start)!({
    params: fixture.params,
    respond: started,
  });
  expect(started).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: 'teamDiscussionSessionChanged' }),
  );
  expect(sdk.execute).not.toHaveBeenCalled();
});

it('copies and clears model fallback and auth provenance together with source selection', async () => {
  const fixture = sourcePolicyFixture();
  const fallback = {
    providerOverride: 'internal',
    modelOverride: 'temporary-model',
    modelOverrideSource: 'auto',
    modelOverrideRouteResolution: 'resolved',
    modelOverrideFallbackOriginProvider: 'internal',
    modelOverrideFallbackOriginModel: 'selected-model',
    authProfileOverride: 'source-profile',
    authProfileOverrideSource: 'auto',
    authProfileOverrideCompactionCount: 2,
  };
  fixture.changeSource(fallback);
  await fixture.prepare();
  expect(fixture.entries.get('alice')).toMatchObject(fallback);
  fixture.changeSource({
    providerOverride: undefined,
    modelOverride: undefined,
    modelOverrideSource: undefined,
    modelOverrideRouteResolution: undefined,
    modelOverrideFallbackOriginProvider: undefined,
    modelOverrideFallbackOriginModel: undefined,
    authProfileOverride: undefined,
    authProfileOverrideSource: undefined,
    authProfileOverrideCompactionCount: undefined,
  });
  await fixture.prepare();
  expect(fixture.entries.get('alice')).toMatchObject({
    modelOverrideFallbackOriginProvider: undefined,
    modelOverrideFallbackOriginModel: undefined,
    authProfileOverrideCompactionCount: undefined,
    modelOverride: undefined,
    authProfileOverride: undefined,
  });
});

it('rejects a replaced member during policy refresh without creating another incarnation', async () => {
  const fixture = sourcePolicyFixture();
  fixture.entries.set('alice', { ...fixture.entries.get('alice')!, sessionId: 'replacement' });
  const prepared = await fixture.prepare();
  expect(prepared).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: 'teamDiscussionSessionChanged' }),
  );
  expect(fixture.gateway).not.toHaveBeenCalled();
  expect(patchSessionEntry).not.toHaveBeenCalled();
});

it('rejects source drift while a member policy update waits for its commit', async () => {
  const fixture = sourcePolicyFixture();
  fixture.changeSource({ inheritedToolDeny: ['exec'] });
  vi.mocked(patchSessionEntry).mockImplementationOnce(async params => {
    const current = fixture.entries.get('alice')!;
    const patch = await params.update(current as never, { existingEntry: current as never });
    fixture.changeSource({ inheritedToolDeny: ['write'] });
    params.assertCommitAllowed?.();
    return { ...current, ...patch } as never;
  });
  const prepared = await fixture.prepare();
  expect(prepared).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: 'teamDiscussionSessionChanged' }),
  );
  expect(fixture.entries.get('alice')?.inheritedToolDeny).toBeUndefined();
});

it.each([
  { sessionId: 'replacement' },
  { lifecycleRevision: 'replacement' },
  { sessionRoot: '/replacement' },
  { archivedAt: 1 },
])('rejects a changed non-participating source before native admission: %j', async changes => {
  const fixture = sourcePolicyFixture(changes);
  const validate = vi.fn();
  await fixture.methods.get(TeamDiscussionGateway.Validate)!({
    params: fixture.params,
    respond: validate,
  });
  expect(validate).toHaveBeenCalledWith(true, {
    valid: false,
    error: 'teamDiscussionSessionChanged',
  });
  const accepted = vi.fn();
  await fixture.methods.get(TeamDiscussionGateway.Start)!({
    params: fixture.params,
    respond: accepted,
  });
  expect(accepted).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: 'teamDiscussionSessionChanged' }),
  );
  expect(sdk.execute).not.toHaveBeenCalled();
});

it.each([false, true])(
  'preserves a permitted source whether it participates or only organizes: %s',
  async participates => {
    const fixture = sourcePolicyFixture(
      { inheritedToolAllow: ['*'], toolOverrides: { webSearch: true } },
      participates,
    );
    const validate = vi.fn();
    await fixture.methods.get(TeamDiscussionGateway.Validate)!({
      params: fixture.params,
      respond: validate,
    });
    expect(validate).toHaveBeenCalledWith(true, { valid: true });
    const accepted = vi.fn();
    await fixture.methods.get(TeamDiscussionGateway.Start)!({
      params: fixture.params,
      respond: accepted,
    });
    expect(accepted).toHaveBeenCalledWith(true, expect.objectContaining({ state: 'running' }));
    expect(sdk.execute).toHaveBeenCalledOnce();
  },
);

it('reads an existing receipt after source policy changes without launching it again', async () => {
  const fixture = sourcePolicyFixture();
  await fixture.methods.get(TeamDiscussionGateway.Start)!({
    params: fixture.params,
    respond: vi.fn(),
  });
  fixture.changeSource({ sandbox: 'required' });
  vi.mocked(getSessionEntry).mockClear();
  const replay = vi.fn();
  await fixture.methods.get(TeamDiscussionGateway.Start)!({
    params: fixture.params,
    respond: replay,
  });
  expect(replay).toHaveBeenCalledWith(true, expect.objectContaining({ state: 'completed' }));
  expect(sdk.execute).toHaveBeenCalledOnce();
  expect(getSessionEntry).not.toHaveBeenCalled();
});

it.each(['before-rejection', 'after-rejection'] as const)(
  'settles a cancelled unknown batch when its exact outcome arrives %s',
  async timing => {
    const methods = new Map<
      string,
      (input: { params: Record<string, unknown>; respond: ReturnType<typeof vi.fn> }) => unknown
    >();
    let service: { start: (context: { stateDir: string }) => void; stop: () => Promise<void> };
    const root = mkdtempSync(path.join(os.tmpdir(), 'team-settings-service-'));
    roots.push(root);
    registerDiscussionService({
      runtime: {
        config: {
          current: () => ({
            plugins: { entries: { 'agent-team': { enabled: true } } },
            agents: { entries: { alice: {}, bob: {} } },
          }),
        },
        channel: {},
        events: { onAgentEvent: vi.fn() },
      },
      registerService: (value: typeof service) => {
        service = value;
      },
      registerChannel: vi.fn(),
      registerTrustedToolPolicy: vi.fn(),
      registerGatewayMethod: (
        name: string,
        method: typeof methods extends Map<string, infer M> ? M : never,
      ) => {
        methods.set(name, method);
      },
    } as never);
    service!.start({ stateDir: root });
    let reject!: (error: Error) => void;
    let outcome!: (agentId: string, state: string) => void;
    sdk.execute.mockImplementation(options => {
      outcome = options.onOutcome;
      options.onExecution({
        agentId: 'alice',
        sessionId: 'alice',
        sessionKey: 'agent:alice:justdo-team:group:room',
        runId: 'native',
        outcome: 'running',
      });
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    });
    const params = {
      discussionId: 'batch',
      room: { id: 'room', members: [{ agentId: 'alice' }, { agentId: 'bob' }] },
      members: [],
      send: {
        roomId: 'room',
        requestId: 'request',
        expectedRevision: 1,
        message: 'Topic',
        selectedAgentIds: [],
        rounds: 1,
      },
    };
    const accepted = vi.fn();
    const running = methods.get(TeamDiscussionGateway.Start)!({ params, respond: accepted });
    expect(accepted).toHaveBeenCalledWith(true, expect.objectContaining({ state: 'running' }));
    const stopped = vi.fn();
    const stopping = methods.get(TeamDiscussionGateway.Stop)!({
      params: { roomId: 'room', discussionId: 'batch' },
      respond: stopped,
    });
    if (timing === 'before-rejection') {
      outcome('alice', 'cancelled');
      const status = vi.fn();
      await methods.get(TeamDiscussionGateway.Status)!({
        params: { roomId: 'room', discussionId: 'batch' },
        respond: status,
      });
      expect(status).toHaveBeenCalledWith(true, expect.objectContaining({ state: 'running' }));
    }
    // Any dispatcher error with an unresolved execution must remain unknown.
    reject(new Error('Unexpected transport failure'));
    await Promise.all([running, stopping]);
    if (timing === 'after-rejection') {
      expect(stopped).toHaveBeenCalledWith(true, expect.objectContaining({ state: 'unknown' }));
      const blocked = vi.fn();
      await methods.get(TeamDiscussionGateway.Start)!({
        params: { ...params, discussionId: 'second' },
        respond: blocked,
      });
      expect(blocked).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: 'teamDiscussionBusy' }),
      );
      outcome('alice', 'cancelled');
    }
    const status = vi.fn();
    await methods.get(TeamDiscussionGateway.Status)!({
      params: { roomId: 'room', discussionId: 'batch' },
      respond: status,
    });
    expect(status).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        state: 'cancelled',
        executions: [expect.objectContaining({ outcome: 'cancelled' })],
      }),
    );
    await service!.stop();
  },
);
