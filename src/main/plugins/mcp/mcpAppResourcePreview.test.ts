import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type IncomingHttpHeaders,request } from 'node:http';

import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';

import { MCP_APP_PREVIEW_PART_MAX_BYTES } from '../../../shared/plugins/mcpAppResourcePreview';
import { MAX_PREVIEW_FILE_BYTES } from '../../../shared/preview/filePreview';
import { McpAppResourcePreviews } from './mcpAppResourcePreview';

function createOwner() {
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  return {
    sender,
    event: { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent,
  };
}

const bytes = Buffer.from('%PDF-1.7\nArchived bytes\n%%EOF');
function makeInput(file = bytes, name = '参考 #100%.pdf', mimeType = 'application/octet-stream') {
  return {
    name,
    mimeType,
    sha256: createHash('sha256').update(file).digest('hex'),
    parts: Array.from(
      { length: Math.ceil(file.length / MCP_APP_PREVIEW_PART_MAX_BYTES) },
      (_, index) => {
        const part = file.subarray(
          index * MCP_APP_PREVIEW_PART_MAX_BYTES,
          (index + 1) * MCP_APP_PREVIEW_PART_MAX_BYTES,
        );
        return { byteLength: part.length, blob: part.toString('base64') };
      },
    ),
  };
}

function readUrl(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }>(
    (resolve, reject) => {
      const outgoing = request(url, { method, headers, agent: false }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
        incoming.on('error', reject);
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode!,
            headers: incoming.headers,
            bytes: Buffer.concat(chunks),
          }),
        );
      });
      outgoing.on('error', reject);
      outgoing.end();
    },
  );
}

const managers = new Set<McpAppResourcePreviews>();
function manager(allowed: (event: IpcMainInvokeEvent) => boolean = () => true) {
  const instance = new McpAppResourcePreviews(allowed);
  managers.add(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all([...managers].map(instance => instance.dispose()));
  managers.clear();
});

