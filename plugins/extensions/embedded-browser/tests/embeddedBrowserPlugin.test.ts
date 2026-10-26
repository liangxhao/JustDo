import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserExecutionRun } from '../browserExecutionContract';
import { BrowserToolSchema } from '../browserToolContract';
import plugin from '../index';

const sdk = vi.hoisted(() => ({ session: vi.fn(), saveMedia: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: sdk.session }));
vi.mock('openclaw/plugin-sdk/media-store', () => ({ saveMediaBuffer: sdk.saveMedia }));

let sequence = 0;
const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach(stop => stop());
  vi.restoreAllMocks();
});

function fixture(
  trigger: 'user' | 'cron' = 'user',
  start = true,
  nativeContext: Record<string, unknown> = {},
) {
  const run: BrowserExecutionRun = {
    sessionKey:
      trigger === 'user'
        ? 'agent:main:justdo:product-session'
        : 'agent:main:cron:job:run:native-session',
    sessionId: 'native-session',
    runId: `native-run-${++sequence}`,
    trigger,
    workspaceDir: 'E:\\workspace\\task',
    ...(trigger === 'cron' ? { jobId: 'job' } : {}),
  };
  sdk.session.mockReturnValue({ sessionId: run.sessionId, lifecycleRevision: 'one' });
  sdk.saveMedia.mockResolvedValue({ path: 'E:\\media\\outbound.png' });
  const hooks = new Map<string, { handler: (...args: any[]) => any; options: any }>();
  const methods = new Map<string, (...args: any[]) => any>();
  let service: any;
  let factory: any;
  let lifecycle: (...args: any[]) => any;
  const unsubscribe = vi.fn();
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    logger,
    registerService(value: any) {
      service = value;
    },
    registerTool(value: any) {
      factory = value;
    },
    registerGatewayMethod(name: string, handler: (...args: any[]) => any) {
      methods.set(name, handler);
    },
    on(name: string, handler: (...args: any[]) => any, options: any) {
      hooks.set(name, { handler, options });
    },
    runtime: {
      events: {
        onAgentEvent(handler: (...args: any[]) => any) {
          lifecycle = handler;
          return unsubscribe;
        },
      },
    },
  };
  plugin.register(api as any);
  let autoResponse = true;
  let response: any = { ok: true, targetId: 'target', url: 'https://example.test/' };
  const respond = vi.fn();
  const emit = vi.fn((name: string, event: any) => {
    if (name === 'requested' && autoResponse) {
      methods.get('embeddedBrowser.resolve')!({
        params: { requestId: event.requestId, ok: true, result: response },
        respond,
      });
    }
  });
  if (start) service.start({ gatewayEvents: { emit } });
  stops.push(() => service.stop());
  const assertInvocationCurrent = vi.fn();
  const tool = factory.create({ ...run, ...nativeContext, assertInvocationCurrent });
  const toolContext = { ...run, toolCallId: 'call', toolName: 'browser', abortSignal: undefined };
  const prompt = () =>
    hooks.get('before_prompt_build')!.handler(
      {},
      {
        ...run,
        toolAuthority: { allows: (name: string) => name === 'browser', assertActive() {} },
      },
    );
  const prepare = (id = 'call', abortSignal?: AbortSignal) => {
    toolContext.toolCallId = id;
    return hooks
      .get('before_tool_call')!
      .handler(
        { toolName: 'browser', runId: run.runId, toolCallId: id },
        { ...toolContext, abortSignal },
      );
  };
  return {
    run,
    hooks,
    tool,
    factory,
    service,
    emit,
    unsubscribe,
    assertInvocationCurrent,
    prompt,
    prepare,
    lifecycle: (event: any) => lifecycle!(event),
    autoRespond: (value: boolean) => {
      autoResponse = value;
    },
    setResponse: (value: any) => {
      response = value;
    },
    requested: () =>
      emit.mock.calls.filter(([name]) => name === 'requested').map(([, event]) => event),
  };
}

