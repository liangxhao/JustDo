import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
}));

import {
  authorizePreviewFileEdit,
  createPreviewFileVersion,
  isDownloadableImageUrl,
  readPreviewFile,
  resolveShellOpenPath,
  revokePreviewFileEdit,
  writePreviewFile,
} from './shell';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps an absolute attachment path unchanged', () => {
  const absolutePath = path.resolve('existing', 'report.pdf');

  expect(resolveShellOpenPath(absolutePath, path.resolve('workspace'))).toBe(absolutePath);
});

test('resolves an existing relative attachment path against the session working directory', () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-media-'));
  temporaryDirectories.push(workingDirectory);
  const relativePath = path.join('output', 'report.pdf');
  const absolutePath = path.join(workingDirectory, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, 'report');

  expect(resolveShellOpenPath(relativePath, workingDirectory)).toBe(absolutePath);
});

test('keeps a missing relative attachment path unchanged', () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-media-'));
  temporaryDirectories.push(workingDirectory);
  const relativePath = path.join('missing', 'report.pdf');

  expect(resolveShellOpenPath(relativePath, workingDirectory)).toBe(relativePath);
});

test.each([
  'https://example.com/image.png',
  'data:image/png;base64,YWJj',
  'blob:file:///generated-image',
  'localfile:///C:/workspace/image.png',
  'file:///tmp/image.png',
])('allows saving a rendered image URL with a supported protocol: %s', imageUrl => {
  expect(isDownloadableImageUrl(imageUrl)).toBe(true);
});

test.each([
  'javascript:alert(1)',
  'data:text/html;base64,YWJj',
  '/relative/image.png',
  'not a URL',
])('rejects an unsupported image download URL: %s', imageUrl => {
  expect(isDownloadableImageUrl(imageUrl)).toBe(false);
});

test('reads a previewable file with a stable content version', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.md');
  fs.writeFileSync(filePath, '# Notes\n', 'utf8');

  await expect(readPreviewFile(filePath)).resolves.toEqual(
    expect.objectContaining({
      success: true,
      content: '# Notes\n',
      editToken: expect.any(String),
      filePath,
      version: createPreviewFileVersion('# Notes\n'),
    }),
  );
});

test('reads and writes an expanded previewable source file', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'main.ts');
  fs.writeFileSync(filePath, 'export const before = true;\n', 'utf8');
  const preview = await readPreviewFile(filePath, undefined, 11);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');

  await expect(
    authorizePreviewFileEdit(
      { editToken: preview.editToken, expectedVersion: preview.version },
      { ownerId: 11 },
    ),
  ).resolves.toEqual({ success: true });
  await expect(
    writePreviewFile(
      {
        content: 'export const after = true;\n',
        editToken: preview.editToken,
        expectedVersion: preview.version,
      },
      { ownerId: 11 },
    ),
  ).resolves.toEqual({
    success: true,
    version: createPreviewFileVersion('export const after = true;\n'),
  });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('export const after = true;\n');
});

test('writes a previewable file when its expected version is current', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.txt');
  fs.writeFileSync(filePath, 'before', 'utf8');
  const preview = await readPreviewFile(filePath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');

  const result = await writePreviewFile({
    content: 'after',
    editToken: preview.editToken,
    expectedVersion: preview.version,
  });

  expect(result).toEqual({ success: true, version: createPreviewFileVersion('after') });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('after');
});

test('rejects a stale save without changing the externally modified file', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'config.json');
  fs.writeFileSync(filePath, '{"original":true}', 'utf8');
  const preview = await readPreviewFile(filePath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  fs.writeFileSync(filePath, '{"external":true}', 'utf8');

  const result = await writePreviewFile({
    content: '{"draft":true}',
    editToken: preview.editToken,
    expectedVersion: preview.version,
  });

  expect(result).toEqual({ success: false, conflict: true });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('{"external":true}');
});

