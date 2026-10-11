import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Paths come from an explicit user attachment selection, never a model output. */
export async function stageDiscussionAttachments(
  cwd: string,
  id: string,
  paths: string[] = [],
): Promise<string[]> {
  if (!paths.length) return [];
  const root = await realpath(cwd);
  const directory = path.join(root, '.agent-tasks', 'team-discussions', id);
  await mkdir(directory, { recursive: true });
  const actualDirectory = await realpath(directory);
  const relative = path.relative(root, actualDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('teamDiscussionInvalidInput');
  const result: string[] = [];
  for (const [index, source] of paths.entries()) {
    if (!path.isAbsolute(source)) throw new Error('teamDiscussionInvalidInput');
    const info = await stat(source);
    if (!info.isFile() || info.size > 20 * 1024 * 1024)
      throw new Error('teamDiscussionAttachmentTooLarge');
    const target = path.join(actualDirectory, `${index}-${path.basename(source)}`);
    await copyFile(source, target, 1);
    result.push(target);
  }
  return result;
}
export async function discussionAttachmentFingerprint(paths: string[] = []): Promise<string> {
  const hashes: string[] = [];
  for (const file of paths) {
    const info = await stat(file);
    if (!info.isFile() || info.size > 20 * 1024 * 1024)
      throw new Error('teamDiscussionAttachmentTooLarge');
    const hash = createHash('sha256');
    let length = 0;
    for await (const bytes of createReadStream(file)) {
      length += bytes.length;
      if (length > 20 * 1024 * 1024) throw new Error('teamDiscussionAttachmentTooLarge');
      hash.update(bytes);
    }
    hashes.push(hash.digest('hex'));
  }
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}
