import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/041-mcp-app-view-keepalive.cjs');
const { transform, TARGET, CONTRACT } = patch.__testing;
const native = fs.readFileSync(path.join(__dirname, 'mcp-app-view-keepalive.fixture.js'), 'utf8').replace(/\r\n/g, '\n');
const roots: string[] = [];
const minutes = (value: number) => value * 60_000;

class McpAppViewExpiredError extends Error {
  constructor() { super('MCP App view expired or is not authorized for this session'); }
}
class McpAppRequestError extends Error {}
type Lease = {
  viewId: string; expiresAtMs: number; readOnly?: true; allowedAppToolNames: Set<string>;
  expiryTimer: ReturnType<typeof setTimeout>;
};
type Response = { ok: boolean; payload?: Record<string, unknown>; error?: { details?: { code: string }; message: string } };

async function setup(options: { pristine?: boolean; readOnly?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  let ownerCurrent = true;
  let grantCurrent = true;
  let scopeCurrent = true;
  let transportCurrent = true;
  let beforeGrant: (() => Promise<void> | void) | undefined;
  const store = new Map();
  const restore = vi.fn(async () => undefined);
  const releaseRuntime = vi.fn();
  const subscription = vi.fn(() => vi.fn());
  const read = { assertCurrent: () => { if (!scopeCurrent) throw new Error('Session read changed'); }, release: vi.fn() };
  const client = { profile: 'person', connId: 'connection', connectionSignal: new AbortController().signal };
  const runtime = {
    sessionKey: 'agent:primary:app', sessionId: 'physical-session', mcpAppsEnabled: true,
    assertOwnerCurrent: () => { if (!ownerCurrent) throw new Error('Runtime owner changed'); },
    acquireLease: () => releaseRuntime,
    markUsed: vi.fn(),
    readResource: vi.fn(async () => ({ contents: [{ mimeType: 'text/html;profile=mcp-app', text: '<p>App</p>' }] })),
    callTool: vi.fn(),
  };
  const authority = { assertCurrent: () => {
    if (!transportCurrent || client.connectionSignal.aborted) throw new Error('Requester authority changed');
  } };
  const bindings = {
    Error, McpAppViewExpiredError, McpAppRequestError, Map, Set, Symbol, Buffer, Date,
    setTimeout, clearTimeout,
    randomUUID: () => 'test-view',
    resolveGlobalMap: () => store,
    clearMcpAppModelContextForView: vi.fn(), notifyListeners: (listeners: Set<() => void>) => { for (const listener of listeners) listener(); },
    completeDeferredSessionMcpRuntimeRetirement: async () => {},
    logWarn: vi.fn(), formatErrorMessage: (error: unknown) => String(error),
    asOptionalRecord: (value: unknown) => value && typeof value === 'object' ? value : undefined,
    normalizeAgentId: (value: string) => value,
    parseAgentSessionKey: (value: string) => value.startsWith('agent:primary:') ? { agentId: 'primary' } : undefined,
    normalizeMcpAppCsp: () => undefined,
    getSessionMcpRequestSignal: () => undefined,
    peekSessionMcpRuntime: ({ sessionKey }: { sessionKey: string }) => sessionKey === runtime.sessionKey ? runtime : undefined,
    restoreMcpAppView: restore,
    resolveMcpAppRequesterId: (current: typeof client) => current.profile,
    resolveRequestedSessionAgentId: (_cfg: unknown, key: string, agent: string) => ({ ok: key.startsWith(`agent:${agent}:`), agentId: agent }),
    retainSessionScopedRead: () => read,
    readGatewayRequestMutationAuthority: () => authority,
    modelContextSubscriptions: new WeakMap(),
    getMcpAppModelContext: () => null,
    subscribeMcpAppModelContext: subscription,
    canOpenMcpAppFiles: async () => false,
    createMcpAppStandaloneTicket: () => undefined,
    authorizeOperatorScopesForMethod: () => ({ allowed: true }),
    buildMcpAppSandboxPath: () => '/sandbox',
    errorShape: (_code: string, message: string, extra?: object) => ({ message, ...extra }),
    ErrorCodes: { UNAVAILABLE: 'UNAVAILABLE' },
    GatewayErrorDetailCodes: { MCP_APP_VIEW_EXPIRED: 'MCP_APP_VIEW_EXPIRED' },
  };
  const api = vm.runInNewContext(`${options.pristine ? native : transform(native)}\n({ fetchMcpAppView, getMcpAppViewLeaseForSession, mcpAppHandlers, requireMcpAppInteraction })`, bindings);
  const created = await api.fetchMcpAppView({
    runtime, agentId: 'primary', serverName: 'example', toolName: 'open_example',
    uiResourceUri: 'ui://example/app.html', toolInput: {}, toolResult: { content: [] },
    allowedAppToolNames: new Set(options.readOnly ? [] : ['save']), requesterId: 'person',
    ...(options.readOnly ? { readOnly: true } : {}),
    authorizeAppInteraction: async () => { await beforeGrant?.(); return grantCurrent; },
  });
  if (!created) throw new Error(JSON.stringify(bindings.logWarn.mock.calls));
  const lookup = () => api.getMcpAppViewLeaseForSession(created.viewId, runtime.sessionKey, 'primary') as Lease | undefined;
  const lease = lookup()!;
  async function request(params: Record<string, unknown> = {}, requester = client): Promise<Response> {
    let response: Response | undefined;
    await api.mcpAppHandlers['mcp.app.view']({
      params: { sessionKey: runtime.sessionKey, agentId: 'primary', viewId: lease.viewId, keepAlive: true, ...params },
      client: requester,
      context: { getRuntimeConfig: () => ({ mcp: { apps: { enabled: true } } }), getMcpAppSandboxPort: () => 1234 },
      respond: (ok: boolean, payload: Response['payload'], error: Response['error']) => { response = { ok, payload, error }; },
    });
    return response!;
  }
  return {
    api, lease, lookup, request, restore, runtime, releaseRuntime, subscription, read,
    deny: (kind: string) => {
      if (kind === 'owner') ownerCurrent = false;
      if (kind === 'grant') grantCurrent = false;
      if (kind === 'scope') scopeCurrent = false;
      if (kind === 'transport') transportCurrent = false;
    },
    duringGrant: (callback: typeof beforeGrant) => { beforeGrant = callback; },
    replace: () => store.set(lease.viewId, { ...lease }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('mcp-app-keepalive-')) throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses verbatim handler and lease owners extracted from the locked published package', () => {
  expect(createHash('sha256').update(native).digest('hex'))
    .toBe('b69da46912ee2c88efa4ccd85fdc04c1961e98ddf90e7382a3471a2f50bc3f4f');
});

test('reproduces fixed expiry and retains the exact native view through light reads beyond ten minutes', async () => {
  const stock = await setup({ pristine: true });
  await vi.advanceTimersByTimeAsync(minutes(11));
  expect((await stock.request()).error?.details?.code).toBe('MCP_APP_VIEW_EXPIRED');
  const app = await setup();
  const grants = app.lease.allowedAppToolNames;
  const expiry = app.lease.expiryTimer;
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(minutes(9));
    const response = await app.request();
    expect(response).toMatchObject({ ok: true, payload: { viewId: app.lease.viewId, expiresAtMs: Date.now() + minutes(10) } });
    expect(Object.keys(response.payload!).sort()).toEqual(['expiresAtMs', 'viewId']);
    expect(app.lookup()).toBe(app.lease);
    expect(app.lease.expiryTimer).toBe(expiry);
    expect(app.lease.allowedAppToolNames).toBe(grants);
  }
  expect(app.runtime.callTool).not.toHaveBeenCalled();
  expect(app.runtime.readResource).toHaveBeenCalledTimes(1);
  expect(app.subscription).not.toHaveBeenCalled();
  expect(app.restore).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(minutes(10));
  expect(app.lookup()).toBeUndefined();
  expect((await app.request()).error?.details?.code).toBe('MCP_APP_VIEW_EXPIRED');
  expect(app.restore).not.toHaveBeenCalled();
  expect(app.releaseRuntime).toHaveBeenCalled();
});

