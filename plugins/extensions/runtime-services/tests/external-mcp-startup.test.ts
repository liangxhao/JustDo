import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { EXTERNAL_MCP_OPEN_METHOD } from '../contracts/external-mcp';
import { registerExternalMcp } from '../external-mcp';
import { canonicalDirectory } from '../external-mcp/validation';

const sdk = vi.hoisted(() => {
  let release!: () => void;
  return {
    session: vi.fn(),
    connect: vi.fn(),
    loading: vi.fn(),
    ready: new Promise<void>(resolve => { release = resolve; }),
    release: () => release(),
  };
});
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: sdk.session }));
vi.mock('../external-mcp/transport', async () => {
  sdk.loading();
  await sdk.ready;
  return { connectExternalMcpServer: sdk.connect };
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-mcp-startup-'));
  let open!: (input: unknown) => Promise<void>;
  let stop!: () => Promise<void>;
  let cleanup!: (context: { sessionKey: string }) => Promise<void>;
  const close = vi.fn(async () => {});
  const connection = {
    tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    invoke: vi.fn(),
    close,
  };
  const entry = {
    sessionId: 'native', lifecycleRevision: 'one', sessionRoot: root, permissionMode: 'workspace',
  };
  const config = { plugins: { enabled: true } };
  const client = {
    connect: { scopes: ['operator.admin'] }, connectionSignal: new AbortController().signal,
  };
  let authority = true;
  const api = {
    runtime: { state: { resolveStateDir: () => root }, config: { current: () => config } },
    registerGatewayMethod(name: string, handler: typeof open) {
      if (name === EXTERNAL_MCP_OPEN_METHOD) open = handler;
    },
    registerService(service: { stop: typeof stop }) { stop = service.stop; },
    lifecycle: { registerRuntimeLifecycle(value: { cleanup: typeof cleanup }) { cleanup = value.cleanup; } },
    registerTrustedToolPolicy: vi.fn(),
    registerTool: vi.fn(),
  };
  registerExternalMcp(api as never);
  const request = {
    leaseId: 'lease', sessionKey: `agent:main:external-${path.basename(root)}`, sessionId: 'native', cwd: root,
    servers: [{ name: 'fixture', command: 'fixture', args: [], env: [] }],
  };
  const respond = vi.fn();
  const invoke = () => open({
    params: request, respond, client,
    hasCurrentClientAuthority: () => authority,
  });
  return {
    api, root, config, client, entry, request, connection, respond, invoke, close,
    stop: () => stop(),
    cleanup: () => cleanup({ sessionKey: request.sessionKey }),
    revokeAuthority: () => { authority = false; },
  };
}

it('keeps transport loading cold and rechecks cleanup, owner and native authority before any launch', async () => {
  const fixtures = Array.from({ length: 6 }, () => fixture());
  const [cleaned, disabled, adminRevoked, authorityRevoked, sessionChanged, incarnationChanged] = fixtures;
  sdk.session.mockImplementation(({ sessionKey }) => fixtures.find(f => f.request.sessionKey === sessionKey)?.entry);
  sdk.connect.mockImplementation(async (_server, cwd) => fixtures.find(f => canonicalDirectory(f.root) === cwd)!.connection);
  const pending: Promise<unknown>[] = [];
  try {
    for (const f of fixtures) {
      expect(f.api.registerTrustedToolPolicy).toHaveBeenCalledOnce();
      expect(f.api.registerTool).toHaveBeenCalledOnce();
    }
    expect(sdk.loading).not.toHaveBeenCalled();

    pending.push(...fixtures.map(f => f.invoke()));
    await vi.waitFor(() => expect(sdk.loading).toHaveBeenCalledOnce());
    pending.push(cleaned.cleanup());
    disabled.config.plugins.enabled = false;
    adminRevoked.client.connect.scopes = ['operator.write'];
    authorityRevoked.revokeAuthority();
    sessionChanged.entry.sessionId = 'replacement';
    incarnationChanged.entry.lifecycleRevision = 'two';
    for (const f of fixtures) expect(f.client.connectionSignal.aborted).toBe(false);
    sdk.release();
    await Promise.all(pending);

    for (const f of fixtures) expect(f.respond.mock.calls[0][0]).toBe(false);
    expect(sdk.connect).not.toHaveBeenCalled();

    await cleaned.invoke();
    expect(sdk.loading).toHaveBeenCalledOnce();
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(cleaned.respond.mock.calls[1][0]).toBe(true);
    await cleaned.stop();
    expect(cleaned.close).toHaveBeenCalledOnce();
  } finally {
    sdk.release();
    await Promise.allSettled(pending);
    await Promise.all(fixtures.map(f => f.stop()));
    for (const f of fixtures) fs.rmSync(f.root, { recursive: true, force: true });
  }
});
