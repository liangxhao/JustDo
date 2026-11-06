import * as fileSystem from 'node:fs/promises';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_SERVER_MAX_IMAGE_BYTES, prepareAppServerInput } from './appServerInput';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLFsAAAAASUVORK5CYII=', 'base64');
const url = `data:image/png;base64,${png.toString('base64')}`;
const image = { type: 'image', url };
const fixtureRoots: string[] = [];
const parent = path.resolve('build/test-dependencies');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of fixtureRoots.splice(0)) {
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('app-server-input-')) throw new Error('Invalid fixture directory.');
    await rm(root, { recursive: true, force: true });
  }
});

describe('standard media input preparation', () => {
  it('projects admitted native text normalization and preserves relative image order and actual bytes', async () => {
    const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const second = { type: 'image', url: `data:image/gif;base64,${gifBase64}` };
    const prepared = await prepareAppServerInput([
      { type: 'text', text: 'Before' }, image, { type: 'text', text: 'After' }, second,
    ], { cwd: '.' });
    expect(prepared.message).toBe('Before\nAfter');
    expect(prepared.content).toEqual([
      { type: 'text', text: 'Before\nAfter', text_elements: [] }, image, second,
    ]);
    expect(prepared.attachments).toEqual([
      { name: 'image-1.png', mimeType: 'image/png', base64Data: png.toString('base64') },
      { name: 'image-2.gif', mimeType: 'image/gif', base64Data: gifBase64 },
    ]);
  });

  it('accepts image-only input without creating text or a placeholder', async () => {
    expect(await prepareAppServerInput([image], { cwd: '.' })).toMatchObject({ message: '', content: [image] });
  });

  it('rejects empty input unless the host already validated separate attachments', async () => {
    await expect(prepareAppServerInput([], { cwd: '.' })).rejects.toMatchObject({ code: -32602 });
    await expect(prepareAppServerInput([], { cwd: '.', allowEmptyForAttachments: true })).resolves.toEqual({ message: '', attachments: [], content: [] });
  });

  it.each([
    [{ type: 'image', fileId: 'upload-id' }],
    [{ ...image, detail: 'high' }],
    [{ type: 'audio', url: 'data:audio/wav;base64,AAAA' }],
    [{ type: 'localAudio', path: 'audio.wav' }],
    [{ type: 'text', text: 'Text', text_elements: [{}] }],
    [{ type: 'image', url: 'data:image/png;base64,!!!!' }],
    [{ type: 'image', url: 'data:image/jpeg;base64,' + png.toString('base64') }],
    [{ type: 'image', url: 'data:image/png;base64,a===' }],
    [{ type: 'image', url: 'https://images.example/image.png' }],
  ])('rejects unsupported or invalid media without pretending to send it: %j', async input => {
    await expect(prepareAppServerInput(input, { cwd: '.' })).rejects.toMatchObject({ code: -32602 });
  });

  it('enforces image count and combined decoded byte limits', async () => {
    await expect(prepareAppServerInput(Array(6).fill(image), { cwd: '.' })).rejects.toMatchObject({ code: -32602 });
    const large = Buffer.alloc(APP_SERVER_MAX_IMAGE_BYTES + 1);
    png.copy(large);
    await expect(prepareAppServerInput([{ type: 'image', url: `data:image/png;base64,${large.toString('base64')}` }], { cwd: '.' }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(prepareAppServerInput([{ type: 'text', text: '\0'.repeat(2 * 1024 * 1024) }], { cwd: '.' }))
      .rejects.toMatchObject({ code: -32602 });
  });

  it('only opens local files when explicitly allowed inside the real bound directory', async () => {
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, 'app-server-input-'));
    fixtureRoots.push(root);
    await mkdir(path.join(root, 'cwd'));
    await writeFile(path.join(root, 'cwd', 'photo.png'), png);
    await writeFile(path.join(root, 'outside.png'), png);
    const cwd = path.join(root, 'cwd');
    await expect(prepareAppServerInput([{ type: 'localImage', path: 'photo.png' }], { cwd })).rejects.toMatchObject({ code: -32602 });
    const prepared = await prepareAppServerInput([{ type: 'localImage', path: 'photo.png' }], { cwd, allowLocalImages: true });
    expect(prepared.content).toEqual([image]);
    expect(JSON.stringify(prepared)).not.toContain(root);
    await expect(prepareAppServerInput([{ type: 'localImage', path: '../outside.png' }], { cwd, allowLocalImages: true }))
      .rejects.toMatchObject({ code: -32602 });
  });

  it('uses only the host fetch capability and revalidates its returned bytes', async () => {
    const fetchImage = vi.fn(async () => ({ bytes: png, mimeType: 'image/png' }));
    const prepared = await prepareAppServerInput([{ type: 'image', url: 'http://10.0.0.1/photo.png' }], { cwd: '.', fetchImage });
    expect(prepared.content).toEqual([image]);
    expect(fetchImage).toHaveBeenCalledWith('http://10.0.0.1/photo.png', { signal: undefined, maxBytes: APP_SERVER_MAX_IMAGE_BYTES });
    fetchImage.mockResolvedValueOnce({ bytes: png, mimeType: 'image/jpeg' });
    await expect(prepareAppServerInput([{ type: 'image', url: 'http://10.0.0.1/photo.png' }], { cwd: '.', fetchImage }))
      .rejects.toMatchObject({ code: -32602 });
  });

  it('rejects an opened file whose identity no longer matches the bound path', async () => {
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, 'app-server-input-'));
    fixtureRoots.push(root);
    const target = path.join(root, 'photo.png');
    await writeFile(target, png);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fileSystem.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      await rename(target, path.join(root, 'opened-original.png'));
      await writeFile(target, png);
      return handle;
    });
    await expect(prepareAppServerInput([{ type: 'localImage', path: 'photo.png' }], { cwd: root, allowLocalImages: true }))
      .rejects.toMatchObject({ code: -32602, message: 'localImage changed while it was being opened.' });
  });

  it('abandons late bytes when the caller withdraws during retrieval', async () => {
    const controller = new AbortController();
    const fetchImage = vi.fn(async () => { controller.abort(); return { bytes: png, mimeType: 'image/png' }; });
    await expect(prepareAppServerInput([{ type: 'image', url: 'http://10.0.0.1/photo.png' }], { cwd: '.', fetchImage, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
