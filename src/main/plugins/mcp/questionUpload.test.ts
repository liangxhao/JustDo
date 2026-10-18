import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readQuestionUploadFiles } from './questionUpload';

const roots: string[] = [];
const create = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-question-upload-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith('mcp-question-upload-')
    )
      throw new Error('Unexpected test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});
describe('native question upload admission', () => {
  it('keeps directory relative paths, binary bytes and MIME types', async () => {
    const root = await create();
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'data.json'), '{"fixture":true}');
    expect(await readQuestionUploadFiles([root])).toEqual([
      {
        name: 'data.json',
        relativePath: 'nested/data.json',
        mimeType: 'application/json',
        content: Buffer.from('{"fixture":true}').toString('base64'),
      },
    ]);
  });
  it('rejects directory links outside the selected root', async () => {
    const root = await create();
    const outside = await create();
    await fs.writeFile(path.join(outside, 'private.txt'), 'outside fixture');
    await fs.symlink(
      outside,
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(readQuestionUploadFiles([root])).rejects.toThrow('filesystem link');
  });
  it('rejects oversize files before reading their bytes', async () => {
    const root = await create();
    const file = path.join(root, 'large.bin');
    const handle = await fs.open(file, 'w');
    await handle.truncate(5 * 1024 * 1024 + 1);
    await handle.close();
    await expect(readQuestionUploadFiles([file])).rejects.toThrow('5 MiB');
  });
});
