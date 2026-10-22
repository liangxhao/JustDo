// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn().mockResolvedValue({}),
  prepare: undefined as undefined | (() => Promise<unknown>),
  tools: new Map<string, (input?: unknown) => Promise<any>>(),
  capabilities: {} as Record<string, unknown>,
  hostContext: { locale: 'en', theme: 'light' } as Record<string, unknown>,
  app: {} as {
    ontoolresult: (result: { structuredContent: Record<string, unknown> }) => Promise<void>;
    onteardown: () => Promise<unknown>;
    onhostcontextchanged: () => void;
  },
}));
vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: class {
    constructor(_info: unknown, capabilities: Record<string, unknown>) {
      fixture.capabilities = capabilities;
      fixture.app = this as unknown as typeof fixture.app;
    }
    readServerResource = fixture.read;
    updateModelContext = fixture.update;
    registerTool = (name: string, _config: unknown, callback: () => Promise<unknown>) => {
      if (name === 'prepare_context') fixture.prepare = callback;
      fixture.tools.set(name, callback);
    };
    connect = async () => {};
    getHostContext = () => fixture.hostContext;
    getHostCapabilities = () => ({ updateModelContext: { text: {} } });
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

test('prepared browser snapshots commit all pages and apply by exact generation without reloading the iframe', async () => {
  await fixture.app.ontoolresult({
    structuredContent: { xml: original, title: 'Prepared', diagramId: 'diagram-current' },
  });
  const frame = document.querySelector<HTMLIFrameElement>('#editor')!.contentWindow!;
  const emit = (data: unknown) =>
    message(
      new MessageEvent('message', { source: frame, origin: 'null', data: JSON.stringify(data) }),
    );
  const reading = fixture.tools.get('diagram_snapshot')!();
  const request = JSON.parse(posted.at(-1)!);
  expect(request.action).toBe('diagram-snapshot');
  emit({ event: 'diagram-snapshot', requestId: request.requestId, xml: original, generation: 5 });
  const current = (await reading).structuredContent;
  expect(current.diagramId).toBe('diagram-current');
  const operation = {
    operationId: 'operation',
    diagramId: current.diagramId,
    baseContentStamp: current.contentStamp,
    xml: original.replace('提交申请', 'AI 修改'),
    title: 'Updated',
  };
  const before = loaded().length;
  const applying = fixture.tools.get('diagram_apply')!(operation);
  const apply = JSON.parse(posted.at(-1)!);
  expect(apply).toMatchObject({ action: 'diagram-apply', expectedXml: original, generation: 5 });
  emit({
    event: 'diagram-applied',
    requestId: apply.requestId,
    status: 'applied',
    xml: operation.xml,
    generation: 6,
  });
  expect((await applying).structuredContent).toMatchObject({
    operationId: 'operation',
    status: 'applied',
    snapshot: { xml: operation.xml },
  });
  expect(loaded()).toHaveLength(before);
  expect((await fixture.tools.get('diagram_apply')!(operation)).isError).toBe(true);
});

beforeEach(async () => {
  vi.resetModules();
  fixture.read.mockReset();
  fixture.update.mockReset().mockResolvedValue({});
  fixture.tools.clear();
  fixture.hostContext = { locale: 'en', theme: 'light' };
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

test('shares only its toolbar layout and restores its title without replacing the editor', () => {
  expect(fixture.capabilities).toEqual({ experimental: { 'ui/shared-header': { version: 1 } } });
  const frame = document.querySelector('#editor');
  const save = document.querySelector('#save');
  fixture.hostContext['ui/shared-header'] = { height: 44, left: 120, right: 96 };
  fixture.app.onhostcontextchanged();
  expect(document.documentElement.hasAttribute('data-shared-header')).toBe(true);
  expect(document.documentElement.style.getPropertyValue('--app-header-left')).toBe('120px');
  expect(document.documentElement.style.getPropertyValue('--app-header-right')).toBe('96px');
  expect(document.documentElement.style.getPropertyValue('--app-header-height')).toBe('44px');
  fixture.hostContext['ui/shared-header'] = null;
  fixture.app.onhostcontextchanged();
  expect(document.documentElement.hasAttribute('data-shared-header')).toBe(false);
  expect(document.documentElement.style.getPropertyValue('--app-header-left')).toBe('12px');
  expect(document.querySelector('#editor')).toBe(frame);
  expect(document.querySelector('#save')).toBe(save);
});

test('ignores malformed shared-header sizes and keeps the standalone toolbar', () => {
  for (const layout of [
    { height: 44, left: '120px', right: 96 },
    { height: 80, left: 120, right: 96 },
    { height: 44, left: 120, right: Infinity },
    { height: 44, left: -1, right: 96 },
  ]) {
    fixture.hostContext['ui/shared-header'] = layout;
    fixture.app.onhostcontextchanged();
    expect(document.documentElement.hasAttribute('data-shared-header')).toBe(false);
  }
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

test('first-send preparation commits current cell editing and waits for the native context update', async () => {
  await fixture.app.ontoolresult({
    structuredContent: { xml: original, title: 'Current drawing' },
  });
  let resolveUpdate!: () => void;
  fixture.update.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        resolveUpdate = resolve;
      }),
  );
  let settled = false;
  const preparing = fixture.prepare!().then(() => {
    settled = true;
  });
  const commit = JSON.parse(posted.at(-1)!) as { action: string; requestId: string };
  expect(commit.action).toBe('diagram-commit');
  const frame = document.querySelector<HTMLIFrameElement>('#editor')!.contentWindow!;
  const emit = (data: unknown) =>
    message(
      new MessageEvent('message', { source: frame, origin: 'null', data: JSON.stringify(data) }),
    );
  emit({ event: 'diagram-committed', requestId: commit.requestId });
  const request = JSON.parse(posted.at(-1)!) as {
    action: string;
    requestId: string;
    format: string;
  };
  expect(request).toMatchObject({ action: 'export', format: 'xml', requestId: commit.requestId });
  const edited = original.replace('<root>', '<root><!-- 最后未提交文字 -->');
  emit({ event: 'export', format: 'xml', xml: edited, message: request });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(fixture.update).toHaveBeenCalledExactlyOnceWith({
    content: [{ type: 'text', text: `Current draw.io diagram (Current drawing):\n${edited}` }],
  });
  resolveUpdate();
  await preparing;
  expect(settled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('#save')!.disabled).toBe(false);
});

test('first-send preparation rejects a failed native context update without discarding the diagram', async () => {
  await fixture.app.ontoolresult({ structuredContent: { xml: original } });
  fixture.update.mockRejectedValue(new Error('native context unavailable'));
  const preparing = fixture.prepare!();
  const rejected = expect(preparing).rejects.toThrow('native context unavailable');
  const commit = JSON.parse(posted.at(-1)!) as { requestId: string };
  const frame = document.querySelector<HTMLIFrameElement>('#editor')!.contentWindow!;
  const emit = (data: unknown) =>
    message(
      new MessageEvent('message', { source: frame, origin: 'null', data: JSON.stringify(data) }),
    );
  emit({ event: 'diagram-committed', requestId: commit.requestId });
  emit({ event: 'export', format: 'xml', xml: original, message: { requestId: commit.requestId } });
  await rejected;
  expect(loaded()).toHaveLength(1);
});
