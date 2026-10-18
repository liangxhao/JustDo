import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';

let server: typeof import('../server.mjs');
beforeAll(async () => {
  process.env.DIAGRAM_SERVER_TEST = '1';
  server = await import('../server.mjs');
  delete process.env.DIAGRAM_SERVER_TEST;
});
describe('offline diagram MCP service', () => {
  it('opens an empty editor through the advertised App-only manual entry without drawing arguments', async () => {
    const native = server.createDiagramServer({ read: async () => ({ contents: [] }) });
    const client = new Client({ name: 'manual-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await native.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const manual = tools.tools.find(tool => tool.name === 'open_editor');
      expect(manual?._meta?.ui).toEqual({ resourceUri: 'ui://drawio/editor', visibility: ['app'] });
      expect(manual?._meta?.['openai/ui']).toEqual({ entrypoints: [{ type: 'global' }] });
      const opened = await client.callTool({ name: 'open_editor', arguments: {} });
      expect(opened.isError).not.toBe(true);
      const diagram = server.validateDiagram(opened.structuredContent);
      expect(diagram.xml).toContain('<mxCell id="1" parent="0"/>');
      expect(diagram.xml).not.toContain('vertex=');
      const missing = await client.callTool({ name: 'create_diagram', arguments: {} });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
      await native.close();
    }
  });
  it('admits positioned Unicode diagrams and rejects malformed XML, DTD and oversized input', async () => {
    const xml = await readFile(path.join(__dirname, 'fixture.xml'), 'utf8');
    expect(server.validateDiagram({ xml, title: '采购流程' })).toEqual({ xml, title: '采购流程' });
    for (const invalid of [
      '<html/>',
      '<mxfile><diagram></mxfile>',
      '<!DOCTYPE mxfile><mxfile/>',
      '<mxfile>&unknown;</mxfile>',
      '<mxfile>' + 'x'.repeat(1024 * 1024) + '</mxfile>',
    ]) {
      expect(() => server.validateDiagram({ xml: invalid })).toThrow();
    }
  });
  it('serves only immutable files under a loopback capability URL with local-only CSP', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'diagram-assets-'));
    await mkdir(path.join(directory, 'public'));
    await writeFile(path.join(directory, 'private.txt'), 'private');
    await writeFile(path.join(directory, 'public', 'index.html'), '<html>offline</html>');
    const assets = await server.startAssets(path.join(directory, 'public'));
    try {
      const response = await fetch(assets.base + 'index.html');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>offline</html>');
      const csp = response.headers.get('Content-Security-Policy')!;
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain('https:');
      expect((await fetch(assets.origin + '/index.html')).status).toBe(404);
      expect((await fetch(assets.base + '%2e%2e%2fprivate.txt')).status).toBe(404);
      expect((await fetch(assets.base + 'index.html', { method: 'POST' })).status).toBe(403);
    } finally {
      assets.http.closeAllConnections();
      await new Promise<void>(resolve => assets.http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