describe('MCP App native resource preview', () => {
  it('serves immutable original bytes without a disk path and only lets their owner revoke them', async () => {
    const { event } = createOwner();
    const previews = manager();
    const input = makeInput();
    const staged = await previews.stage(event, input);
    input.parts[0].blob = Buffer.alloc(bytes.length, 0).toString('base64');
    expect(staged).toMatchObject({
      kind: 'pdf',
      version: makeInput().sha256,
      resourcePreview: { name: makeInput().name },
    });
    expect(staged.filePath).toBe(
      'mcp-resource://' + staged.resourcePreview.id + '/' + makeInput().name,
    );
    expect(new URL(staged.url!).hostname).toBe('127.0.0.1');
    expect(new URL(staged.url!).pathname).toMatch(/^\/[a-f0-9]{64}\//u);
    const response = await readUrl(staged.url!);
    expect(response.status).toBe(200);
    expect(response.bytes).toEqual(bytes);
    expect(response.headers).toMatchObject({
      'content-type': 'application/pdf',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
    });
    await previews.release(createOwner().event, staged.resourcePreview.id);
    expect((await readUrl(staged.url!)).status).toBe(200);
    await previews.release(event, staged.resourcePreview.id);
    expect((await readUrl(staged.url!)).status).toBe(404);
  });

  it('supports exact single ranges and HEAD for browser PDF and media loading', async () => {
    const staged = await manager().stage(createOwner().event, makeInput());
    for (const [range, start, end] of [
      ['bytes=2-7', 2, 7],
      ['bytes=3-', 3, bytes.length - 1],
      ['bytes=-5', bytes.length - 5, bytes.length - 1],
      ['bytes=2-9999', 2, bytes.length - 1],
    ] as const) {
      const response = await readUrl(staged.url!, { Range: range });
      expect(response.status).toBe(206);
      expect(response.bytes).toEqual(bytes.subarray(start, end + 1));
      expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${bytes.length}`);
    }
    const head = await readUrl(staged.url!, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.bytes.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(bytes.length));
    for (const Range of [
      'bytes=0-1,3-4',
      'bytes=-0',
      'bytes=9999-',
      'bytes=5-2',
      'bytes=-',
      'bytes=9007199254740992-',
    ]) {
      const response = await readUrl(staged.url!, { Range });
      expect(response.status).toBe(416);
      expect(response.headers['content-range']).toBe('bytes */' + bytes.length);
    }
  });

  it('accepts only the exact opaque path, loopback Host and read methods', async () => {
    const staged = await manager().stage(createOwner().event, makeInput());
    for (const url of [
      staged.url! + '?other',
      staged.url! + '/extra',
      new URL('/unknown', staged.url).href,
    ]) {
      expect((await readUrl(url)).status).toBe(404);
    }
    expect(
      (await readUrl(staged.url!, { Host: 'localhost:' + new URL(staged.url!).port })).status,
    ).toBe(404);
    expect((await readUrl(staged.url!, {}, 'POST')).status).toBe(404);
  });

  it('routes source text as read-only UTF-8 data and never serves active HTML', async () => {
    const previews = manager();
    for (const [name, content] of [
      ['Makefile', 'build:\n\tnode main.js\n'],
      ['document.html', '<script>window.test = true</script>'],
      ['参考.md', '# 原始 Markdown'],
    ]) {
      const staged = await previews.stage(
        createOwner().event,
        makeInput(Buffer.from(content), name, 'text/plain'),
      );
      expect(staged).toMatchObject({ kind: 'text', content });
      expect(staged.url).toBeUndefined();
    }
    for (const [file, name] of [
      [Buffer.from([0xff, 0xfe]), 'invalid.txt'],
      [Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1, 65), 'large.txt'],
      [Buffer.from('arbitrary binary'), 'document.docx'],
    ] as const) {
      const staged = await previews.stage(createOwner().event, makeInput(file, name));
      expect(staged.kind).toBe('unsupported');
      expect(staged.url).toBeUndefined();
      expect(staged.content).toBeUndefined();
    }
  });

  it('uses safe extensions and canonical MIME types for image, audio and video', async () => {
    const previews = manager();
    for (const [name, kind, mimeType] of [
      ['photo.PNG', 'image', 'image/png'],
      ['recording.mp3', 'audio', 'audio/mpeg'],
      ['movie.mp4', 'video', 'video/mp4'],
    ]) {
      const staged = await previews.stage(createOwner().event, makeInput(bytes, name, 'text/html'));
      const response = await readUrl(staged.url!);
      expect(staged.kind).toBe(kind);
      expect(response.headers['content-type']).toBe(mimeType);
      expect(response.bytes).toEqual(bytes);
    }
  });

  it('rejects invalid frames, names, MIME, hashes and noncanonical chunks before publishing', async () => {
    const { event } = createOwner();
    const previews = manager();
    const input = makeInput();
    await expect(previews.stage({ ...event, senderFrame: null }, input)).rejects.toThrow('window');
    await expect(manager(() => false).stage(event, input)).rejects.toThrow('window');
    for (const invalid of [
      { ...input, name: '../outside.pdf' },
      { ...input, mimeType: 'text/plain\r\n' },
      { ...input, parts: [{ byteLength: MCP_APP_PREVIEW_PART_MAX_BYTES + 1, blob: 'AA==' }] },
      { ...input, parts: [{ byteLength: 1, blob: 'AB==' }] },
      {
        ...input,
        parts: [...input.parts, ...input.parts, ...input.parts, ...input.parts, ...input.parts],
      },
    ])
      await expect(previews.stage(event, invalid)).rejects.toThrow('Invalid');
    await expect(previews.stage(event, { ...input, sha256: '0'.repeat(64) })).rejects.toThrow(
      'integrity',
    );
    const staged = await previews.stage(event, input);
    expect((await readUrl(staged.url!)).bytes).toEqual(bytes);
  });

  it('retains a current view across in-page and child navigation, then revokes on main navigation', async () => {
    const { sender, event } = createOwner();
    const previews = manager();
    const staged = await previews.stage(event, makeInput());
    sender.emit('did-start-navigation', {}, 'about:blank#child', false, false);
    sender.emit('did-start-navigation', {}, 'about:blank#in-place', true, true);
    expect((await readUrl(staged.url!)).status).toBe(200);
    sender.emit('did-start-navigation', {}, 'about:blank', false, true);
    expect((await readUrl(staged.url!)).status).toBe(404);
    expect(sender.listenerCount('did-start-navigation')).toBe(0);
  });

  it('rechecks frame identity and sender permission on every read', async () => {
    const { sender, event } = createOwner();
    let allowed = true;
    const staged = await manager(() => allowed).stage(event, makeInput());
    sender.mainFrame = {};
    expect((await readUrl(staged.url!)).status).toBe(404);
    sender.mainFrame = event.senderFrame!;
    allowed = false;
    expect((await readUrl(staged.url!)).status).toBe(404);
  });

  it('revokes previews and owner listeners when a renderer is lost or destroyed', async () => {
    const previews = manager();
    for (const reason of ['render-process-gone', 'destroyed']) {
      const { sender, event } = createOwner();
      const staged = await previews.stage(event, makeInput());
      sender.emit(reason);
      expect((await readUrl(staged.url!)).status).toBe(404);
      expect(sender.listenerCount('destroyed')).toBe(0);
    }
  });

  it('rejects a stale in-flight preparation and releases capacity for the new view', async () => {
    const { sender, event } = createOwner();
    const previews = manager();
    const pending = previews.stage(event, makeInput());
    await expect(previews.stage(event, makeInput())).rejects.toThrow('limit');
    sender.emit('did-start-navigation', {}, 'about:blank', false, true);
    await expect(pending).rejects.toThrow('window changed');
    const staged = await previews.stage(event, makeInput());
    expect((await readUrl(staged.url!)).bytes).toEqual(bytes);
  });

  it('bounds retained count without reserving binary capacity for unsupported originals', async () => {
    const previews = manager();
    const { event } = createOwner();
    const staged = [];
    const unsupported = makeInput(Buffer.alloc(MCP_APP_PREVIEW_PART_MAX_BYTES * 4, 65), 'archive.docx');
    for (let index = 0; index < 8; index++)
      staged.push(await previews.stage(event, unsupported));
    // These originals total 256 MiB, but no browser can read their discarded bytes.
    const pdf = await previews.stage(event, makeInput());
    expect((await readUrl(pdf.url!)).bytes).toEqual(bytes);
    staged.push(pdf);
    for (let index = staged.length; index < 64; index++)
      staged.push(await previews.stage(event, makeInput(bytes, 'data.txt')));
    await expect(previews.stage(event, makeInput())).rejects.toThrow('limit');
    await previews.release(event, staged[0].resourcePreview.id);
    await expect(previews.stage(event, makeInput())).resolves.toHaveProperty('kind', 'pdf');
  });

  it('drains retained previews and in-flight server startup during shutdown', async () => {
    const previews = manager();
    const pending = previews.stage(createOwner().event, makeInput());
    const closing = previews.dispose();
    await expect(pending).rejects.toThrow('window changed');
    await closing;
    await previews.dispose();
    await expect(previews.stage(createOwner().event, makeInput())).rejects.toThrow('unavailable');
  });
});
