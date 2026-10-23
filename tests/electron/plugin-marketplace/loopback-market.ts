import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import * as tar from 'tar';

import type { PluginMarketplaceProvider } from '../../../src/main/plugins/marketplace/types';
import {
  MarketplaceInstallState,
  type MarketplacePlugin,
  type MarketplacePluginKind,
} from '../../../src/shared/plugins/marketplace';
import { PluginOperationStage } from '../../../src/shared/plugins/pluginOperation';

const SOURCE = 'loopback-market';
const MAX_PACKAGE_BYTES = 1_048_576;

export interface MarketScenario {
  pluginId?: string;
  failure?: 'metadata' | 'download' | 'invalid' | 'activation' | 'refresh';
  delayMs?: number;
  version?: string;
}

/** Test-only HTTP market. Never registered by the application or production factory. */
export async function createLoopbackMarket(options: {
  fixtureRoot: string;
  nodeExecutable: string;
  mcpServer: string;
}) {
  const root = path.join(options.fixtureRoot, 'market');
  const staging = path.join(root, 'downloads');
  await fs.mkdir(staging, { recursive: true });
  const requests: Array<{ pathname: string; status: number; bytes: number }> = [];
  const preparations: Array<{
    pluginId: string;
    version: string;
    bytes?: number;
    sha256?: string;
    cleaned: boolean;
  }> = [];
  let scenario: MarketScenario = {};
  const entries: Array<[string, MarketplacePluginKind, string, string]> = [
    ['catalog-skill', 'skill', 'Fixture market skill', 'fixture-market-skill'],
    ['catalog-download-failure', 'skill', 'Fixture download failure', 'fixture-market-download-failure'],
    ['catalog-metadata-failure', 'skill', 'Fixture metadata failure', 'fixture-market-metadata-failure'],
    ['catalog-invalid-archive', 'skill', 'Fixture invalid archive', 'fixture-market-invalid-archive'],
    ['catalog-extension', 'extension', 'Fixture market extension', 'fixture-market-extension'],
    ['catalog-requires-config', 'extension', 'Fixture required configuration', 'fixture-market-requires-config'],
    ['catalog-mcp', 'mcp', 'Fixture market MCP', 'fixture-market-mcp'],
  ];
  const catalog = (): MarketplacePlugin[] => entries.map(([id, kind, name, runtimeId]) => ({
    id, kind, name, runtimeId, sourceId: SOURCE,
    description: 'Disposable offline integration fixture.',
    version: scenario.version ?? '1.0.0',
    author: 'Local integration test',
  }));
  const packages = new Map<string, Buffer>();
  for (const [id, kind, name, runtimeId] of entries) {
    for (const version of ['1.0.0', '2.0.0']) {
      const source = path.join(root, 'sources', id, version);
      const packageRoot = path.join(source, 'package');
      await fs.mkdir(packageRoot, { recursive: true });
      if (kind === 'skill') {
        await fs.writeFile(path.join(packageRoot, 'SKILL.md'),
          `---\nname: ${runtimeId}\ndescription: Isolated market fixture ${version}.\n---\n# Fixture\nVersion ${version}.\n`);
      } else if (kind === 'extension') {
        await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
          name: runtimeId, version, type: 'module', main: './index.js',
          openclaw: { extensions: ['./index.js'] },
        }));
        await fs.writeFile(path.join(packageRoot, 'openclaw.plugin.json'), JSON.stringify({
          id: runtimeId, name, version, description: `Fixture ${version}`,
          configSchema: {
            type: 'object', additionalProperties: false,
            properties: id === 'catalog-requires-config' ? { accessCode: { type: 'string', minLength: 1 } } : {},
            ...(id === 'catalog-requires-config' ? { required: ['accessCode'] } : {}),
          },
        }));
        await fs.writeFile(path.join(packageRoot, 'index.js'),
          `export default { id: ${JSON.stringify(runtimeId)}, name: ${JSON.stringify(name)}, register() {} };\n`);
      } else {
        await fs.writeFile(path.join(packageRoot, 'mcp.json'), JSON.stringify({
          name, description: `Fixture ${version}`, transportType: 'stdio',
          command: options.nodeExecutable, args: [options.mcpServer], env: { FIXTURE_VERSION: version },
        }));
      }
      const archive = path.join(source, 'package.tgz');
      await tar.create({ cwd: source, gzip: true, file: archive, portable: true }, ['package']);
      packages.set(`${id}/${version}`, await fs.readFile(archive));
    }
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let status = 200;
      let body: Buffer;
      const [, route, id, version] = url.pathname.split('/');
      const matching = scenario.pluginId === id;
      if (matching && scenario.delayMs && ['metadata', 'packages'].includes(route)) {
        await new Promise(resolve => setTimeout(resolve, Math.min(scenario.delayMs!, 10_000)));
      }
      if (route === 'catalog') {
        const kind = url.searchParams.get('kind');
        const query = (url.searchParams.get('query') ?? '').toLowerCase();
        const items = catalog().filter(item => (!kind || item.kind === kind) &&
          (!query || item.name.toLowerCase().includes(query)));
        body = Buffer.from(JSON.stringify({ items }));
      } else if (route === 'metadata') {
        const item = catalog().find(item => item.id === id);
        if (!item || (matching && scenario.failure === 'metadata')) {
          status = 503;
          body = Buffer.from('Fixture metadata unavailable');
        } else body = Buffer.from(JSON.stringify(item));
      } else if (route === 'packages') {
        const archive = packages.get(`${id}/${version}`);
        if (!archive || (matching && scenario.failure === 'download')) {
          status = 503;
          body = Buffer.from('Fixture download unavailable');
        } else body = matching && scenario.failure === 'invalid'
          ? Buffer.from('This is deliberately not a gzip archive.') : archive;
      } else {
        status = 404;
        body = Buffer.from('Not found');
      }
      requests.push({ pathname: url.pathname, status, bytes: body.length });
      response.writeHead(status, {
        'Content-Type': route === 'packages' ? 'application/octet-stream' : 'application/json',
        'Content-Length': body.length,
      });
      response.end(body);
    })().catch(() => response.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (pathname: string) => {
    const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Fixture market HTTP ${response.status}`);
    }
    return response;
  };
  const removeStaging = async (directory: string) => {
    assert.equal(path.dirname(directory), staging, 'Cleanup must stay in this attempt staging root');
    assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(staging));
    await fs.rm(directory, { recursive: true, force: true });
  };
  const provider: PluginMarketplaceProvider = {
    source: { id: SOURCE, name: 'Local test marketplace', supportedKinds: ['extension', 'skill', 'mcp'] },
    async search(query) {
      const params = new URLSearchParams({ kind: query.kind, query: query.query ?? '' });
      return (await request(`/catalog?${params}`)).json();
    },
    async checkUpdates(input) {
      const result = await (await request(`/catalog?kind=${input.kind}`)).json() as { items: MarketplacePlugin[] };
      return result.items.filter(item => input.installed.some(entry =>
        entry.id === item.id && entry.version !== item.version)).map(item => ({
        ...item, installState: MarketplaceInstallState.UPDATE_AVAILABLE,
      }));
    },
    async prepareInstall(input, context) {
      const evidence = { pluginId: input.pluginId, version: input.version ?? '1.0.0', cleaned: false };
      preparations.push(evidence);
      const directory = await fs.mkdtemp(path.join(staging, 'attempt-'));
      const cleanup = async () => { await removeStaging(directory); evidence.cleaned = true; };
      try {
        context?.onProgress?.(PluginOperationStage.FETCHING_METADATA);
        const item = await (await request(`/metadata/${encodeURIComponent(input.pluginId)}`)).json() as MarketplacePlugin;
        assert.equal(item.kind, input.kind);
        const version = input.version ?? item.version!;
        context?.onProgress?.(PluginOperationStage.DOWNLOADING);
        const download = await request(`/packages/${encodeURIComponent(input.pluginId)}/${encodeURIComponent(version)}`);
        assert.ok(Number(download.headers.get('content-length')) <= MAX_PACKAGE_BYTES);
        const archive = path.join(directory, 'package.tgz');
        assert.ok(download.body);
        await pipeline(Readable.fromWeb(download.body as never), createWriteStream(archive));
        const bytes = await fs.readFile(archive);
        assert.ok(bytes.length <= MAX_PACKAGE_BYTES);
        Object.assign(evidence, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        context?.onProgress?.(PluginOperationStage.EXTRACTING);
        const extracted = path.join(directory, 'extracted');
        await fs.mkdir(extracted);
        await tar.extract({ file: archive, cwd: extracted, strict: true, preservePaths: false });
        const packageRoot = path.join(extracted, 'package');
        context?.onProgress?.(PluginOperationStage.VALIDATING);
        if (input.kind === 'mcp') {
          const config = JSON.parse(await fs.readFile(path.join(packageRoot, 'mcp.json'), 'utf8'));
          return { payload: { kind: 'mcp', config }, cleanup };
        }
        return { payload: { kind: input.kind, sourcePath: packageRoot }, cleanup };
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  };
  return {
    provider,
    setScenario(next: MarketScenario) { scenario = { ...next }; },
    get scenario() { return scenario; },
    async evidence() { return { base, requests: [...requests], preparations: [...preparations], remainingDownloads: await fs.readdir(staging) }; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
