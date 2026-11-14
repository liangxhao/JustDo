import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  collectDiagnosticPluginInventory,
  readDiagnosticNativeExtensions,
  serializeDiagnosticPluginInventory,
} from './exportPluginInventory';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-plugins-'));
  directories.push(root);
  const runtime = path.join(root, 'runtime');
  const state = path.join(root, 'state');
  const config = path.join(state, 'openclaw.json');
  const add = async (directory: string, name: string, manifest: Record<string, unknown>) => {
    const plugin = path.join(directory, name);
    await fs.mkdir(plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, 'openclaw.plugin.json'), JSON.stringify(manifest));
  };
  await add(path.join(runtime, 'dist', 'extensions'), 'bundled', {
    id: 'Bundled',
    name: 'Bundled plugin',
    version: '1.2.3',
    enabledByDefault: true,
    contracts: { tools: ['draw', 'C:/PRIVATE_PATH', 'https://PRIVATE_URL'] },
    mcpServers: {
      diagram: { url: 'PRIVATE_ENDPOINT', headers: { authorization: 'PRIVATE_TOKEN' } },
    },
  });
  await add(path.join(state, 'extensions'), 'installed', {
    id: 'installed',
    version: '2.0.0',
    name: 'Disabled local plugin',
  });
  const locations = {
    stateDir: state,
    configPath: config,
    runtimeRoots: [runtime],
  };
  return { add, root, runtime, config, locations };
}