test('ignores renderer-supplied path and overwrite fields', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const grantedPath = path.join(workingDirectory, 'granted.txt');
  const injectedPath = path.join(workingDirectory, 'injected.txt');
  fs.writeFileSync(grantedPath, 'original', 'utf8');
  fs.writeFileSync(injectedPath, 'protected', 'utf8');
  const preview = await readPreviewFile(grantedPath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  fs.writeFileSync(grantedPath, 'external', 'utf8');

  const injectedRequest = {
    content: 'draft',
    editToken: preview.editToken,
    expectedVersion: preview.version,
    filePath: injectedPath,
    overwrite: true,
  };

  const result = await writePreviewFile(injectedRequest);

  expect(result).toEqual({ success: false, conflict: true });
  expect(fs.readFileSync(grantedPath, 'utf8')).toBe('external');
  expect(fs.readFileSync(injectedPath, 'utf8')).toBe('protected');
});

test('overwrites an externally modified file only when explicitly requested', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'config.json');
  fs.writeFileSync(filePath, '{"original":true}', 'utf8');
  const preview = await readPreviewFile(filePath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  fs.writeFileSync(filePath, '{"external":true}', 'utf8');
  const resolveConflict = vi.fn(async () => 'overwrite' as const);

  const result = await writePreviewFile(
    {
      content: '{"draft":true}',
      editToken: preview.editToken,
      expectedVersion: preview.version,
    },
    { resolveConflict },
  );

  expect(resolveConflict).toHaveBeenCalledWith(filePath);
  expect(result).toEqual({
    success: true,
    version: createPreviewFileVersion('{"draft":true}'),
  });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('{"draft":true}');
});

test('reloads instead of overwriting when the native conflict decision requests it', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.md');
  fs.writeFileSync(filePath, 'original', 'utf8');
  const preview = await readPreviewFile(filePath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  fs.writeFileSync(filePath, 'external', 'utf8');

  const result = await writePreviewFile(
    {
      content: 'draft',
      editToken: preview.editToken,
      expectedVersion: preview.version,
    },
    { resolveConflict: async () => 'reload' },
  );

  expect(result).toEqual({ success: false, conflict: true, reload: true });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('external');
});

test('does not recreate a file deleted after it was previewed', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.md');
  fs.writeFileSync(filePath, 'before', 'utf8');
  const preview = await readPreviewFile(filePath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  fs.unlinkSync(filePath);

  const result = await writePreviewFile({
    content: 'after',
    editToken: preview.editToken,
    expectedVersion: preview.version,
  });

  expect(result).toEqual({ success: false, notFound: true });
  expect(fs.existsSync(filePath)).toBe(false);
});

test.each(['notes.txt#payload', 'unsupported.pdf'])(
  'rejects a real file whose exact extension is unsupported: %s',
  async fileName => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
    temporaryDirectories.push(workingDirectory);
    const filePath = path.join(workingDirectory, fileName);
    fs.writeFileSync(filePath, 'content', 'utf8');

    const result = await readPreviewFile(filePath);

    expect(result.success).toBe(false);
  },
);

test('rejects a write without a valid path-bound edit token', async () => {
  const result = await writePreviewFile({
    content: 'after',
    editToken: 'invalid-token',
    expectedVersion: createPreviewFileVersion('before'),
  });

  expect(result).toEqual({ success: false, error: 'Preview edit grant is invalid or expired' });
});

test('binds an edit token to the renderer that requested the preview', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.txt');
  fs.writeFileSync(filePath, 'before', 'utf8');
  const preview = await readPreviewFile(filePath, undefined, 11);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');

  const result = await writePreviewFile(
    {
      content: 'after',
      editToken: preview.editToken,
      expectedVersion: preview.version,
    },
    { ownerId: 12 },
  );

  expect(result).toEqual({
    success: false,
    error: 'Preview edit grant belongs to another renderer',
  });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('before');
});

test('requires Main validation before a renderer-owned token can write', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.txt');
  fs.writeFileSync(filePath, 'before', 'utf8');
  const preview = await readPreviewFile(filePath, undefined, 11);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  const request = {
    content: 'after',
    editToken: preview.editToken,
    expectedVersion: preview.version,
  };

  await expect(writePreviewFile(request, { ownerId: 11 })).resolves.toMatchObject({
    success: false,
    unauthorized: true,
  });
  await expect(
    authorizePreviewFileEdit(
      { editToken: preview.editToken, expectedVersion: preview.version },
      { ownerId: 11 },
    ),
  ).resolves.toEqual({ success: true });
  await expect(writePreviewFile(request, { ownerId: 11 })).resolves.toEqual({
    success: true,
    version: createPreviewFileVersion('after'),
  });

  expect(fs.readFileSync(filePath, 'utf8')).toBe('after');
});

