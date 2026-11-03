import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EMBEDDED_BROWSER_CANCELLED_EVENT,
  EMBEDDED_BROWSER_RELEASED_EVENT,
  EMBEDDED_BROWSER_REQUESTED_EVENT,
  EMBEDDED_BROWSER_REVOKED_EVENT,
  EMBEDDED_BROWSER_STOPPED_EVENT,
} from '../../../plugins/extensions/embedded-browser/browserExecutionContract';
import embeddedBrowserPlugin from '../../../plugins/extensions/embedded-browser/index';
import type { ScheduledTask } from '../../shared/scheduledTask/types';
import { EmbeddedBrowserGatewayBridge } from './embeddedBrowserGatewayBridge';

const nativeSdk = vi.hoisted(() => ({ getSessionEntry: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: nativeSdk.getSessionEntry,
}));
vi.mock('openclaw/plugin-sdk/media-store', () => ({ saveMediaBuffer: vi.fn() }));

const workspaceDir = path.resolve('test-workspace');
const userRun = {
  sessionKey: 'agent:main:justdo:conversation',
  sessionId: 'native-1',
  runId: 'run-1',
  trigger: 'user',
  workspaceDir,
};
const cronRun = {
  ...userRun,
  sessionKey: 'agent:main:cron:job-1:run:iteration',
  trigger: 'cron',
  jobId: 'job-1',
};
const request = (
  run = userRun,
  requestId = 'request-1',
  command: Record<string, unknown> = { action: 'open', url: 'https://example.com' },
  admissionRevision = 1,
) => ({
  event: EMBEDDED_BROWSER_REQUESTED_EVENT,
  payload: {
    requestId,
    run,
    sessionKey: run.sessionKey,
    toolCallId: `call-${requestId}`,
    admissionRevision,
    command,
    policy: { allowLocalFiles: true },
  },
});

const setup = () => {
  const options = {
    isEnabled: vi.fn(() => true),
    getDesktopSession: vi.fn(() => ({ id: 'conversation', cwd: workspaceDir })),
    getScheduledTask: vi.fn(
      async () =>
        ({
          id: 'job-1',
          management: 'editable',
          sessionTarget: 'isolated',
          agentId: 'main',
          payload: { kind: 'agentTurn' },
        }) as ScheduledTask,
    ),
    execute: vi.fn(
      async (_key: string, _command: unknown, _signal: AbortSignal, _scope: unknown) => ({
        ok: true,
      }),
    ),
    releaseScope: vi.fn(),
    revokeAll: vi.fn(),
    resolve: vi.fn(async (_id: string, _response: Record<string, unknown>) => undefined),
  };
  return { options, bridge: new EmbeddedBrowserGatewayBridge(options) };
};

