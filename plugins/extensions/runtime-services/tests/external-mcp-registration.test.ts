import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';

import {
  EXTERNAL_MCP_CLOSE_METHOD,
  EXTERNAL_MCP_OPEN_METHOD,
  EXTERNAL_MCP_TOOL_NAME,
} from '../contracts/external-mcp';
import { registerExternalMcp } from '../external-mcp';

const sdk = vi.hoisted(() => ({ session: vi.fn(), connect: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: sdk.session }));
vi.mock('../external-mcp/transport', () => ({ connectExternalMcpServer: sdk.connect }));

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map(stop => stop()));
  vi.useRealTimers();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

interface GatewayMethodOptions {
  scope: string;
  profileAccess?: 'required' | 'independent';
  sessionAccess?: { mode: 'write' };
}

interface NativeMethodRegistry {
  getScope: (name: string) => string | undefined;
  getSessionAccess: (name: string) => unknown;
  requiresAuthenticatedProfile: (name: string) => boolean;
}

type NativeRegistryFactory = (descriptors: Array<Record<string, unknown>>) => NativeMethodRegistry;
const nativeRuntime = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? process.env.JUSTDO_EXECUTION_PRISTINE_DIR ??
    path.resolve(__dirname, '../../../../vendor/openclaw-runtime/current'),
);

function loadNativeRegistry(): NativeRegistryFactory {
  const metadata = JSON.parse(fs.readFileSync(path.join(nativeRuntime, 'package.json'), 'utf8'));
  expect(metadata.version).toBe('2026.10.6');
  const dist = path.join(nativeRuntime, 'dist');
  const registries = fs.readdirSync(dist).filter(
    name =>
      /^registry-.*\.mjs$/.test(name) &&
      fs.readFileSync(path.join(dist, name), 'utf8').includes('function createGatewayMethodRegistry('),
  );
  expect(registries, 'locked runtime must expose exactly one native gateway method registry').toHaveLength(1);
  // Bundle the real pure registry and its policy dependencies; never load Gateway bootstrap.
  const bundled = buildSync({
    entryPoints: [path.join(dist, registries[0])],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports });
  const createRegistry = Object.values(module.exports).find(
    value => typeof value === 'function' && value.name === 'createGatewayMethodRegistry',
  );
  expect(createRegistry, 'native registry export must retain the supported function shape').toBeTypeOf('function');
  return createRegistry as NativeRegistryFactory;
}

function fixture() {
  sdk.session.mockReset();
  sdk.connect.mockReset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-mcp-registration-'));
  roots.push(root);
  const methods = new Map<string, { handler: (input: any) => Promise<void>; options: GatewayMethodOptions }>();
  let factory: any;
  let policy: any;
  let cleanup: any;
  const close = vi.fn(async () => {});
  const invoke = vi.fn(async () => ({ content: [{ type: 'text', text: 'result' }] }));
  const connection = {
    tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    invoke,
    close,
  };
  sdk.connect.mockResolvedValue(connection);
  sdk.session.mockReturnValue({
    sessionId: 'native',
    lifecycleRevision: 'one',
    sessionRoot: root,
    permissionMode: 'workspace',
  });
  const api = {
    runtime: { state: { resolveStateDir: () => root }, config: { current: () => ({}) } },
    registerGatewayMethod(name: string, handler: (input: any) => Promise<void>, options: GatewayMethodOptions) {
      methods.set(name, { handler, options });
    },
    registerService(service: { stop: () => Promise<void> }) {
      stops.push(service.stop);
    },
    lifecycle: {
      registerRuntimeLifecycle(value: unknown) {
        cleanup = value;
      },
    },
    registerTrustedToolPolicy(value: unknown) {
      policy = value;
    },
    registerTool(value: unknown) {
      factory = value;
    },
  };
  registerExternalMcp(api as never);
  const request = {
    leaseId: 'lease',
    sessionKey: 'agent:main:external',
    sessionId: 'native',
    cwd: root,
    servers: [{ name: 'fixture', command: 'fixture', args: [], env: [] }],
  };
  // The desktop's token-authenticated backend has an effective admin grant but no user profile.
  const client = {
    connect: { role: 'operator', scopes: ['operator.admin', 'operator.write'] },
    connectionSignal: new AbortController().signal,
  };
  const call = async (method: string, params: unknown, authority = true, caller: unknown = client) => {
    const respond = vi.fn();
    await methods
      .get(method)!
      .handler({ params, respond, client: caller, hasCurrentClientAuthority: () => authority });
    return respond;
  };
  const context = {
    sessionKey: request.sessionKey,
    sessionId: 'native',
    runId: 'run',
    toolCallId: 'call',
    assertInvocationCurrent: vi.fn(),
  };
  return {
    api,
    methods,
    get factory() {
      return factory;
    },
    get policy() {
      return policy;
    },
    get cleanup() {
      return cleanup;
    },
    call,
    client,
    connection,
    request,
    context,
    close,
    invoke,
  };
}

