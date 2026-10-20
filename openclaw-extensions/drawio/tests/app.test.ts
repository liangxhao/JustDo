// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  app: {} as {
    ontoolresult: (result: { structuredContent: Record<string, unknown> }) => Promise<void>;
    onteardown: () => Promise<unknown>;
  },
}));
vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: class {
    constructor() {
      fixture.app = this as unknown as typeof fixture.app;
    }
    readServerResource = fixture.read;
    connect = async () => {};
    getHostContext = () => ({ locale: 'en', theme: 'light' });
    getHostCapabilities = () => ({});
  },
  applyDocumentTheme: vi.fn(),
  applyHostStyleVariables: vi.fn(),
}));

const file = {
  name: '采购流程.drawio',
  resourceUri: 'openclaw-file://12345678-1234-1234-1234-123456789abc',
};
const original = readFileSync(path.join(__dirname, 'fixture.xml'), 'utf8');
let message: (event: MessageEvent) => void;
let posted: string[];
const resource = (text: string, uri = file.resourceUri) => ({ contents: [{ uri, text }] });
const loaded = () =>
  posted
    .map(data => JSON.parse(data) as { action: string; xml?: string; title?: string })
    .filter(data => data.action === 'load');

beforeEach(async () => {
  vi.resetModules();
  fixture.read.mockReset();
  document.body.innerHTML =
    '<span id="title"></span><span id="status"></span><button id="save"></button>' +
    '<button id="png"></button><button id="svg"></button><iframe id="editor"></iframe>';
  window.DIAGRAM_ASSET_BASE = 'http://127.0.0.1:4000/assets/';
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'message') message = listener as (event: MessageEvent) => void;
  });
  await import('../app');
  await Promise.resolve();
  const frame = document.querySelector<HTMLIFrameElement>('#editor')!.contentWindow!;
  posted = [];
  vi.spyOn(frame, 'postMessage').mockImplementation(data => {
    posted.push(data as string);
  });
  message(new MessageEvent('message', { source: frame, origin: 'null', data: '{"event":"init"}' }));
});
afterEach(async () => {
  await fixture.app.onteardown();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

test('loads the selected file contents into the editor through the native resource bridge', async () => {
  fixture.read.mockResolvedValue(resource(original));
  await fixture.app.ontoolresult({ structuredContent: { file } });

  expect(fixture.read).toHaveBeenCalledWith({
    uri: file.resourceUri,
    _meta: { 'openai/resource': { representation: 'text' } },
  });
  expect(loaded()).toEqual([expect.objectContaining({ xml: original, title: '采购流程' })]);
  expect(document.querySelector('#title')?.textContent).toBe('采购流程.drawio');
  expect(document.querySelector<HTMLButtonElement>('#save')?.disabled).toBe(false);
});

test('passes compressed mxfile diagrams intact to draw.io for decoding', async () => {
  const compressed = '<mxfile><diagram id="page">encoded-compressed-diagram</diagram></mxfile>';
  fixture.read.mockResolvedValue(resource(compressed));
  await fixture.app.ontoolresult({ structuredContent: { file } });
  expect(loaded()[0].xml).toBe(compressed);
});

test.each([
  ['malformed XML', '<mxfile><diagram></mxfile>'],
  ['unrelated XML', '<html/>'],
  ['DTD', '<!DOCTYPE mxfile><mxfile/>'],
  ['oversized Unicode', '<mxfile>' + '字'.repeat(400_000) + '</mxfile>'],
])('shows a file error without loading %s into the editor', async (_label, xml) => {
  fixture.read.mockResolvedValue(resource(xml));
  await fixture.app.ontoolresult({ structuredContent: { file } });
  expect(loaded()).toEqual([]);
  expect(document.querySelector('#status')?.textContent).toContain('Could not open diagram');
  expect(document.querySelector<HTMLButtonElement>('#save')?.disabled).toBe(true);
});

test('does not treat a failed resource read as a blank diagram', async () => {
  fixture.read.mockRejectedValue(new Error('File authority expired'));
  await fixture.app.ontoolresult({ structuredContent: { file } });
  expect(loaded()).toEqual([]);
  expect(document.querySelector('#status')?.textContent).toContain('Could not open diagram');
});

test('rejects another resource instead of loading it as the selected file', async () => {
  fixture.read.mockResolvedValue(resource(original, 'openclaw-file://foreign'));
  await fixture.app.ontoolresult({ structuredContent: { file } });
  expect(loaded()).toEqual([]);
  expect(document.querySelector('#status')?.textContent).toContain('Could not open diagram');
});

test.each(['new result', 'teardown'])('ignores a file read completed after %s', async reason => {
  let resolve!: (value: ReturnType<typeof resource>) => void;
  fixture.read.mockReturnValue(new Promise(value => (resolve = value)));
  const pending = fixture.app.ontoolresult({ structuredContent: { file } });
  if (reason === 'teardown') await fixture.app.onteardown();
  else await fixture.app.ontoolresult({ structuredContent: { xml: original, title: 'Newer' } });
  const before = loaded();
  resolve(resource(original));
  await pending;
  expect(loaded()).toEqual(before);
});
