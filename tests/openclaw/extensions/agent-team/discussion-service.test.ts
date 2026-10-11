import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { afterEach, expect, it, vi } from 'vitest';

import { registerDiscussionService } from '../../../../openclaw-extensions/agent-team/discussion/discussion-service';
import { TeamDiscussionGateway } from '../../../../src/shared/cowork/agent-team/teamDiscussion';

const sdk = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../../../openclaw-extensions/agent-team/discussion/discussion-execution', () => ({
  executeGroupDiscussion: sdk.execute,
}));
vi.mock('../../../../openclaw-extensions/agent-team/discussion/discussion-summary', () => ({
  registerDiscussionSummary: vi.fn(),
}));
vi.mock('../../../../openclaw-extensions/agent-team/discussion/discussion-channel', () => ({
  discussionChannel: {},
  bindDiscussionTransport: () => () => {},
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: vi.fn() }));
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
  vi.mocked(getSessionEntry).mockImplementation(({ agentId }) =>
    agentId === 'main'
      ? (sourceEntry as never)
      : ({
          sessionId: `native-${agentId}`,
          lifecycleRevision: 'revision',
          sessionRoot: root,
          permissionMode: 'read-only',
        } as never),
  );
  sdk.execute.mockResolvedValue(undefined);
  registerDiscussionService({
    runtime: {
      config: {
        current: () => ({
          plugins: { entries: { 'agent-team': { enabled: true } } },
          agents: { entries: { main: {}, alice: {}, bob: {} } },
        }),
      },
      channel: { commands: { isControlCommandMessage: () => false } },
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
    changeSource: (changes: Record<string, unknown>) => {
      sourceEntry = { ...sourceEntry, ...changes };
    },
  };
}

it.each([
  { sandbox: 'required' },
  { execHost: 'sandbox' },
  { inheritedToolDeny: ['web_search'] },
  { inheritedToolAllow: ['read'] },
  { toolOverrides: { webSearch: false } },
  { toolOverrides: { mcpServers: { internal: false } } },
  { toolOverrides: { skills: { research: false } } },
])('rejects tightened policy on a non-participating source before dispatch: %j', async policy => {
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
