import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readThreadImage } from './browserExtensionImage';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe('conversation image reads', () => {
  it.each([
    { role: 'tool_result', text: '![image](private.png)' },
    { role: 'tool_use', text: '', toolInput: { path: 'private.png' } },
    { role: 'assistant', text: '', toolInput: { path: 'private.png' } },
    { role: 'assistant', text: '', rawMessage: { metadata: { url: 'private.png' } } },
    {
      role: 'assistant',
      text: '',
      rawMessage: { content: [{ type: 'toolCall', arguments: { path: 'private.png' } }] },
    },
  ])('rejects paths only mentioned by tools or unrelated metadata: %j', async message => {
    await expect(readThreadImage('private.png', '', [message])).rejects.toThrow('not referenced');
  });
  it.each([
    { content: [{ type: 'image', source: { type: 'url', url: 'image.png' } }] },
    { content: [{ type: 'image_url', image_url: { url: 'image.png' } }] },
    { content: [{ type: 'attachment', attachment: { kind: 'image', url: 'image.png' } }] },
    { openclawDelivery: { mediaUrls: ['image.png'] } },
  ])('reads display image references: %j', async rawMessage => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'extension-image-'));
    directories.push(cwd);
    await writeFile(path.join(cwd, 'image.png'), 'image');
    expect(
      await readThreadImage('image.png', cwd, [{ role: 'assistant', text: '', rawMessage }]),
    ).toBe('data:image/png;base64,aW1hZ2U=');
  });
  it.each(['MEDIA: ./截图.png', '![shot](./截图.png)', '[media attached: ./截图.png (image/png)]'])(
    'reads only a referenced local image: %s',
    async text => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'extension-image-'));
      directories.push(cwd);
      await writeFile(path.join(cwd, '截图.png'), 'image');
      expect(await readThreadImage('./截图.png', cwd, [{ role: 'assistant', text }])).toBe(
        'data:image/png;base64,aW1hZ2U=',
      );
      await expect(
        readThreadImage('./private.png', cwd, [{ role: 'assistant', text }]),
      ).rejects.toThrow('not referenced');
    },
  );
  it('resolves encoded Markdown filenames with Chinese and spaces', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'extension-image-'));
    directories.push(cwd);
    await writeFile(path.join(cwd, '截图 1.png'), 'image');
    expect(
      await readThreadImage('./%E6%88%AA%E5%9B%BE%201.png', cwd, [
        { role: 'assistant', text: '![shot](<./截图 1.png>)' },
      ]),
    ).toContain('data:image/png;base64,');
  });

  it('accepts canonical native media but rejects oversized images and non-image files', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'extension-image-'));
    directories.push(cwd);
    await writeFile(path.join(cwd, 'large.png'), Buffer.alloc(20 * 1024 * 1024 + 1));
    const messages = [
      {
        role: 'user',
        text: '',
        rawMessage: { __openclaw: { media: [{ path: 'large.png' }, { path: 'secret.txt' }] } },
      },
    ];
    await expect(readThreadImage('large.png', cwd, messages)).rejects.toThrow('size limit');
    await expect(readThreadImage('secret.txt', cwd, messages)).rejects.toThrow('Unsupported');
  });
  it.each(['//server/share/image.png', '%5C%5Cserver%5Cshare%5Cimage.png'])(
    'rejects network paths even if referenced: %s',
    async source => {
      await expect(
        readThreadImage(source, '', [{ role: 'assistant', text: `MEDIA: ${source}` }]),
      ).rejects.toThrow('Network');
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'rejects a relative image in a network working directory',
    async () => {
      await expect(
        readThreadImage('image.png', '//server/share', [
          { role: 'assistant', text: 'MEDIA: image.png' },
        ]),
      ).rejects.toThrow('Network');
    },
  );
});
