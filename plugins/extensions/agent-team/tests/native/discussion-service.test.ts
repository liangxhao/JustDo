import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSessionEntry, patchSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { TeamDiscussionGateway } from '../../contracts/teamDiscussion';
import type { executeGroupDiscussion } from '../../discussion/discussion-execution';
import { registerDiscussionService } from '../../discussion/discussion-service';
import { discussionOperationId } from '../../runtime/discussion/receipt';
import { createCustodyClientFixture, createNativeLifecycleFixture } from './fixtures/custodyClient';

const custody = createCustodyClientFixture();
vi.mock('@runtime-services/sdk/custody-client', () => ({ createCustodyClient: () => custody }));
beforeEach(() => custody.reset());

const sdk = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../discussion/discussion-execution', () => ({
  executeGroupDiscussion: sdk.execute,
}));
vi.mock('../../discussion/discussion-summary', () => ({
  registerDiscussionSummary: vi.fn(),
}));
vi.mock('../../discussion/discussion-channel', () => ({
  discussionChannel: {},
  bindDiscussionTransport: () => () => {},
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: vi.fn(),
  patchSessionEntry: vi.fn(),
}));
vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({ getGroupThreadDeliverySession: vi.fn() }));

const roots: string[] = [];
type Invocation = {
  params: Record<string, unknown>;
  respond: ReturnType<typeof vi.fn>;
  signal?: AbortSignal;
  client?: { connect: { client: { mode: string } } };
  hasCurrentClientAuthority?: () => boolean;
};
const backendInvocation = (input: Invocation): Invocation => ({
  client: { connect: { client: { mode: 'backend' } } },
  hasCurrentClientAuthority: () => true,
  ...input,
});
type Service = {
  start: (context: { stateDir: string }) => Promise<void>;
  stop: () => Promise<void>;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function sourcePolicyFixture(policy: Record<string, unknown> = {}, participates = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-service-source-policy-'));
  roots.push(root);
  const methods = new Map<string, (input: Invocation) => unknown>();
  let service: Service;
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
    id: 'agent-team',
    lifecycle: createNativeLifecycleFixture(),
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
      methods.set(name, input => method(backendInvocation(input)));
    },
  } as never);
  await service!.start({ stateDir: root });
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
    service: service!,
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

it('starts a candidate discussion service before its cross-plugin proof can be published', async () => {
  custody.bind.mockResolvedValue(false);
  await sourcePolicyFixture();
  expect(custody.bind).not.toHaveBeenCalled();
});

it.each([
  { client: { connect: { client: { mode: 'webchat' } } } },
  { hasCurrentClientAuthority: () => false },
  { hasCurrentClientAuthority: undefined },
])('rejects an unauthorized discussion request before binding or writing', async authority => {
  const f = await sourcePolicyFixture();
  const respond = vi.fn();
  await f.methods.get(TeamDiscussionGateway.Start)!({ params: f.params, respond, ...authority });
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: 'teamDiscussionDisabled' }),
  );
  expect(custody.bind).not.toHaveBeenCalled();
  expect(existsSync(path.join(f.root, 'agent-team/discussion-receipts/batch.json'))).toBe(false);
  expect(custody.writeExecutionReceipt).not.toHaveBeenCalled();
  expect(sdk.execute).not.toHaveBeenCalled();
  expect(patchSessionEntry).not.toHaveBeenCalled();
  expect(f.gateway).not.toHaveBeenCalled();
});

it.each([TeamDiscussionGateway.Start, TeamDiscussionGateway.Stop, TeamDiscussionGateway.Close])(
  'rejects unbound %s before persisting or dispatching it',
  async method => {
    const f = await sourcePolicyFixture();
    custody.bind.mockResolvedValue(false);
    const respond = vi.fn();
    await f.methods.get(method)!({
      params:
        method === TeamDiscussionGateway.Start
          ? f.params
          : { roomId: 'room', discussionId: 'batch', agentIds: ['alice', 'bob'] },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: 'teamDiscussionDisabled' }),
    );
    expect(existsSync(path.join(f.root, 'agent-team/discussion-receipts/batch.json'))).toBe(false);
    expect(existsSync(path.join(f.root, 'agent-team/discussion-receipts/room.json.closed'))).toBe(
      false,
    );
    expect(custody.writeExecutionReceipt).not.toHaveBeenCalled();
    expect(sdk.execute).not.toHaveBeenCalled();
  },
);

it('reads status without binding or publishing a new execution', async () => {
  const f = await sourcePolicyFixture();
  const respond = vi.fn();
  await f.methods.get(TeamDiscussionGateway.Status)!({
    params: { roomId: 'room', discussionId: 'batch' },
    respond,
  });
  expect(respond).toHaveBeenCalledWith(true, { state: 'unknown' });
  expect(custody.bind).not.toHaveBeenCalled();
  expect(custody.writeExecutionReceipt).not.toHaveBeenCalled();
});

it.each(['stop', 'abort', 'authority'] as const)(
  'rejects a late discussion proof after %s without side effects',
  async changed => {
    const f = await sourcePolicyFixture();
    let resolve!: (ready: boolean) => void;
    custody.bind.mockImplementationOnce(
      () =>
        new Promise<boolean>(done => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    let authority = true;
    const respond = vi.fn();
    const running = f.methods.get(TeamDiscussionGateway.Start)!({
      params: f.params,
      respond,
      signal: controller.signal,
      hasCurrentClientAuthority: () => authority,
    });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    if (changed === 'stop') await f.service.stop();
    else if (changed === 'abort') controller.abort();
    else authority = false;
    resolve(true);
    await running;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: 'teamDiscussionDisabled' }),
    );
    expect(existsSync(path.join(f.root, 'agent-team/discussion-receipts/batch.json'))).toBe(false);
    expect(custody.writeExecutionReceipt).not.toHaveBeenCalled();
    expect(sdk.execute).not.toHaveBeenCalled();
  },
);