test('retains a read-only view without granting any interactive capability', async () => {
  const app = await setup({ readOnly: true });
  await vi.advanceTimersByTimeAsync(minutes(9));
  expect((await app.request()).ok).toBe(true);
  expect(app.lease.readOnly).toBe(true);
  expect(app.lease.allowedAppToolNames.size).toBe(0);
  await expect(app.api.requireMcpAppInteraction(app.lease)).rejects.toThrow('read-only');
});

test.each(['owner', 'grant', 'scope', 'transport'])('refuses renewal when %s authority changes', async kind => {
  const app = await setup();
  const deadline = app.lease.expiresAtMs;
  await vi.advanceTimersByTimeAsync(minutes(9));
  app.deny(kind);
  expect((await app.request()).ok).toBe(false);
  expect(app.lease.expiresAtMs).toBe(deadline);
  await vi.advanceTimersByTimeAsync(minutes(1));
  expect(app.lookup()).toBeUndefined();
});

test('refuses a different requester or native session and never attempts history restoration', async () => {
  const app = await setup();
  const deadline = app.lease.expiresAtMs;
  expect((await app.request({}, { profile: 'other' } as never)).ok).toBe(false);
  expect((await app.request({ sessionKey: 'agent:primary:other' })).ok).toBe(false);
  expect(app.lease.expiresAtMs).toBe(deadline);
  expect(app.restore).not.toHaveBeenCalled();
});