it('publishes tools through a separate factory instance only after authenticated preparation', async () => {
  const f = fixture();
  expect(f.factory.create(f.context)).toBeNull();
  expect(f.methods.get(EXTERNAL_MCP_OPEN_METHOD)!.options).toEqual({
    scope: 'operator.write',
    profileAccess: 'required',
    sessionAccess: { mode: 'write' },
  });
  expect(f.methods.get(EXTERNAL_MCP_CLOSE_METHOD)!.options).toEqual({ scope: 'operator.admin' });
  expect((await f.call(EXTERNAL_MCP_OPEN_METHOD, f.request, false)).mock.calls[0][0]).toBe(false);
  expect(sdk.connect).not.toHaveBeenCalled();
  expect((await f.call(EXTERNAL_MCP_OPEN_METHOD, f.request)).mock.calls[0]).toMatchObject([
    true,
    { ok: true, serverCount: 1, toolCount: 1 },
  ]);
  registerExternalMcp(f.api as never);
  const tool = f.factory.create(f.context);
  expect(tool.name).toBe(EXTERNAL_MCP_TOOL_NAME);
  const input = { action: 'call', server: 'fixture', tool: 'echo', arguments: {} };
  await expect(tool.execute('call', input)).rejects.toThrow('approval');
  const decision = f.policy.evaluate(
    { toolName: EXTERNAL_MCP_TOOL_NAME, params: input },
    f.context,
  );
  expect(decision.requireApproval.allowedDecisions).toEqual(['allow-once', 'deny']);
  decision.requireApproval.onResolution('allow-once');
  await tool.execute('call', input);
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect((await f.call(EXTERNAL_MCP_CLOSE_METHOD, f.request)).mock.calls[0]).toEqual([
    true,
    { ok: true },
  ]);
  expect(f.close).toHaveBeenCalled();
  expect(f.factory.create(f.context)).toBeNull();
});

it.each(['write-only', 'missing client', 'missing scopes'])(
  'rejects %s callers before starting any MCP server',
  async kind => {
    const f = fixture();
    const client =
      kind === 'missing client'
        ? null
        : {
            ...f.client,
            connect: {
              role: 'operator',
              ...(kind === 'write-only' ? { scopes: ['operator.write'] } : {}),
            },
          };
    const response = await f.call(EXTERNAL_MCP_OPEN_METHOD, f.request, true, client);
    expect(response.mock.calls[0][0]).toBe(false);
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(f.factory.create(f.context)).toBeNull();
  },
);

it('stops preparing servers and cleans up the first connection when admin is revoked between launches', async () => {
  const f = fixture();
  f.request.servers.push({ name: 'second', command: 'fixture', args: [], env: [] });
  sdk.connect.mockImplementationOnce(async () => {
    f.client.connect.scopes = ['operator.write'];
    return f.connection;
  });

  const response = await f.call(EXTERNAL_MCP_OPEN_METHOD, f.request);

  expect(response.mock.calls[0][0]).toBe(false);
  expect(sdk.connect).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.factory.create(f.context)).toBeNull();
});

it('revokes ready tools and cleans up processes after their owner loses admin', async () => {
  vi.useFakeTimers();
  const f = fixture();
  expect((await f.call(EXTERNAL_MCP_OPEN_METHOD, f.request)).mock.calls[0][0]).toBe(true);
  const tool = f.factory.create(f.context);
  const input = { action: 'call', server: 'fixture', tool: 'echo', arguments: {} };
  const approval = f.policy.evaluate({ toolName: EXTERNAL_MCP_TOOL_NAME, params: input }, f.context);
  approval.requireApproval.onResolution('allow-once');

  f.client.connect.scopes = ['operator.write'];
  await vi.advanceTimersByTimeAsync(1000);

  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.factory.create(f.context)).toBeNull();
  await expect(tool.execute('call', input)).rejects.toThrow('unavailable');
  expect(f.invoke).not.toHaveBeenCalled();
});

it('cleans up the exact lease after its native session has disappeared', async () => {
  const f = fixture();
  await f.call(EXTERNAL_MCP_OPEN_METHOD, f.request);
  const tool = f.factory.create(f.context);
  sdk.session.mockReturnValue(undefined);
  sdk.session.mockClear();

  const response = await f.call(EXTERNAL_MCP_CLOSE_METHOD, f.request);

  expect(response.mock.calls[0]).toEqual([true, { ok: true }]);
  expect(sdk.session).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1);
  await expect(tool.execute('call', { action: 'list' })).rejects.toThrow('unavailable');
});

it.skipIf(!fs.existsSync(nativeRuntime))(
  'passes the actual locked native gateway registry without weakening admin cleanup or profile access',
  () => {
    const f = fixture();
    const createRegistry = loadNativeRegistry();
    const descriptors = [...f.methods].map(([name, method]) => ({
      name,
      handler: method.handler,
      owner: { kind: 'plugin', pluginId: 'runtime-services' },
      ...method.options,
    }));
    const registry = createRegistry(descriptors);
    expect(registry.getScope(EXTERNAL_MCP_OPEN_METHOD)).toBe('operator.write');
    expect(registry.requiresAuthenticatedProfile(EXTERNAL_MCP_OPEN_METHOD)).toBe(true);
    expect(registry.getSessionAccess(EXTERNAL_MCP_OPEN_METHOD)).toEqual({ mode: 'write' });
    expect(registry.getScope(EXTERNAL_MCP_CLOSE_METHOD)).toBe('operator.admin');
    expect(registry.getSessionAccess(EXTERNAL_MCP_CLOSE_METHOD)).toBeUndefined();
    const open = descriptors.find(descriptor => descriptor.name === EXTERNAL_MCP_OPEN_METHOD)!;
    expect(() => createRegistry([{ ...open, scope: 'operator.admin' }])).toThrow('operator.write');
    expect(() => createRegistry([{ ...open, profileAccess: 'independent' }])).toThrow('authenticated profile');
  },
);

it('native lifecycle cleanup revokes retained tool objects and their processes', async () => {
  const f = fixture();
  await f.call(EXTERNAL_MCP_OPEN_METHOD, f.request);
  const tool = f.factory.create(f.context);
  await f.cleanup.cleanup({ reason: 'reset', sessionKey: f.request.sessionKey });
  expect(f.close).toHaveBeenCalledTimes(1);
  await expect(tool.execute('call', { action: 'list' })).rejects.toThrow('unavailable');
});