describe('authenticated embedded browser Gateway boundary', () => {
  it('keeps ordinary headless omission and the product workspace; model identity fields do not choose the scope', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(
      request(userRun, 'r1', { action: 'open', sessionId: 'forged', workspaceDir: '/forged' }),
    );
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    expect(options.execute).toHaveBeenCalledWith(
      userRun.sessionKey,
      expect.objectContaining({ action: 'open' }),
      expect.any(AbortSignal),
      {
        sessionId: 'conversation',
        runId: 'run-1',
        workspaceDir,
        headlessOnly: false,
        allowLocalFiles: true,
      },
    );
  });

  it('prepares a scheduled run with its own page scope and the trusted workspace', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request(cronRun));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalled());
    expect(options.execute.mock.calls[0][3]).toMatchObject({
      sessionId: expect.stringMatching(/^browser-run:[a-f0-9]{64}$/),
      headlessOnly: true,
      workspaceDir,
    });
    expect(options.getDesktopSession).not.toHaveBeenCalled();
  });

  it('rejects cron false and advanced or managed task shapes', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request(cronRun, 'false', { action: 'open', headless: false }));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('false', expect.objectContaining({ ok: false })),
    );
    options.getScheduledTask.mockResolvedValue({
      id: 'job-1',
      management: 'managed',
    } as ScheduledTask);
    bridge.handleEvent(request({ ...cronRun, runId: 'run-2' }, 'managed'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'managed',
        expect.objectContaining({ ok: false }),
      ),
    );
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('rejects missing transport identity, unavailable mapping and mismatched workspace', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REQUESTED_EVENT,
      payload: { requestId: 'forged', sessionKey: userRun.sessionKey, command: { action: 'open' } },
    });
    expect(options.execute).not.toHaveBeenCalled();
    options.getDesktopSession.mockReturnValue({
      id: 'conversation',
      cwd: path.resolve('different'),
    });
    bridge.handleEvent(request());
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'request-1',
        expect.objectContaining({ ok: false }),
      ),
    );
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('does not replay a duplicate requested event', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    bridge.handleEvent(request());
    expect(options.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an imported binding to a different native incarnation', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue({
      id: 'conversation',
      cwd: workspaceDir,
      historyBinding: { nativeSessionId: 'different-native-session' },
    } as ReturnType<typeof options.getDesktopSession>);
    bridge.handleEvent(request());
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('request-1', {
        ok: false,
        error: 'The browser session binding is unavailable.',
      }),
    );
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('matches cancellation to the complete run and tool call', async () => {
    const { options, bridge } = setup();
    options.execute.mockImplementation(
      async (_key, _command, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const event = request();
    bridge.handleEvent(event);
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalled());
    const signal = options.execute.mock.calls[0][2];
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_CANCELLED_EVENT,
      payload: { ...event.payload, run: { ...userRun, runId: 'other-run' } },
    });
    expect(signal.aborted).toBe(false);
    bridge.handleEvent({ event: EMBEDDED_BROWSER_CANCELLED_EVENT, payload: event.payload });
    expect(signal.aborted).toBe(true);
    expect(options.resolve).not.toHaveBeenCalled();
  });

  it('fences a request cancelled while task ownership is being checked', async () => {
    const { options, bridge } = setup();
    let finish!: (job: ScheduledTask) => void;
    options.getScheduledTask.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    bridge.handleEvent(request(cronRun));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: cronRun, reason: 'settled', discardPages: false },
    });
    finish({
      id: 'job-1',
      management: 'editable',
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn' },
    } as ScheduledTask);
    await new Promise(resolve => setImmediate(resolve));
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('releases cron pages at the exact release, while ordinary settled pages remain available', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request(userRun, 'user'));
    bridge.handleEvent(request(cronRun, 'cron'));
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(2));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: userRun, reason: 'settled', discardPages: false },
    });
    expect(options.releaseScope).toHaveBeenCalledWith('conversation', false);
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: cronRun, reason: 'settled', discardPages: false },
    });
    expect(options.releaseScope).toHaveBeenCalledWith(expect.stringMatching(/^browser-run:/), true);
  });

  it('keeps a run revocation signal alive after the request result for armed callbacks', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    const signal = options.execute.mock.calls[0][2];
    expect(signal.aborted).toBe(false);
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: userRun, reason: 'settled', discardPages: false },
    });
    expect(signal.aborted).toBe(true);
  });

  it.each([false, true])(
    'revokes effects on tool disposal and waits for the terminal to discard ordinary pages: %s',
    async discardPages => {
      const { options, bridge } = setup();
      bridge.handleEvent(request());
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
      const signal = options.execute.mock.calls[0][2];

      bridge.handleEvent({
        event: EMBEDDED_BROWSER_REVOKED_EVENT,
        payload: { run: userRun, admissionRevision: 1 },
      });

      expect(signal.aborted).toBe(true);
      expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith('conversation', false);
      bridge.handleEvent(request(userRun, 'after-disposal'));
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(2));
      expect(options.execute).toHaveBeenCalledTimes(1);
      bridge.handleEvent({
        event: EMBEDDED_BROWSER_REVOKED_EVENT,
        payload: { run: userRun, admissionRevision: 1 },
      });
      expect(options.releaseScope).toHaveBeenCalledTimes(1);

      bridge.handleEvent({
        event: EMBEDDED_BROWSER_RELEASED_EVENT,
        payload: { run: userRun, reason: 'settled', discardPages },
      });

      expect(options.releaseScope).toHaveBeenLastCalledWith('conversation', discardPages);
      expect(options.releaseScope).toHaveBeenCalledTimes(2);
    },
  );

  it('fences source disposal while the first cron request awaits the native job', async () => {
    const { options, bridge } = setup();
    let finish!: (job: ScheduledTask) => void;
    options.getScheduledTask.mockImplementation(() => new Promise(resolve => (finish = resolve)));
    bridge.handleEvent(request(cronRun));

    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: cronRun, admissionRevision: 1 },
    });
    finish({
      id: 'job-1',
      management: 'editable',
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn' },
    } as ScheduledTask);
    await new Promise(resolve => setImmediate(resolve));
    bridge.handleEvent(request(cronRun, 'late-call'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'late-call',
        expect.objectContaining({ ok: false }),
      ),
    );

    expect(options.execute).not.toHaveBeenCalled();
    expect(options.getScheduledTask).toHaveBeenCalledTimes(1);
  });

  it('requires a higher admission revision to resume the same native run after disposal', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
    const retiredSignal = options.execute.mock.calls[0][2];
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: userRun, admissionRevision: 1 },
    });

    bridge.handleEvent(request(userRun, 'retired'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'retired',
        expect.objectContaining({ ok: false }),
      ),
    );
    expect(options.execute).toHaveBeenCalledTimes(1);

    bridge.handleEvent(request(userRun, 'renewed', { action: 'status' }, 2));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'renewed',
        expect.objectContaining({ ok: true }),
      ),
    );
    expect(options.execute).toHaveBeenCalledTimes(2);
    expect(retiredSignal.aborted).toBe(true);
    expect(options.execute.mock.calls[1][2].aborted).toBe(false);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith('conversation', false);
  });

  it('retires an older live admission and ignores its delayed request, revocation and cancellation', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
    const retiredSignal = options.execute.mock.calls[0][2];
    let finish!: (result: { ok: boolean }) => void;
    options.execute.mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const current = request(userRun, 'current', { action: 'status' }, 2);

    bridge.handleEvent(current);
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    const currentSignal = options.execute.mock.calls[1][2];
    expect(retiredSignal.aborted).toBe(true);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith('conversation', false);
    bridge.handleEvent(request(userRun, 'delayed-old-request'));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: userRun, admissionRevision: 1 },
    });
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_CANCELLED_EVENT,
      payload: { ...current.payload, admissionRevision: 1 },
    });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'delayed-old-request',
        expect.objectContaining({ ok: false }),
      ),
    );
    expect(currentSignal.aborted).toBe(false);
    expect(options.execute).toHaveBeenCalledTimes(2);
    expect(options.releaseScope).toHaveBeenCalledTimes(1);

    finish({ ok: true });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'current',
        expect.objectContaining({ ok: true }),
      ),
    );
  });

  it('fences an older cron admission that finishes ownership preparation after its replacement', async () => {
    const { options, bridge } = setup();
    const job = await options.getScheduledTask();
    options.getScheduledTask.mockClear();
    let finishRetired!: (value: ScheduledTask) => void;
    options.getScheduledTask.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRetired = resolve;
        }),
    );
    bridge.handleEvent(request(cronRun, 'retired-preparation'));
    bridge.handleEvent(request(cronRun, 'current-preparation', { action: 'status' }, 2));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'current-preparation',
        expect.objectContaining({ ok: true }),
      ),
    );
    const currentSignal = options.execute.mock.calls[0][2];

    finishRetired(job);
    await new Promise(resolve => setImmediate(resolve));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: cronRun, admissionRevision: 1 },
    });

    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.resolve).not.toHaveBeenCalledWith('retired-preparation', expect.anything());
    expect(currentSignal.aborted).toBe(false);
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it.each(['settled', 'service-stopped'] as const)(
    'does not reopen a closed native run with a higher admission revision after %s',
    async reason => {
      const { options, bridge } = setup();
      bridge.handleEvent(request());
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
      if (reason === 'service-stopped')
        bridge.handleEvent({ event: EMBEDDED_BROWSER_STOPPED_EVENT });
      else
        bridge.handleEvent({
          event: EMBEDDED_BROWSER_RELEASED_EVENT,
          payload: { run: userRun, reason: 'settled', discardPages: false },
        });

      bridge.handleEvent(request(userRun, 'after-close', { action: 'status' }, 2));
      await vi.waitFor(() =>
        expect(options.resolve).toHaveBeenCalledWith(
          'after-close',
          expect.objectContaining({ ok: false }),
        ),
      );
      expect(options.execute).toHaveBeenCalledTimes(1);
      expect(options.execute.mock.calls[0][2].aborted).toBe(true);
    },
  );

  it.each([EMBEDDED_BROWSER_REVOKED_EVENT, EMBEDDED_BROWSER_RELEASED_EVENT])(
    'ignores conflicting full identity during native job preparation: %s',
    async event => {
      const { options, bridge } = setup();
      let finish!: (job: ScheduledTask) => void;
      options.getScheduledTask.mockImplementation(() => new Promise(resolve => (finish = resolve)));
      bridge.handleEvent(request(cronRun));

      bridge.handleEvent({
        event,
        payload: {
          run: { ...cronRun, workspaceDir: path.resolve('foreign') },
          admissionRevision: 1,
          reason: 'revoked',
          discardPages: true,
        },
      });
      finish({
        id: 'job-1',
        management: 'editable',
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn' },
      } as ScheduledTask);
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());

      expect(options.execute).toHaveBeenCalledTimes(1);
      expect(options.execute.mock.calls[0][2].aborted).toBe(false);
    },
  );

  it('ignores a release with conflicting complete run identity', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    const signal = options.execute.mock.calls[0][2];

    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: { ...userRun, workspaceDir: path.resolve('foreign') },
        reason: 'revoked',
        discardPages: true,
      },
    });

    expect(signal.aborted).toBe(false);
    expect(options.releaseScope).not.toHaveBeenCalled();
    bridge.handleEvent(request(userRun, 'still-current'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
  });

  it.each(['settled', 'revoked', 'deleted', 'disconnected'] as const)(
    'shares one run lifetime across concurrently prepared requests on %s',
    async reason => {
      const { options, bridge } = setup();
      bridge.handleEvent(request(userRun, 'parallel-1'));
      bridge.handleEvent(request(userRun, 'parallel-2'));
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(2));
      const signals = options.execute.mock.calls.map(call => call[2]);
      expect(signals).toHaveLength(2);
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      if (reason === 'deleted') bridge.deleteSession('conversation');
      else if (reason === 'disconnected') bridge.revoke();
      else
        bridge.handleEvent({
          event: EMBEDDED_BROWSER_RELEASED_EVENT,
          payload: { run: userRun, reason, discardPages: reason === 'revoked' },
        });
      expect(signals.every(signal => signal.aborted)).toBe(true);
    },
  );

  it('retires retained pages when a product session acquires a new native incarnation', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: userRun, reason: 'settled', discardPages: false },
    });
    options.releaseScope.mockClear();
    bridge.handleEvent(request({ ...userRun, sessionId: 'native-2', runId: 'run-2' }, 'new'));
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(2));
    expect(options.releaseScope).toHaveBeenCalledWith('conversation', true);
  });

  it('revokes retained pages on service stop or disconnect and closes deleted conversations', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    bridge.deleteSession('conversation');
    expect(options.releaseScope).toHaveBeenCalledWith('conversation', true);
    bridge.handleEvent({ event: EMBEDDED_BROWSER_STOPPED_EVENT });
    expect(options.revokeAll).toHaveBeenCalledTimes(1);
    bridge.revoke();
    expect(options.revokeAll).toHaveBeenCalledTimes(2);
  });

  it('fences a first request deleted after its product record has already been removed', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    options.getDesktopSession.mockImplementation(() => null as never);
    bridge.deleteSession('conversation');
    await new Promise(resolve => setImmediate(resolve));
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.releaseScope).toHaveBeenCalledWith('conversation', true);
  });
});

