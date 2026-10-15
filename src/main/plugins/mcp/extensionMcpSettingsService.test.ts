import { expect, test, vi } from 'vitest';

import type { ExtensionProvidedMcpServer } from '../../../shared/plugins/mcp';
import {
  ExtensionMcpSettingsService,
  withExtensionMcpManagement,
} from './extensionMcpSettingsService';

const raw: ExtensionProvidedMcpServer = {
  id: 'extension:plugin:server',
  name: 'server',
  providerId: 'plugin',
  providerName: 'Plugin',
  providerDescription: '',
  enabled: true,
  supported: true,
  toggleable: true,
  configurable: true,
  transportType: 'stdio',
};
const managed = (server = raw) => withExtensionMcpManagement(server, new Set(), new Set());
const harness = (override?: Record<string, unknown>) => {
  const config = { mcp: { servers: override ? { server: override } : {} } };
  let enabled = override?.enabled !== false;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'config.get') return { valid: true, hash: 'revision', config };
    const patch = JSON.parse((params as { raw: string }).raw).mcp.servers.server;
    enabled = patch === null || patch.enabled !== false;
    return {};
  });
  const listServers = vi.fn(async () => [managed({ ...raw, enabled })]);
  const sync = vi.fn(async () => ({}));
  const readDefinition = vi.fn(async () => ({ command: 'node', args: ['default.mjs'] }));
  return {
    request,
    listServers,
    sync,
    readDefinition,
    service: new ExtensionMcpSettingsService({
      request: request as never,
      listServers,
      readDefinition,
    }),
  };
};

test('writes only a native disable marker and confirms application before reporting success', async () => {
  const h = harness();
  expect(await h.service.setEnabled({ id: raw.id, enabled: false }, h.sync)).toMatchObject({
    success: true,
    extensionServers: [{ enabled: false }],
  });
  expect(h.request).toHaveBeenCalledWith('config.patch', {
    baseHash: 'revision',
    raw: JSON.stringify({ mcp: { servers: { server: { enabled: false } } } }),
  });
  expect(h.sync).toHaveBeenCalledOnce();
  expect(h.listServers).toHaveBeenCalledTimes(2);
});

test.each([
  [{ enabled: false }, null],
  [{ enabled: false, command: 'node', args: ['custom.mjs'] }, { enabled: true }],
])(
  're-enabling removes a disable-only marker but preserves custom parameters',
  async (override, expected) => {
    const h = harness(override as Record<string, unknown>);
    expect(await h.service.setEnabled({ id: raw.id, enabled: true }, h.sync)).toMatchObject({
      success: true,
    });
    expect(h.request).toHaveBeenCalledWith('config.patch', {
      baseHash: 'revision',
      raw: JSON.stringify({ mcp: { servers: { server: expected } } }),
    });
  },
);

test('reads selected native parameters without writing configuration', async () => {
  const h = harness({ command: 'node', env: { TOKEN: '__OPENCLAW_REDACTED__' } });
  expect(await h.service.readSettings(raw.id)).toMatchObject({
    success: true,
    value: { definition: { command: 'node', env: { TOKEN: '__OPENCLAW_REDACTED__' } } },
  });
  expect(h.request.mock.calls.some(([method]) => method === 'config.patch')).toBe(false);
});

test('loads complete native defaults behind a disable-only override', async () => {
  const h = harness({ enabled: false });
  expect(await h.service.readSettings(raw.id)).toMatchObject({
    success: true,
    value: {
      override: { enabled: false },
      definition: { command: 'node', args: ['default.mjs'], enabled: false },
    },
  });
  expect(h.readDefinition).toHaveBeenCalledExactlyOnceWith(raw.id);
});

test('reads native source references without expanding or persisting them', async () => {
  const h = harness();
  h.request.mockImplementation(async () => ({
    valid: true,
    hash: 'revision',
    config: {
      mcp: { servers: { server: { command: 'node', env: { TOKEN: '__OPENCLAW_REDACTED__' } } } },
    },
    sourceConfig: {
      mcp: { servers: { server: { command: 'node', env: { TOKEN: '${MCP_TOKEN}' } } } },
    },
  }));
  expect(await h.service.readSettings(raw.id)).toMatchObject({
    success: true,
    value: { override: { env: { TOKEN: '${MCP_TOKEN}' } } },
  });
});

test('rejects forged identities before writing', async () => {
  const h = harness();
  expect(
    await h.service.setEnabled({ id: 'extension:other:server', enabled: false }, h.sync),
  ).toEqual({ success: false, code: 'forbidden' });
  expect(h.request.mock.calls.filter(([method]) => method === 'config.patch')).toHaveLength(0);
});

test.each([
  undefined,
  {},
  { id: raw.id, enabled: 'false' },
  { id: raw.id, enabled: false, providerId: 'other' },
])('rejects malformed switch payloads', async input => {
  const h = harness();
  expect(await h.service.setEnabled(input, h.sync)).toEqual({ success: false, code: 'invalid' });
  expect(h.request).not.toHaveBeenCalled();
});

test('does not retry uncertain writes or issue compensating inverse writes', async () => {
  const h = harness();
  h.request.mockImplementation(async method => {
    if (method === 'config.get') return { valid: true, hash: 'revision', config: {} };
    throw new Error('timeout with sensitive fixture diagnostic');
  });
  expect(await h.service.setEnabled({ id: raw.id, enabled: false }, h.sync)).toEqual({
    success: false,
    code: 'unavailable',
  });
  expect(h.request.mock.calls.filter(([method]) => method === 'config.patch')).toHaveLength(1);
  expect(h.sync).not.toHaveBeenCalled();
});

test('reports failure when runtime application cannot be confirmed', async () => {
  const h = harness();
  h.sync.mockResolvedValue({ error: 'application failed' } as never);
  expect(await h.service.setEnabled({ id: raw.id, enabled: false }, h.sync)).toEqual({
    success: false,
    code: 'apply-failed',
  });
});

test('protects managed providers, name collisions and unavailable native ownership', () => {
  for (const server of [
    withExtensionMcpManagement(raw, new Set(), new Set(['plugin'])),
    withExtensionMcpManagement(raw, new Set(['server']), new Set()),
    managed({ ...raw, toggleable: false, configurable: false }),
  ]) {
    expect(server.management?.enable.allowed).toBe(false);
    expect(server.management?.disable.allowed).toBe(false);
    expect(server.management?.configure.allowed).toBe(false);
  }
  expect(managed().management?.configure.allowed).toBe(false);
  const repairable = managed({ ...raw, toggleable: false, supported: false });
  expect(repairable.management?.enable.allowed).toBe(false);
  expect(repairable.management?.configure.allowed).toBe(false);
});
