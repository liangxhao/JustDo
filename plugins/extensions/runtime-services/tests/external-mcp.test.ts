import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalMcpOpenRequest } from '../contracts/external-mcp';
import { ExternalMcpRegistry, type NativeEntry } from '../external-mcp/registry';
import type { ExternalMcpConnection } from '../external-mcp/transport';
import { parseOpenRequest } from '../external-mcp/validation';

const directories: string[] = [];
const registries: ExternalMcpRegistry[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(registries.splice(0).map(registry => registry.closeSession()));
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-mcp-'));
  directories.push(directory);
  const cwd = fs.realpathSync(directory);
  const entries = new Map<string, NativeEntry>();
  const handles: ExternalMcpConnection[] = [];
  const connect = vi.fn(async server => {
    const handle: ExternalMcpConnection = {
      tools: [
        {
          name: 'echo',
          description: 'Fixture tool',
          inputSchema: {
            type: 'object',
            properties: { value: { $ref: '#/$defs/value' } },
            $defs: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
      invoke: vi.fn(async (_name, args) => ({
        content: [{ type: 'text', text: `${server.args[0]}:${args.value}` }],
        structuredContent: { server: server.args[0], args },
      })),
      close: vi.fn(async () => {}),
    };
    handles.push(handle);
    return handle;
  });
  const registry = new ExternalMcpRegistry({ getEntry: key => entries.get(key), connect });
  registries.push(registry);
  const request = (suffix = 'one'): ExternalMcpOpenRequest => {
    const sessionKey = `agent:main:external-${suffix}`;
    entries.set(sessionKey, {
      sessionId: `native-${suffix}`,
      sessionRoot: cwd,
      permissionMode: 'workspace',
      lifecycleRevision: `revision-${suffix}`,
    });
    return {
      leaseId: `lease-${suffix}`,
      sessionKey,
      sessionId: `native-${suffix}`,
      cwd,
      servers: [{ name: 'fixture', command: 'fixture.exe', args: [suffix], env: [] }],
    };
  };
  return { registry, entries, connect, request, handles, cwd };
}

const call = { action: 'call', server: 'fixture', tool: 'echo', arguments: { value: 'hello' } };
const contextFor = (request: ExternalMcpOpenRequest, id = 'call-one') => ({
  sessionKey: request.sessionKey,
  sessionId: request.sessionId,
  runId: 'native-run',
  toolCallId: id,
  assertInvocationCurrent: vi.fn(),
});

describe('session-scoped external MCP', () => {
  it.each(['server', 'tool'] as const)(
    'validates independent schemas with a shared $id for each %s',
    async scope => {
      const f = fixture();
      const request = f.request();
      if (scope === 'server') request.servers.push({ ...request.servers[0], name: 'numbers' });
      const schema = (type: 'string' | 'number') => ({
        $id: 'urn:external-mcp:shared-input',
        type: 'object',
        properties: { value: { $ref: '#/$defs/value' } },
        $defs: { value: { type } },
        required: ['value'],
        additionalProperties: false,
      });
      const connect = f.connect.getMockImplementation()!;
      f.connect.mockImplementation(async server => {
        const connection = await connect(server);
        const tool = connection.tools[0];
        connection.tools =
          scope === 'tool'
            ? [
                { ...tool, inputSchema: schema('string') },
                { ...tool, name: 'number', inputSchema: schema('number') },
              ]
            : [{ ...tool, inputSchema: schema(server.name === 'numbers' ? 'number' : 'string') }];
        return connection;
      });
      await f.registry.open(request);
      const context = contextFor(request);
      const target = {
        action: 'call',
        server: scope === 'server' ? 'numbers' : 'fixture',
        tool: scope === 'tool' ? 'number' : 'echo',
      };
      expect(() =>
        f.registry.approval(context, { ...target, arguments: { value: 'wrong type' } }),
      ).toThrow('arguments');
      const input = { ...target, arguments: { value: 42 } };
      f.registry.approval(context, input)!.onResolution('allow-once');
      const result = await f.registry.execute(context, context.toolCallId, input);
      expect(result.details.structuredContent).toMatchObject({ args: { value: 42 } });
    },
  );

  it('keeps catalogs, arguments and results isolated between sessions with identical tool names', async () => {
    const f = fixture();
    const one = f.request('one');
    const two = f.request('two');
    await f.registry.open(one);
    await f.registry.open(two);
    for (const request of [one, two]) {
      const context = contextFor(request);
      const catalog = await f.registry.execute(context, 'catalog', { action: 'list' });
      expect(catalog.details.tools[0].inputSchema.$defs).toEqual({ value: { type: 'string' } });
      const approval = f.registry.approval(context, call)!;
      approval.onResolution('allow-once');
      const result = await f.registry.execute(context, context.toolCallId, call);
      expect(result.details.structuredContent).toEqual({
        server: request.servers[0].args[0],
        args: { value: 'hello' },
      });
    }
    expect(f.connect).toHaveBeenCalledTimes(2);
  });

  it('requires a one-use approval bound to exact native identity and input', async () => {
    const f = fixture();
    const request = f.request();
    await f.registry.open(request);
    const context = contextFor(request);
    await expect(f.registry.execute(context, context.toolCallId, call)).rejects.toThrow('approval');
    const approval = f.registry.approval(context, call)!;
    approval.onResolution('allow-once');
    await expect(
      f.registry.execute(context, context.toolCallId, {
        ...call,
        arguments: { value: 'changed' },
      }),
    ).rejects.toThrow('approval');
    expect(f.handles[0].invoke).not.toHaveBeenCalled();
    f.registry.approval(context, call)!.onResolution('allow-once');
    await f.registry.execute(context, context.toolCallId, call);
    await expect(f.registry.execute(context, context.toolCallId, call)).rejects.toThrow('approval');
    expect(f.handles[0].invoke).toHaveBeenCalledTimes(1);
  });

  it('does not let an old approval callback authorize another native run reusing the call ID', async () => {
    const f = fixture();
    const request = f.request();
    await f.registry.open(request);
    const oldContext = contextFor(request);
    const currentContext = { ...oldContext, runId: 'replacement-run' };
    const oldApproval = f.registry.approval(oldContext, call)!;
    const currentApproval = f.registry.approval(currentContext, call)!;
    oldApproval.onResolution('allow-once');
    await expect(
      f.registry.execute(currentContext, currentContext.toolCallId, call),
    ).rejects.toThrow('approval');
    currentApproval.onResolution('allow-once');
    // The denied attempt consumed that admission; a late callback cannot restore it.
    await expect(
      f.registry.execute(currentContext, currentContext.toolCallId, call),
    ).rejects.toThrow('approval');
    expect(f.handles[0].invoke).not.toHaveBeenCalled();
  });

  it('disposes ready leases on their owner connection disconnect without another RPC', async () => {
    const f = fixture();
    const request = f.request();
    const owner = new AbortController();
    await f.registry.open(request, undefined, () => {}, owner.signal);
    const context = contextFor(request);
    const approval = f.registry.approval(context, call)!;
    owner.abort();
    approval.onResolution('allow-once');
    expect(f.registry.hasTools(context)).toBe(false);
    await vi.waitFor(() => expect(f.handles[0].close).toHaveBeenCalled());
    await expect(f.registry.execute(context, context.toolCallId, call)).rejects.toThrow();
  });

  it('rechecks ready owner authority and cleans processes after access is revoked', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = f.request();
    let current = true;
    await f.registry.open(request, undefined, () => {
      if (!current) throw new Error('revoked');
    });
    current = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.handles[0].close).toHaveBeenCalled();
    expect(f.registry.hasTools(contextFor(request))).toBe(false);
  });

  it('does not grant on deny, cancellation, missing run identity or mismatched arguments', async () => {
    const f = fixture();
    const request = f.request();
    await f.registry.open(request);
    const context = contextFor(request);
    f.registry.approval(context, call)!.onResolution('deny');
    await expect(f.registry.execute(context, context.toolCallId, call)).rejects.toThrow('approval');
    expect(() => f.registry.approval({ ...context, runId: undefined }, call)).toThrow('identity');
    expect(() => f.registry.approval(context, { ...call, arguments: { value: 5 } })).toThrow(
      'arguments',
    );
    const controller = new AbortController();
    const approval = f.registry.approval({ ...context, abortSignal: controller.signal }, call)!;
    controller.abort();
    approval.onResolution('allow-once');
    await expect(f.registry.execute(context, context.toolCallId, call)).rejects.toThrow('approval');
  });

  it('revokes old tools and approvals after incarnation, policy, root or lifecycle changes', async () => {
    for (const update of [
      { sessionId: 'replacement' },
      { lifecycleRevision: 'new-revision' },
      { permissionMode: 'full' },
      { toolOverrides: { toolsDeny: ['external_mcp'] } },
      { sessionRoot: os.tmpdir() },
    ]) {
      const f = fixture();
      const request = f.request();
      await f.registry.open(request);
      const context = contextFor(request);
      const approval = f.registry.approval(context, call)!;
      Object.assign(f.entries.get(request.sessionKey)!, update);
      approval.onResolution('allow-once');
      expect(f.registry.hasTools(context)).toBe(false);
      await expect(f.registry.execute(context, context.toolCallId, call)).rejects.toThrow();
      expect(f.handles[0].invoke).not.toHaveBeenCalled();
    }
  });

  it('rejects unprepared, read-only and unknown permission modes before launching a process', async () => {
    for (const mode of [undefined, 'read-only', 'unknown']) {
      const f = fixture();
      const request = f.request();
      f.entries.get(request.sessionKey)!.permissionMode = mode;
      await expect(f.registry.open(request)).rejects.toThrow('authority');
      expect(f.connect).not.toHaveBeenCalled();
    }
  });

  it('is idempotent for an exact lease and refuses configuration or ownership replacement', async () => {
    const f = fixture();
    const request = f.request();
    const result = await f.registry.open(request);
    expect(await f.registry.open(request)).toEqual(result);
    expect(f.connect).toHaveBeenCalledTimes(1);
    await expect(f.registry.open({ ...request, servers: [] })).rejects.toThrow('conflicting');
    await expect(f.registry.open({ ...request, leaseId: 'other' })).rejects.toThrow('already');
    await expect(f.registry.close({ ...request, sessionId: 'foreign' })).rejects.toThrow(
      'ownership',
    );
    expect(f.handles[0].close).not.toHaveBeenCalled();
    await f.registry.close(request);
    await f.registry.close(request);
    expect(f.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it('closes prepared servers after a later preparation failure', async () => {
    const f = fixture();
    const request = f.request();
    request.servers.push({ name: 'broken', command: 'broken.exe', args: [], env: [] });
    f.connect
      .mockImplementationOnce(f.connect.getMockImplementation()!)
      .mockRejectedValueOnce(new Error('private token that must not escape'));
    await expect(f.registry.open(request)).rejects.toThrow('could not be prepared');
    expect(f.handles[0].close).toHaveBeenCalledTimes(1);
    expect(f.registry.hasTools(contextFor(request))).toBe(false);
    expect(
      await f.registry.open({ ...request, servers: request.servers.slice(0, 1) }),
    ).toMatchObject({ ok: true });
  });

  it('cleans a late connection when the owner closes during preparation', async () => {
    const f = fixture();
    const request = f.request();
    let complete!: (value: ExternalMcpConnection) => void;
    const late: ExternalMcpConnection = {
      tools: [],
      invoke: vi.fn(),
      close: vi.fn(async () => {}),
    };
    f.connect.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve;
        }),
    );
    const opened = f.registry.open(request);
    const rejected = expect(opened).rejects.toThrow('could not be prepared');
    const closed = f.registry.close(request);
    complete(late);
    await Promise.all([rejected, closed]);
    expect(late.close).toHaveBeenCalled();
    expect(f.registry.hasTools(contextFor(request))).toBe(false);
  });

  it('preserves non-text MCP output without fabricating text or dropping structured data', async () => {
    const f = fixture();
    const request = f.request();
    await f.registry.open(request);
    const output = {
      content: [{ type: 'resource_link', name: 'report', uri: 'file:///report' }],
      structuredContent: { count: 3 },
      isError: true,
    };
    vi.mocked(f.handles[0].invoke).mockResolvedValueOnce(output);
    const context = contextFor(request);
    f.registry.approval(context, call)!.onResolution('allow-once');
    const result = await f.registry.execute(context, context.toolCallId, call);
    expect(result.details).toEqual(output);
    expect(JSON.parse(String(result.content[0].text))).toEqual(output);
    expect(result.isError).toBe(true);
  });

  it('rejects late output from a revoked native invocation', async () => {
    const f = fixture();
    const request = f.request();
    await f.registry.open(request);
    const context = contextFor(request);
    const approval = f.registry.approval(context, call)!;
    approval.onResolution('allow-once');
    vi.mocked(f.handles[0].invoke).mockImplementationOnce(async () => {
      f.entries.get(request.sessionKey)!.lifecycleRevision = 'replacement';
      return { content: [{ type: 'text', text: 'late result' }] };
    });
    await expect(f.registry.execute(context, context.toolCallId, call)).rejects.toThrow('changed');
  });

  it('refuses environment injection and duplicate names before any process launch', () => {
    const f = fixture();
    const request = f.request();
    for (const name of [
      'NODE_OPTIONS',
      'OPENCLAW_GATEWAY_TOKEN',
      'ELECTRON_RUN_AS_NODE',
      'LD_PRELOAD',
    ])
      expect(() =>
        parseOpenRequest({
          ...request,
          servers: [{ ...request.servers[0], env: [{ name, value: 'private' }] }],
        }),
      ).toThrow('environment');
    expect(() =>
      parseOpenRequest({ ...request, servers: [request.servers[0], request.servers[0]] }),
    ).toThrow('server');
  });
});