test.each(['owner', 'scope', 'transport', 'replacement', 'expiry'])('rechecks %s after asynchronous interaction authorization', async kind => {
  const app = await setup();
  const deadline = app.lease.expiresAtMs;
  app.duringGrant(async () => {
    if (kind === 'expiry') await vi.advanceTimersByTimeAsync(minutes(11));
    else if (kind === 'replacement') app.replace();
    else app.deny(kind);
  });
  expect((await app.request()).ok).toBe(false);
  expect(app.lease.expiresAtMs).toBe(deadline);
  expect(app.restore).not.toHaveBeenCalled();
});

test('preserves ordinary view loading and its original expiry', async () => {
  const app = await setup();
  const deadline = app.lease.expiresAtMs;
  await vi.advanceTimersByTimeAsync(minutes(3));
  expect(await app.request({ keepAlive: false })).toMatchObject({ ok: true, payload: { html: '<p>App</p>', messageSupported: true } });
  expect(app.lease.expiresAtMs).toBe(deadline);
  expect(app.subscription).toHaveBeenCalledTimes(1);
});

test('validates current idempotency, bundled output and both target files before writing', () => {
  const current = transform(native);
  expect(transform(current)).toBe(current);
  expect(() => transform(current.replace('readOnly !== true', 'readOnly === true'))).toThrow();
  expect(() => transform(native.replace('read?.assertCurrent();', ''))).toThrow('owner changed');
  const bundled = transformSync(native, { format: 'esm', minifySyntax: true }).code;
  expect(transform(transform(bundled, 'gateway-bundle.mjs'), 'gateway-bundle.mjs')).toContain(CONTRACT);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-app-keepalive-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, TARGET), native);
  fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), bundled.replace('read?.assertCurrent();', ''));
  expect(() => patch.applyPatch(root)).toThrow();
  expect(fs.readFileSync(path.join(root, TARGET), 'utf8')).toBe(native);
  fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), bundled);
  expect(() => patch.verifyPatch(root)).toThrow('missing');
  expect(patch.applyPatch(root).sort()).toEqual([TARGET.replaceAll('/', path.sep), 'gateway-bundle.mjs'].sort());
  expect(patch.verifyPatch(root)).toEqual([]);
  fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), bundled);
  expect(() => patch.applyPatch(root)).toThrow('Mixed source/bundle');
});