describe('diagnostic plugin inventory', () => {
  it('keeps disabled local packages, authored policy and configured-only entries without leaking definitions', async () => {
    const { locations, config } = await fixture();
    await fs.writeFile(
      config,
      `{
      plugins: {
        allow: ['BUNDLED', 'linked'],
        deny: ['installed'],
        entries: {
          BUNDLED: { enabled: true, config: { authorization: 'PRIVATE_VALUE' } },
          installed: { enabled: false },
          linked: { enabled: true }
        }
      }
    }`,
    );

    const inventory = await collectDiagnosticPluginInventory({
      readExtensions: signal => readDiagnosticNativeExtensions(locations, signal),
      readMcpServers: () => [
        { name: 'local-mcp', enabled: false, transportType: 'http', url: 'PRIVATE_URL' },
      ],
      readSavedHooks: () => [
        { id: 'local-hook', enabled: false, config: { data: 'PRIVATE_CONFIG' } },
      ],
    });
    expect(inventory.extensions).toMatchObject({
      status: 'partial',
      gaps: ['local_discovery_only'],
      omitted: 0,
      entries: [
        {
          id: 'Bundled',
          name: 'Bundled plugin',
          version: '1.2.3',
          origin: 'bundled',
          configuredEnabled: true,
          savedAllowlistIncluded: true,
          packageDefaultEnabled: true,
          tools: ['draw'],
          declaredMcpServers: ['diagram'],
        },
        {
          id: 'installed',
          configuredEnabled: false,
          savedPolicyBlock: 'denied',
          savedAllowlistIncluded: false,
          origin: 'managed',
        },
        { id: 'linked', configuredEnabled: true, origin: 'configured_only' },
      ],
    });
    expect(inventory.mcpServers.entries).toEqual([
      { name: 'local-mcp', configuredEnabled: false, transport: 'http' },
    ]);
    expect(inventory.savedHooks.entries).toEqual([{ id: 'local-hook', configuredEnabled: false }]);
    expect(serializeDiagnosticPluginInventory(inventory)).not.toContain('PRIVATE');
  });

  it('records saved allowlist membership without claiming that an unlisted slot owner is blocked', async () => {
    const { config, locations } = await fixture();
    await fs.writeFile(
      config,
      JSON.stringify({
        plugins: { allow: ['another-plugin'], slots: { memory: 'Bundled' } },
      }),
    );
    const inventory = await collectDiagnosticPluginInventory({
      readExtensions: signal => readDiagnosticNativeExtensions(locations, signal),
    });
    const bundled = inventory.extensions.entries.find(row => row.id === 'Bundled');
    expect(bundled).toMatchObject({ savedAllowlistIncluded: false });
    expect(bundled?.savedPolicyBlock).toBeUndefined();
  });

  it('uses the staged local runtime selector and rejects unrelated runtime and managed links', async () => {
    const { add, root, runtime, config, locations } = await fixture();
    const firstCandidate = path.join(root, 'first', 'vendor', 'openclaw-runtime', 'current');
    const secondCandidate = path.join(root, 'second', 'vendor', 'openclaw-runtime', 'current');
    const target = path.join(path.dirname(secondCandidate), 'win-x64');
    const managedLink = path.join(locations.stateDir, 'extensions', 'linked');
    const outside = path.join(root, 'outside');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await add(path.join(outside, 'dist', 'extensions'), 'unrelated', { id: 'unrelated' });
    await fs.writeFile(path.join(outside, 'openclaw.plugin.json'), '{ "id": "unrelated-managed" }');
    await fs.mkdir(path.dirname(firstCandidate), { recursive: true });
    await fs.mkdir(path.dirname(secondCandidate), { recursive: true });
    await fs.rename(runtime, target);
    await fs.symlink(outside, firstCandidate, linkType);
    await fs.symlink(target, secondCandidate, linkType);
    await fs.symlink(outside, managedLink, linkType);
    await fs.writeFile(config, '{}');

    const inventory = await collectDiagnosticPluginInventory({
      readExtensions: signal =>
        readDiagnosticNativeExtensions(
          {
            ...locations,
            runtimeRoots: [firstCandidate, secondCandidate],
          },
          signal,
        ),
    });

    expect(inventory.extensions.entries.map(row => row.id)).toEqual(['Bundled', 'installed']);
    expect(inventory.extensions.gaps).toContain('local_discovery_incomplete');
  });

  it('retains package evidence when the saved policy is unreadable', async () => {
    const { locations, config } = await fixture();
    await fs.writeFile(config, '{ malformed policy');
    const inventory = await collectDiagnosticPluginInventory({
      readExtensions: signal => readDiagnosticNativeExtensions(locations, signal),
    });
    expect(inventory.extensions.gaps).toContain('saved_policy_unavailable');
    expect(inventory.extensions.entries).toMatchObject([{ id: 'Bundled' }, { id: 'installed' }]);
    expect(serializeDiagnosticPluginInventory(inventory)).not.toContain('configuredEnabled');
  });

  it('exports declared and disabled native MCP servers from known offline directories', async () => {
    const { config, locations } = await fixture();
    const bundle = path.join(locations.stateDir, 'extensions', 'bundle-connector');
    await fs.mkdir(bundle);
    await fs.writeFile(
      path.join(bundle, '.mcp.json'),
      JSON.stringify({
        mcpServers: { 'bundle-server': { command: 'PRIVATE_COMMAND' } },
      }),
    );
    await fs.writeFile(
      config,
      JSON.stringify({
        skills: { entries: { maintenance: { enabled: false, apiKey: 'PRIVATE_SKILL' } } },
        hooks: {
          internal: { entries: { 'audit-log': { enabled: false, command: 'PRIVATE_HOOK' } } },
        },
        mcp: {
          servers: {
            diagram: { enabled: false },
            remote: {
              url: 'PRIVATE_SERVER',
              enabled: true,
              headers: { authorization: 'PRIVATE_HEADER' },
            },
          },
        },
      }),
    );
    const inventory = await collectDiagnosticPluginInventory({
      readExtensions: signal => readDiagnosticNativeExtensions(locations, signal),
    });
    expect(inventory.extensions.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'Bundled' }),
        expect.objectContaining({ id: 'installed' }),
        expect.objectContaining({ id: 'bundle-connector', declaredMcpServers: ['bundle-server'] }),
      ]),
    );
    expect(inventory.savedSkills.entries).toEqual([
      { id: 'maintenance', configuredEnabled: false },
    ]);
    expect(inventory.savedNativeHooks.entries).toEqual([
      { id: 'audit-log', configuredEnabled: false },
    ]);
    expect(inventory.nativeMcpServers.entries).toEqual([
      { name: 'diagram', declaredBy: ['Bundled'], configuredEnabled: false },
      { name: 'remote', declaredBy: [], configuredEnabled: true, configuredTransport: 'http' },
      { name: 'bundle-server', declaredBy: ['bundle-connector'] },
    ]);
    expect(serializeDiagnosticPluginInventory(inventory)).not.toContain('PRIVATE');
  });

  it('uses the selected scope, preserving enabled and disabled metadata without invoking marketplace or probes', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'skills.status'
        ? {
            skills: [
              { skillKey: 'skill', disabled: true, eligible: false, filePath: 'PRIVATE_FILE' },
            ],
          }
        : {
            hooks: [
              {
                hookKey: 'hook',
                enabledByConfig: true,
                loadable: true,
                events: ['agent:startup'],
                handlerPath: 'PRIVATE_HANDLER',
              },
            ],
          },
    );
    const client = { request } as unknown as GatewayClientLike;
    const inventory = await collectDiagnosticPluginInventory({
      client,
      agentId: 'research',
      sessionKey: 'private-key',
      readAppPlugins: () => [
        { id: 'companion', state: 'cleanup', slots: ['slot'], epoch: 'PRIVATE_EPOCH' },
      ],
    });

    expect(request.mock.calls).toEqual([
      [
        'skills.status',
        { agentId: 'research', sessionKey: 'private-key' },
        { timeoutMs: 3000, signal: expect.any(AbortSignal) },
      ],
      [
        'hooks.status',
        { agentId: 'research' },
        { timeoutMs: 3000, signal: expect.any(AbortSignal) },
      ],
    ]);
    expect(inventory.skills).toMatchObject({
      scope: 'selected_session',
      entries: [{ id: 'skill', configuredEnabled: false, eligible: false }],
    });
    expect(inventory.hooks).toMatchObject({
      scope: 'selected_agent',
      entries: [{ id: 'hook', configuredEnabled: true, loadable: true, events: ['agent:startup'] }],
    });
    expect(inventory.appCompanions.entries).toMatchObject([
      { id: 'companion', state: 'cleanup', slots: ['slot'] },
    ]);
    expect(serializeDiagnosticPluginInventory(inventory)).not.toMatch(/PRIVATE|private-key/);
  });

  it('reports unavailable offline sources and caps oversized projected inventories with omission counts', async () => {
    const inventory = await collectDiagnosticPluginInventory({
      agentId: 'main',
      readMcpServers: () =>
        Array.from({ length: 2000 }, (_, index) => ({
          name: `${index}-${'中'.repeat(150)}`,
          enabled: index % 2 === 0,
        })),
    });
    expect(inventory.skills).toMatchObject({
      status: 'unavailable',
      gaps: ['offline'],
      entries: [],
    });
    expect(inventory.mcpServers).toMatchObject({
      status: 'partial',
      gaps: ['output_limit'],
      seen: 2000,
    });
    expect(inventory.mcpServers.entries.length + inventory.mcpServers.omitted).toBe(2000);
    const exported = serializeDiagnosticPluginInventory(inventory);
    expect(Buffer.byteLength(exported)).toBeLessThan(64 * 1024);
    expect(JSON.parse(exported)).toMatchObject({
      collectedAt: new Date(inventory.collectedAt).toISOString(),
      mcpServers: expect.objectContaining({ seen: 2000 }),
    });
    expect(JSON.parse(exported).skills).not.toHaveProperty('seen');
  });
});
