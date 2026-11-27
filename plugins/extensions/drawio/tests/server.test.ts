import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { createEditorResource } from '../editor-resource.mjs';

const { packPublicAssets } = require('../scripts/prepare.cjs');
let server: typeof import('../server.mjs');
beforeAll(async () => {
  process.env.DIAGRAM_SERVER_TEST = '1';
  server = await import('../server.mjs');
  delete process.env.DIAGRAM_SERVER_TEST;
});
describe('offline diagram MCP service', () => {
  it('advertises a file entrypoint and passes only the native resource reference to the App', async () => {
    const native = server.createDiagramServer({ read: async () => ({ contents: [] }) });
    const client = new Client({ name: 'file-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await native.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const fileTool = tools.tools.find(tool => tool.name === 'open_file');
      expect(fileTool?._meta?.ui).toEqual({
        resourceUri: 'ui://drawio/editor',
        visibility: ['app'],
      });
      expect(fileTool?._meta?.['openai/ui']).toEqual({
        entrypoints: [{ type: 'file', extensions: ['.drawio'] }],
      });
      const file = {
        name: '采购流程.DRAWIO',
        resourceUri: 'openclaw-file://12345678-1234-1234-1234-123456789abc',
      };
      const opened = await client.callTool({ name: 'open_file', arguments: { file } });
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent).toEqual({
        file,
        diagramId: expect.stringMatching(/^diagram-/),
      });
      const diagramId = (opened.structuredContent as { diagramId: string }).diagramId;
      const origin = await client.readResource({ uri: `diagram://origin/${diagramId}` });
      expect(JSON.parse((origin.contents[0] as { text: string }).text)).toEqual({
        diagramId,
        toolName: 'open_file',
      });
      for (const invalid of [
        { ...file, resourceUri: 'file:///private/diagram.drawio' },
        { ...file, name: '../diagram.drawio' },
        { ...file, name: 'spreadsheet.xlsx' },
      ]) {
        expect(
          (await client.callTool({ name: 'open_file', arguments: { file: invalid } })).isError,
        ).toBe(true);
      }
    } finally {
      await client.close();
      await native.close();
    }
  });
  it('opens an empty editor through the advertised App-only manual entry without drawing arguments', async () => {
    const native = server.createDiagramServer({ read: async () => ({ contents: [] }) });
    const client = new Client({ name: 'manual-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await native.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const manual = tools.tools.find(tool => tool.name === 'open_editor');
      expect(client.getServerVersion()?.icons).toEqual(manual?.icons);
      expect(manual?.icons?.[0]).toMatchObject({
        src: expect.stringMatching(/^data:image\/svg\+xml,/),
        mimeType: 'image/svg+xml',
      });
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
  it('serves verified archive members under a loopback capability URL with local-only CSP', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'diagram-assets-'));
    const content = '<html>offline</html>';
    const archivePath = path.join(directory, 'public.pack');
    let resource: Awaited<ReturnType<typeof createEditorResource>> | undefined;
    try {
      const publicSource = path.join(directory, 'public-source');
      await mkdir(publicSource);
      await writeFile(path.join(directory, 'private.txt'), 'private');
      await writeFile(path.join(publicSource, '启动.html'), content);
      const publicFiles = await packPublicAssets(publicSource, archivePath);
      await rm(publicSource, { recursive: true });
      await Promise.all([
        writeFile(path.join(directory, 'app.css'), ''),
        writeFile(path.join(directory, 'app.js'), ''),
        writeFile(path.join(directory, 'integrity.json'), JSON.stringify({ publicFiles })),
      ]);

      resource = await createEditorResource(directory);
      const html = (await resource.read()).contents[0].text;
      const base = JSON.parse(html.match(/window\.DIAGRAM_ASSET_BASE=("[^"]+");/)![1]) as string;
      const assetUrl = base + encodeURIComponent('启动.html');
      const response = await fetch(assetUrl);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);
      const head = await fetch(assetUrl, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('Content-Length')).toBe(String(Buffer.byteLength(content)));
      expect(await head.text()).toBe('');
      const csp = response.headers.get('Content-Security-Policy')!;
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain('https:');
      expect((await fetch(new URL('/启动.html', base))).status).toBe(404);
      expect((await fetch(base + '%2e%2e%2fprivate.txt')).status).toBe(404);
      expect((await fetch(base + 'public.pack')).status).toBe(404);
      expect((await fetch(assetUrl, { method: 'POST' })).status).toBe(403);

      await using archive = await open(archivePath, 'r+');
      await archive.write(Buffer.from('!'), 0, 1, publicFiles['启动.html'].offset);
      expect((await fetch(assetUrl)).status).toBe(404);
    } finally {
      resource?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