describe('plugin to Main cancellation after an armed browser result', () => {
  type HookHandler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;
  type GatewayHandler = (context: {
    params: Record<string, unknown>;
    respond: (...args: unknown[]) => void;
  }) => void;
  type Service = {
    start(context: { gatewayEvents: { emit(name: string, payload: unknown): void } }): void;
    stop(): void;
  };
  type ToolFactory = {
    create(context: Record<string, unknown>): {
      execute(
        toolCallId: string,
        command: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{ isError?: boolean; details: Record<string, unknown> }>;
    };
  };
  let sequence = 0;
  const stops: Array<() => void> = [];
  afterEach(() => stops.splice(0).forEach(stop => stop()));

  const createBoundary = () => {
    const { options, bridge } = setup();
    const run = { ...userRun, runId: `boundary-run-${++sequence}` };
    nativeSdk.getSessionEntry.mockReturnValue({
      sessionId: run.sessionId,
      lifecycleRevision: 'one',
    });
    const hooks = new Map<string, HookHandler>();
    const methods = new Map<string, GatewayHandler>();
    let lifecycle!: (event: Record<string, unknown>) => void;
    let service!: Service;
    let factory!: ToolFactory;
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const delayedEffect = vi.fn();
    const effects: Array<() => void> = [];
    options.execute.mockImplementation(async (_key, _command, signal) => {
      effects.push(() => {
        signal.throwIfAborted();
        delayedEffect();
      });
      return { ok: true, armed: true };
    });
    options.resolve.mockImplementation(async (requestId, response) => {
      methods.get('embeddedBrowser.resolve')!({
        params: { requestId, ...response },
        respond() {},
      });
    });
    embeddedBrowserPlugin.register({
      logger: { warn: vi.fn() },
      on(name: string, handler: HookHandler) {
        hooks.set(name, handler);
      },
      registerService(value: Service) {
        service = value;
      },
      registerTool(value: ToolFactory) {
        factory = value;
      },
      registerGatewayMethod(name: string, handler: GatewayHandler) {
        methods.set(name, handler);
      },
      runtime: {
        events: {
          onAgentEvent: (listener: typeof lifecycle) => {
            lifecycle = listener;
            return () => undefined;
          },
        },
      },
    } as unknown as Parameters<typeof embeddedBrowserPlugin.register>[0]);
    service.start({
      gatewayEvents: {
        emit(name: string, payload: unknown) {
          emitted.push({ name, payload });
          bridge.handleEvent({ event: `plugin.embedded-browser.${name}`, payload });
        },
      },
    });
    stops.push(() => service.stop());
    const prompt = () =>
      hooks.get('before_prompt_build')!(
        {},
        {
          ...run,
          toolAuthority: { allows: () => true, assertActive() {} },
        },
      );
    prompt();
    const tool = factory.create({ ...run, assertInvocationCurrent() {} });
    const prepare = (toolCallId: string, signal?: AbortSignal) =>
      hooks.get('before_tool_call')!(
        { toolName: 'browser', runId: run.runId, toolCallId },
        { ...run, toolName: 'browser', toolCallId, abortSignal: signal },
      );
    const releases = () => emitted.filter(event => event.name === 'released');
    const revocations = () => emitted.filter(event => event.name === 'revoked');
    const settle = (aborted = false) =>
      lifecycle({
        ...run,
        stream: 'lifecycle',
        data: { phase: 'end', executionSettled: true, aborted },
      });
    return {
      options,
      run,
      tool,
      prompt,
      prepare,
      releases,
      revocations,
      settle,
      effects,
      delayedEffect,
      service,
    };
  };

  it.each([
    ['dialog', 'hook'],
    ['dialog', 'execute'],
    ['upload', 'hook'],
    ['upload', 'execute'],
  ] as const)(
    'revokes a returned %s effect on native %s abort before any terminal',
    async (action, source) => {
      const f = createBoundary();
      const controller = new AbortController();
      f.prepare('armed', source === 'hook' ? controller.signal : undefined);
      const result = await f.tool.execute(
        'armed',
        {
          action,
          headless: true,
          ...(action === 'dialog' ? { accept: true } : { paths: ['fixture.txt'] }),
        },
        source === 'execute' ? controller.signal : undefined,
      );
      await new Promise(resolve => setImmediate(resolve));
      expect(result.isError).toBeUndefined();
      expect(result.details.armed).toBe(true);
      expect(f.releases()).toEqual([]);
      expect(f.options.execute.mock.calls[0][2].aborted).toBe(false);

      controller.abort();

      expect(f.revocations()).toEqual([
        { name: 'revoked', payload: { run: f.run, admissionRevision: 1 } },
      ]);
      expect(f.releases()).toEqual([]);
      expect(f.options.execute.mock.calls[0][2].aborted).toBe(true);
      expect(f.options.releaseScope).toHaveBeenCalledExactlyOnceWith('conversation', false);
      expect(() => f.effects[0]()).toThrow();
      expect(f.delayedEffect).not.toHaveBeenCalled();
      expect(f.prepare('subsequent')).toMatchObject({ block: true });
      f.service.stop();
      expect(f.releases()).toHaveLength(1);
    },
  );

  it('retains every concurrent call source after all responses return', async () => {
    const f = createBoundary();
    const first = new AbortController();
    const second = new AbortController();
    f.prepare('first', first.signal);
    f.prepare('second', second.signal);
    await Promise.all([
      f.tool.execute('first', { action: 'dialog', accept: true, headless: true }),
      f.tool.execute('second', { action: 'upload', paths: ['fixture.txt'], headless: true }),
    ]);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.effects).toHaveLength(2);

    first.abort();

    expect(f.revocations()).toHaveLength(1);
    expect(f.releases()).toEqual([]);
    expect(
      f.effects.every(effect => {
        try {
          effect();
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(f.delayedEffect).not.toHaveBeenCalled();
    second.abort();
    expect(f.revocations()).toHaveLength(1);
  });

  it('renews the plugin and Main admission only after a fresh authorized prompt while old armed effects stay retired', async () => {
    const f = createBoundary();
    const retiredSource = new AbortController();
    f.prepare('before-retry', retiredSource.signal);
    await f.tool.execute('before-retry', { action: 'dialog', accept: true, headless: true });
    const retiredSignal = f.options.execute.mock.calls[0][2];

    retiredSource.abort();
    expect(f.prepare('without-fresh-authority')).toMatchObject({ block: true });
    expect(retiredSignal.aborted).toBe(true);
    expect(() => f.effects[0]()).toThrow();

    f.prompt();
    const currentSource = new AbortController();
    expect(f.prepare('after-retry', currentSource.signal)).toBeUndefined();
    const result = await f.tool.execute('after-retry', { action: 'status', headless: true });

    expect(result.isError).toBeUndefined();
    expect(f.options.execute).toHaveBeenCalledTimes(2);
    expect(f.options.execute.mock.calls[1][2].aborted).toBe(false);
    expect(() => f.effects[0]()).toThrow();
    expect(() => f.effects[1]()).not.toThrow();
    expect(f.releases()).toEqual([]);
    expect(f.revocations()).toEqual([
      { name: 'revoked', payload: { run: f.run, admissionRevision: 1 } },
    ]);

    currentSource.abort();
    expect(f.revocations()).toEqual([
      { name: 'revoked', payload: { run: f.run, admissionRevision: 1 } },
      { name: 'revoked', payload: { run: f.run, admissionRevision: 2 } },
    ]);
    expect(() => f.effects[1]()).toThrow();
  });

  it.each([false, true])(
    'uses the exact native terminal after generation disposal to discard pages: %s',
    async aborted => {
      const f = createBoundary();
      const source = new AbortController();
      f.prepare('armed', source.signal);
      await f.tool.execute('armed', { action: 'dialog', accept: true, headless: true });
      source.abort();
      expect(f.releases()).toEqual([]);

      f.settle(aborted);

      expect(f.releases()).toEqual([
        { name: 'released', payload: { run: f.run, reason: 'settled', discardPages: aborted } },
      ]);
      expect(f.options.releaseScope).toHaveBeenLastCalledWith('conversation', aborted);
      expect(() => f.effects[0]()).toThrow();
      f.service.stop();
      expect(f.releases()).toHaveLength(1);
    },
  );

  it('does not let an old native source or retired service revoke a replacement registry', async () => {
    const first = createBoundary();
    const oldSource = new AbortController();
    first.prepare('old', oldSource.signal);
    await first.tool.execute('old', { action: 'dialog', accept: true, headless: true });
    const second = createBoundary();
    second.prepare('current');
    await second.tool.execute('current', { action: 'dialog', accept: true, headless: true });
    first.service.stop();

    oldSource.abort();

    expect(second.releases()).toEqual([]);
    expect(second.options.execute.mock.calls[0][2].aborted).toBe(false);
    expect(() => second.effects[0]()).not.toThrow();
  });
});
