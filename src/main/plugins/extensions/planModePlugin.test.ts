import { beforeEach, describe, expect, test, vi } from 'vitest';

import planModePlugin from '../../../../openclaw-extensions/plan-mode/index';

const sdk = vi.hoisted(() => ({ getSessionEntry: vi.fn() }));

vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: sdk.getSessionEntry,
}));

vi.mock('openclaw/plugin-sdk/agent-harness-runtime', () => ({
  isReplaySafeToolCall: (toolName: string, params: unknown) => {
    const action =
      params && typeof params === 'object' && 'action' in params
        ? String((params as { action?: unknown }).action ?? '')
        : '';
    const safeActions: Record<string, string[]> = {
      browser: ['console', 'profiles', 'snapshot', 'status', 'tabs'],
      gateway: ['config.get', 'config.schema.lookup'],
      sessions: ['group_list'],
      skill_workshop: ['list', 'inspect', 'read'],
      subagents: ['', 'list'],
      theme: ['list', 'get'],
    };
    return safeActions[toolName]?.includes(action) ?? false;
  },
}));

type ToolFactory = (context: { sessionKey?: string }) => {
  catalogMode?: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }> }>;
} | null;

const registerPlugin = () => {
  const hooks = new Map<string, (event: unknown, context: { sessionKey?: string }) => unknown>();
  const gatewayMethods = new Map<
    string,
    (request: { params: Record<string, unknown>; respond: ReturnType<typeof vi.fn> }) => void
  >();
  let policy: ((event: unknown, context: unknown) => unknown) | undefined;
  let toolFactory: ToolFactory | undefined;
  let service: { start: (context: unknown) => void; stop: () => void } | undefined;
  planModePlugin.register({
    session: { state: { registerSessionExtension: vi.fn() } },
    on: (name: string, hook: (event: unknown, context: { sessionKey?: string }) => unknown) =>
      hooks.set(name, hook),
    registerTrustedToolPolicy: (registration: { evaluate: typeof policy }) => {
      policy = registration.evaluate;
    },
    registerGatewayMethod: (name: string, handler: never) => gatewayMethods.set(name, handler),
    registerTool: (factory: ToolFactory) => {
      toolFactory = factory;
    },
    registerService: (registration: typeof service) => {
      service = registration;
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as never);
  return {
    gatewayMethods,
    hooks,
    get policy() {
      return policy;
    },
    get service() {
      return service;
    },
    get toolFactory() {
      return toolFactory;
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.getSessionEntry.mockReturnValue({
    justdoPlanMode: { enabled: true, updatedAt: 1 },
  });
});

describe('Plan mode extension', () => {
  test('injects planning instructions and blocks mutations while preserving read-only research', () => {
    const registered = registerPlugin();
    const context = { sessionKey: 'agent:main:justdo:session-1' };
    const prepared = registered.hooks.get('agent_turn_prepare')?.({}, context) as {
      prependContext?: string;
    };
    expect(prepared.prependContext).toContain('Do not modify files');
    expect(prepared.prependContext).toContain('PresentPlan is the tool name');
    expect(prepared.prependContext).toContain('Do not implement in this planning run');
    expect(prepared.prependContext).toContain('resets the context');
    expect(prepared.prependContext).not.toContain('Plan mode has been disabled');

    const policyContext = { getSessionExtension: () => ({ enabled: true, updatedAt: 1 }) };
    expect(registered.policy?.({ toolName: 'write', params: {} }, policyContext)).toMatchObject({
      allow: false,
    });
    expect(
      registered.policy?.({ toolName: 'read', params: { path: 'README.md' } }, policyContext),
    ).toBeUndefined();
    expect(
      registered.policy?.(
        { toolName: 'presentplan', params: {}, derivedPaths: ['should-not-block'] },
        policyContext,
      ),
    ).toBeUndefined();
    expect(
      registered.policy?.({ toolName: 'browser', params: { action: 'snapshot' } }, policyContext),
    ).toBeUndefined();
    expect(
      registered.policy?.({ toolName: 'message', params: { action: 'send' } }, policyContext),
    ).toMatchObject({ allow: false });
    expect(
      registered.policy?.({ toolName: 'sessions_spawn', params: {} }, policyContext),
    ).toMatchObject({ allow: false });
    expect(
      registered.policy?.({ toolName: 'exec', params: { command: 'rg TODO src' } }, policyContext),
    ).toBeUndefined();
    expect(
      registered.policy?.({ toolName: 'exec', params: { command: 'rm -rf build' } }, policyContext),
    ).toMatchObject({ allow: false });
    expect(
      registered.policy?.(
        {
          toolName: 'exec',
          params: { command: 'Get-ChildItem *.ts -Force | Select-Object Mode, Name' },
        },
        policyContext,
      ),
    ).toBeUndefined();
    expect(
      registered.policy?.(
        { toolName: 'exec', params: { command: 'Get-ChildItem | Remove-Item' } },
        policyContext,
      ),
    ).toMatchObject({ allow: false });
    expect(
      registered.policy?.(
        { toolName: 'exec', params: { command: 'Get-Content (Remove-Item target)' } },
        policyContext,
      ),
    ).toMatchObject({ allow: false });
  });

  test.each([
    ['sessions', { action: 'group_list' }, false],
    ['sessions', { action: 'patch' }, true],
    ['theme', { action: 'list' }, false],
    ['theme', { action: 'get' }, false],
    ['theme', { action: 'set' }, true],
    ['theme', { action: 'import' }, true],
    ['theme', {}, true],
    ['skill_workshop', { action: 'read' }, false],
    ['skill_workshop', { action: 'create' }, true],
    ['subagents', { action: 'list' }, false],
    ['subagents', { action: 'cancel' }, true],
    ['gateway', { action: 'config.get' }, false],
    ['gateway', { action: 'config.patch' }, true],
    ['progress_card', { plan: [] }, true],
    ['conversations_turn', { threadId: 'thread-1' }, true],
    ['openclaw', { message: 'restart gateway' }, true],
    ['dashboard', { action: 'tab_create' }, true],
    ['dismiss_task', { task_id: 'task-1' }, true],
    ['tool_call', { id: 'write' }, false],
    ['tool_search_code', { code: 'return await openclaw.tools.call("read", {})' }, true],
  ])('classifies %s action %#', (toolName, params, blocked) => {
    const registered = registerPlugin();
    const result = registered.policy?.(
      { toolName, params },
      { getSessionExtension: () => ({ enabled: true, updatedAt: 1 }) },
    );
    if (blocked) expect(result).toMatchObject({ allow: false });
    else expect(result).toBeUndefined();
  });

  test('waits for plan review and resumes implementation after approval', async () => {
    const registered = registerPlugin();
    const emit = vi.fn();
    registered.service?.start({ gatewayEvents: { emit } });
    const tool = registered.toolFactory?.({ sessionKey: 'agent:main:justdo:session-1' });
    expect(tool).not.toBeNull();
    expect(tool?.catalogMode).toBe('direct-only');

    const execution = tool!.execute('tool-1', { title: 'Plan', plan: '1. Inspect\n2. Edit' });
    const request = emit.mock.calls[0][1] as { requestId: string };
    const respond = vi.fn();
    sdk.getSessionEntry.mockReturnValue({
      justdoPlanMode: { enabled: false, updatedAt: 2 },
    });
    registered.gatewayMethods.get('planMode.resolve')?.({
      params: { requestId: request.requestId, decision: 'implement' },
      respond,
    });

    await expect(execution).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('reset this session context') }],
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ decision: 'implement' }));
  });

  test('allows approval while Plan mode remains enabled for the finishing planning turn', async () => {
    const registered = registerPlugin();
    const emit = vi.fn();
    registered.service?.start({ gatewayEvents: { emit } });
    const tool = registered.toolFactory?.({ sessionKey: 'agent:main:justdo:session-1' });
    const execution = tool!.execute('tool-1', { plan: 'Inspect first' });
    const request = emit.mock.calls[0][1] as { requestId: string };
    const respond = vi.fn();

    registered.gatewayMethods.get('planMode.resolve')?.({
      params: { requestId: request.requestId, decision: 'implement' },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: 'implement', sessionKey: 'agent:main:justdo:session-1' }),
    );
    await expect(execution).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('reset this session context') }],
    });
  });

  test('rechecks Plan mode when a previously created PresentPlan tool executes', async () => {
    const registered = registerPlugin();
    registered.service?.start({ gatewayEvents: { emit: vi.fn() } });
    const tool = registered.toolFactory?.({ sessionKey: 'agent:main:justdo:session-1' });
    sdk.getSessionEntry.mockReturnValue({
      justdoPlanMode: { enabled: false, updatedAt: 2 },
    });

    await expect(tool!.execute('tool-1', { plan: 'Stale plan' })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('no longer enabled') }],
    });
  });

  test('cancels an aborted review and allows a new review in the same session', async () => {
    const registered = registerPlugin();
    const emit = vi.fn();
    registered.service?.start({ gatewayEvents: { emit } });
    const tool = registered.toolFactory?.({ sessionKey: 'agent:main:justdo:session-1' });
    const controller = new AbortController();
    const execution = tool!.execute('tool-1', { plan: 'First plan' }, controller.signal);
    controller.abort();
    await expect(execution).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('cancelled') }],
    });
    const respond = vi.fn();
    registered.gatewayMethods.get('planMode.list')?.({ params: {}, respond });
    expect(respond).toHaveBeenCalledWith(true, { requests: [] });
    const next = tool!.execute('tool-2', { plan: 'Second plan' });
    expect(emit.mock.calls.filter(([event]) => event === 'requested')).toHaveLength(2);
    registered.service?.stop();
    await expect(next).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('cancelled') }],
    });
  });
});