test('requests a reload when an edit authorization token is no longer available', async () => {
  const result = await authorizePreviewFileEdit(
    { editToken: 'expired-token', expectedVersion: createPreviewFileVersion('before') },
    { ownerId: 11 },
  );

  expect(result).toEqual({
    success: false,
    error: 'Preview edit grant is invalid or expired',
    reload: true,
  });
});

test('revokes an authorized edit token when its drawer closes', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.txt');
  fs.writeFileSync(filePath, 'before', 'utf8');
  const preview = await readPreviewFile(filePath, undefined, 11);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  await authorizePreviewFileEdit(
    { editToken: preview.editToken, expectedVersion: preview.version },
    { ownerId: 11 },
  );

  revokePreviewFileEdit(preview.editToken, 11);
  const result = await writePreviewFile(
    {
      content: 'after',
      editToken: preview.editToken,
      expectedVersion: preview.version,
    },
    { ownerId: 11 },
  );

  expect(result).toEqual({ success: false, error: 'Preview edit grant is invalid or expired' });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('before');
});

test('rejects files and drafts larger than the preview limit', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.txt');
  fs.writeFileSync(filePath, 'before', 'utf8');
  const preview = await readPreviewFile(filePath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  const oversizedContent = 'x'.repeat(2 * 1024 * 1024 + 1);

  const writeResult = await writePreviewFile({
    content: oversizedContent,
    editToken: preview.editToken,
    expectedVersion: preview.version,
  });
  fs.writeFileSync(filePath, oversizedContent, 'utf8');
  const readResult = await readPreviewFile(filePath);

  expect(writeResult).toMatchObject({ success: false, tooLarge: true });
  expect(readResult).toMatchObject({ success: false, tooLarge: true });
});

test('rejects a file that grows past the limit after the initial path check', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.txt');
  fs.writeFileSync(filePath, 'small', 'utf8');
  const originalLstat = fs.promises.lstat.bind(fs.promises);
  let targetLstatCalls = 0;
  vi.spyOn(fs.promises, 'lstat').mockImplementation(async targetPath => {
    const stats = await originalLstat(targetPath);
    if (targetPath === filePath && ++targetLstatCalls === 2) {
      fs.writeFileSync(filePath, 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8');
    }
    return stats;
  });

  const result = await readPreviewFile(filePath);

  expect(result).toMatchObject({ success: false, tooLarge: true });
});

test('returns a write error without replacing the existing file', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.md');
  fs.writeFileSync(filePath, 'before', 'utf8');
  const preview = await readPreviewFile(filePath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EACCES'));

  const result = await writePreviewFile({
    content: 'after',
    editToken: preview.editToken,
    expectedVersion: preview.version,
  });

  expect(result).toEqual({ success: false, error: 'EACCES' });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('before');
  expect(renameSpy).toHaveBeenCalledOnce();
});

test('does not report success when the file changes immediately after replacement', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'notes.md');
  fs.writeFileSync(filePath, 'before', 'utf8');
  const preview = await readPreviewFile(filePath);
  if (!preview.success) throw new Error('Expected the fixture to be previewable');
  const originalRename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (oldPath, newPath) => {
    await originalRename(oldPath, newPath);
    fs.writeFileSync(filePath, 'external-after-replace', 'utf8');
  });

  const result = await writePreviewFile({
    content: 'draft',
    editToken: preview.editToken,
    expectedVersion: preview.version,
  });

  expect(result).toEqual({ success: false, conflict: true });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('external-after-replace');
});

test('rejects symbolic-link preview paths when the platform allows creating one', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const targetPath = path.join(workingDirectory, 'target.md');
  const linkPath = path.join(workingDirectory, 'link.md');
  fs.writeFileSync(targetPath, 'target', 'utf8');
  try {
    fs.symlinkSync(targetPath, linkPath, 'file');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return;
    throw error;
  }

  const result = await readPreviewFile(linkPath);

  expect(result).toEqual({ success: false, error: 'Preview file must be a regular file' });
});