it('keeps accepted discussion work bound to the service after its opening request ends', async () => {
  const f = await sourcePolicyFixture();
  const controller = new AbortController();
  let authority = true;
  let finish!: () => void;
  let sourceGuard!: () => void;
  sdk.execute.mockImplementation((options: Parameters<typeof executeGroupDiscussion>[0]) => {
    sourceGuard = options.assertSourceCurrent!;
    options.onExecution({
      discussionId: 'batch',
      agentId: 'alice',
      sessionId: 'native-alice',
      lifecycleRevision: 'revision',
      sessionKey: 'agent:alice:agent-team:group:room',
      runId: 'accepted',
      outcome: 'running',
    });
    return new Promise<void>(resolve => {
      finish = () => {
        options.onOutcome('alice', 'completed');
        resolve();
      };
    });
  });
  const respond = vi.fn();
  const pending = f.methods.get(TeamDiscussionGateway.Start)!({
    params: f.params,
    respond,
    signal: controller.signal,
    hasCurrentClientAuthority: () => authority,
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ state: 'running' }));
  controller.abort();
  authority = false;
  expect(() => sourceGuard()).not.toThrow();
  finish();
  await pending;
  expect(custody.writeExecutionReceipt).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cleanupComplete: true,
      subjects: [expect.objectContaining({ runId: 'accepted' })],
    }),
  );
});

it('enrolls exact native execution identities and cleanup without copying discussion bodies', async () => {
  const fixture = await sourcePolicyFixture();
  const execution = {
    discussionId: 'batch',
    agentId: 'alice',
    sessionId: 'native-alice',
    lifecycleRevision: 'revision',
    sessionKey: 'agent:alice:agent-team:group:room',
    runId: 'actual-run',
  };
  sdk.execute.mockImplementation(async (options: Parameters<typeof executeGroupDiscussion>[0]) => {
    options.onExecution?.({ ...execution, outcome: 'running' });
    options.onOutcome?.('alice', 'completed');
  });
  await fixture.methods.get(TeamDiscussionGateway.Start)!({
    params: fixture.params,
    respond: vi.fn(),
  });
  const { discussionId: _discussionId, ...subject } = execution;
  await vi.waitFor(() =>
    expect(custody.writeExecutionReceipt).toHaveBeenLastCalledWith({
      operationId: discussionOperationId('discussion', 'batch'),
      inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      subjects: [subject],
      cleanupComplete: true,
    }),
  );
  expect(custody.writeExecutionReceipt).toHaveBeenCalledWith(
    expect.objectContaining({
      subjects: [],
      cleanupComplete: false,
    }),
  );
  expect(JSON.stringify(custody.writeExecutionReceipt.mock.calls)).not.toContain(
    fixture.params.send.message,
  );
});

it.each([{ sandbox: 'required' }])(
  'rejects immutable source isolation before dispatch: %j',
  async policy => {
    const fixture = await sourcePolicyFixture();
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
  const fixture = await sourcePolicyFixture();
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
  const fixture = await sourcePolicyFixture();
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
  const fixture = await sourcePolicyFixture({ toolOverrides: { webSearch: false } });
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
  const fixture = await sourcePolicyFixture();
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
  const fixture = await sourcePolicyFixture();
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
  const fixture = await sourcePolicyFixture();
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

it('does not adopt a retained member identity from the retired channel namespace', async () => {
  const fixture = await sourcePolicyFixture();
  const readCurrent = vi.mocked(getSessionEntry).getMockImplementation()!;
  vi.mocked(getSessionEntry).mockImplementation(params => {
    if (params.agentId === 'main') return readCurrent(params);
    return params.sessionKey === 'agent:alice:justdo-team:group:room'
      ? (fixture.entries.get('alice') as never)
      : undefined;
  });
  const prepared = await fixture.prepare();
  expect(prepared).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: 'teamDiscussionSessionChanged' }),
  );
  expect(getSessionEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: 'alice',
      sessionKey: 'agent:alice:agent-team:group:room',
    }),
  );
  expect(fixture.gateway).not.toHaveBeenCalled();
  expect(patchSessionEntry).not.toHaveBeenCalled();
});

it('rejects source drift while a member policy update waits for its commit', async () => {
  const fixture = await sourcePolicyFixture();
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
  const fixture = await sourcePolicyFixture(changes);
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
    const fixture = await sourcePolicyFixture(
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
  const fixture = await sourcePolicyFixture();
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
    const methods = new Map<string, (input: Invocation) => unknown>();
    let service: {
      start: (context: { stateDir: string }) => Promise<void>;
      stop: () => Promise<void>;
    };
    const root = mkdtempSync(path.join(os.tmpdir(), 'team-settings-service-'));
    roots.push(root);
    registerDiscussionService({
      id: 'agent-team',
      lifecycle: createNativeLifecycleFixture(),
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
        methods.set(name, input => method(backendInvocation(input)));
      },
    } as never);
    await service!.start({ stateDir: root });
    let reject!: (error: Error) => void;
    let outcome!: (agentId: string, state: string) => void;
    sdk.execute.mockImplementation(options => {
      outcome = options.onOutcome;
      options.onExecution({
        agentId: 'alice',
        sessionId: 'alice',
        sessionKey: 'agent:alice:agent-team:group:room',
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
    await vi.waitFor(() =>
      expect(accepted).toHaveBeenCalledWith(true, expect.objectContaining({ state: 'running' })),
    );
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