describe('embedded browser trusted execution integration', () => {
  it('keeps one browser tool and foreground schema default, with post-policy and v2 guards', async () => {
    const f = fixture();
    expect(f.factory.contextVersion).toBe(2);
    expect(f.tool.name).toBe('browser');
    expect(BrowserToolSchema.properties.headless.default).toBe(false);
    expect(f.hooks.get('before_prompt_build')!.options).toEqual({ requiresToolAuthority: true });
    expect(f.hooks.get('before_tool_call')!.options).toEqual({ matcher: ['browser'] });
    expect((await f.tool.execute('call', { action: 'open' })).isError).toBe(true);
    expect(f.requested()).toEqual([]);
    f.prompt();
    expect(f.prepare()).toBeUndefined();
    expect(
      (await f.tool.execute('call', { action: 'open', url: 'https://example.test/' })).isError,
    ).toBeUndefined();
    expect(f.requested()[0]).toMatchObject({
      run: f.run,
      sessionKey: f.run.sessionKey,
      toolCallId: 'call',
      command: { action: 'open' },
    });
    expect(f.requested()[0].command.headless).toBeUndefined();
  });

  it('preserves explicit ordinary background mode and strips forged execution identity', async () => {
    const f = fixture();
    f.prompt();
    f.prepare();
    await f.tool.execute('call', {
      action: 'open',
      headless: true,
      run: { runId: 'forged' },
      sessionKey: 'foreign',
      workspaceDir: 'foreign',
    });
    expect(f.requested()[0].run).toEqual(f.run);
    expect(f.requested()[0].command).toEqual({ action: 'open', headless: true });
  });

  it('forces cron background mode and rejects explicit foreground without issuing a request', async () => {
    const f = fixture('cron');
    f.prompt();
    f.prepare('automatic');
    await f.tool.execute('automatic', { action: 'open' });
    expect(f.requested()[0].command).toEqual({ action: 'open', headless: true });
    f.prepare('foreground');
    const result = await f.tool.execute('foreground', { action: 'open', headless: false });
    expect(result.isError).toBe(true);
    expect(f.requested()).toHaveLength(1);
  });

  it('rejects mismatched event identity and a retained native invocation', async () => {
    const f = fixture();
    f.prompt();
    expect(
      f.hooks
        .get('before_tool_call')!
        .handler({ toolName: 'browser', runId: 'foreign' }, { ...f.run, toolCallId: 'call' }),
    ).toMatchObject({ block: true });
    f.prepare();
    f.assertInvocationCurrent.mockImplementation(() => {
      throw new Error('retired');
    });
    expect((await f.tool.execute('call', { action: 'open' })).isError).toBe(true);
    expect(f.requested()).toEqual([]);
  });

  it('cancels with exact native identity and ignores late responses', async () => {
    const f = fixture('cron');
    f.autoRespond(false);
    f.prompt();
    const controller = new AbortController();
    f.prepare('call', controller.signal);
    const result = f.tool.execute('call', { action: 'open' });
    controller.abort();
    expect((await result).isError).toBe(true);
    expect(f.emit.mock.calls.find(([name]) => name === 'cancelled')?.[1]).toMatchObject({
      run: f.run,
      toolCallId: 'call',
    });
    expect(f.emit).toHaveBeenCalledWith('revoked', { run: f.run }, { scope: 'operator.read' });
    expect(f.emit.mock.calls.filter(([name]) => name === 'released')).toEqual([]);
  });

  it('releases only a current exact settled native lifecycle and revokes on owner stop', async () => {
    const f = fixture('cron');
    f.prompt();
    const terminal = {
      ...f.run,
      stream: 'lifecycle',
      data: { phase: 'end', executionSettled: true },
    };
    f.lifecycle({ ...terminal, data: { phase: 'end' } });
    f.lifecycle({ ...terminal, runId: 'another-run' });
    expect(f.emit.mock.calls.filter(([name]) => name === 'released')).toEqual([]);
    f.lifecycle(terminal);
    expect(f.emit).toHaveBeenCalledWith(
      'released',
      { run: f.run, reason: 'settled', discardPages: false },
      { scope: 'operator.read' },
    );
    expect(f.prepare()).toMatchObject({ block: true });
    f.service.stop();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledWith('stopped', {}, { scope: 'operator.read' });
  });

  it.each([
    { browser: { allowHostControl: false } },
    { sandboxed: true },
    { browser: { sandboxBridgeUrl: 'http://sandbox.invalid' } },
    { fsPolicy: { workspaceOnly: true, root: 'E:\\different-root' } },
  ])('does not widen native host or filesystem constraints %j', async nativeContext => {
    const f = fixture('user', true, nativeContext);
    f.prompt();
    f.prepare();
    await expect(
      f.tool.execute('call', { action: 'open', url: 'https://example.test', headless: true }),
    ).resolves.toMatchObject({ isError: true });
    expect(f.emit.mock.calls.filter(([name]) => name === 'requested')).toEqual([]);
  });

  it('projects the trusted workspace-only policy and strips a model-supplied policy override', async () => {
    const f = fixture('user', true, {
      fsPolicy: { workspaceOnly: true, root: 'E:\\workspace\\task' },
    });
    f.prompt();
    f.prepare();
    await expect(
      f.tool.execute('call', { action: 'snapshot', policy: { allowLocalFiles: true } }),
    ).resolves.not.toHaveProperty('isError', true);
    expect(f.emit).toHaveBeenCalledWith(
      'requested',
      expect.objectContaining({
        policy: { allowLocalFiles: false },
        command: { action: 'snapshot' },
      }),
      { scope: 'operator.read' },
    );
  });

  it('keeps screenshots visible to the model and preserves explicit outbound sharing and untrusted metadata', async () => {
    const f = fixture();
    f.prompt();
    f.prepare();
    const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
    f.setResponse({
      content: [image],
      details: { ok: true, targetId: 'target', url: 'https://example.test/' },
      media: { outbound: false },
    });
    const result = await f.tool.execute('call', { action: 'screenshot' });
    expect(result.content).toContainEqual(image);
    expect(result.media).toEqual({ outbound: false });
    expect(result.details.externalContent).toMatchObject({ untrusted: true, source: 'browser' });
    expect(sdk.saveMedia).toHaveBeenCalled();
    expect(
      result.content.some(
        (block: any) => block.type === 'text' && block.text.includes('sanitized outbound copy'),
      ),
    ).toBe(true);
  });

  it('connects a prepared registry tool to the separate live Gateway service', async () => {
    const serviceRegistry = fixture();
    const toolRegistry = fixture('cron', false);
    toolRegistry.prompt();
    toolRegistry.prepare();
    const result = await toolRegistry.tool.execute('call', { action: 'status' });
    expect(result.isError).toBeUndefined();
    expect(toolRegistry.emit).not.toHaveBeenCalled();
    expect(serviceRegistry.requested()[0]).toMatchObject({ run: toolRegistry.run });
    toolRegistry.service.stop();
    expect(serviceRegistry.unsubscribe).not.toHaveBeenCalled();
    expect(serviceRegistry.emit.mock.calls.filter(([name]) => name === 'stopped')).toEqual([]);
    serviceRegistry.service.stop();
    expect(serviceRegistry.emit).toHaveBeenCalledWith(
      'released',
      { run: toolRegistry.run, reason: 'revoked', discardPages: true },
      { scope: 'operator.read' },
    );
  });

  it('separates native successful tool cleanup from the exact settled run release', async () => {
    const f = fixture();
    f.prompt();
    const source = new AbortController();
    f.prepare('armed', source.signal);
    await f.tool.execute('armed', { action: 'dialog', accept: true });
    f.hooks.get('after_tool_call')!.handler({}, { ...f.run, toolCallId: 'armed' });

    source.abort();

    expect(f.emit).toHaveBeenCalledWith('revoked', { run: f.run }, { scope: 'operator.read' });
    expect(f.emit.mock.calls.filter(([name]) => name === 'released')).toEqual([]);
    f.prompt();
    expect(f.prepare('later')).toMatchObject({ block: true });
    f.lifecycle({ ...f.run, stream: 'lifecycle', data: { phase: 'end' } });
    expect(f.emit.mock.calls.filter(([name]) => name === 'released')).toEqual([]);

    f.lifecycle({
      ...f.run,
      stream: 'lifecycle',
      data: { phase: 'end', executionSettled: true, aborted: false },
    });

    expect(f.emit).toHaveBeenLastCalledWith(
      'released',
      { run: f.run, reason: 'settled', discardPages: false },
      { scope: 'operator.read' },
    );
  });
});
