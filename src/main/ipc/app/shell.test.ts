import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { FilePreviewIpc, MAX_PREVIEW_FILE_BYTES } from '../../../shared/preview/filePreview';
import {
  WorkspaceFileMutationKind,
  WorkspaceFilesIpc,
  WorkspaceFileTransferMode,
} from '../../../shared/preview/workspaceFiles';
import { createLocalHtmlPreview } from '../../browser/preview/localHtmlPreviewServer';

const { ipcHandle, openExternal, writeFileClipboard, trashFile } = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  openExternal: vi.fn(),
  trashFile: vi.fn(async (_filePath: string) => {}),
  writeFileClipboard: vi.fn(async (paths: string[], mode: 'copy' | 'move') => ({
    paths,
    mode,
    revision: '1',
  })),
}));

vi.mock('../../core/filesystem/windowsFileClipboard', () => ({
  WindowsFileClipboard: class {
    write = writeFileClipboard;
    read = vi.fn(async () => ({ paths: [], mode: 'copy', revision: '0' }));
    paste = vi.fn();
    rename = vi.fn();
    trash = trashFile;
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcHandle },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal },
}));

import {
  authorizePreviewFileEdit,
  createPreviewFileVersion,
  isDownloadableImageUrl,
  listWorkspaceDirectory,
  readPreviewFile,
  registerShellHandlers,
  resolveShellOpenPath,
  resolveSystemOpenWithCommand,
  revokePreviewFileEdit,
  writePreviewFile,
} from './shell';

const temporaryDirectories: string[] = [];

beforeEach(() => {
  ipcHandle.mockClear();
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
  writeFileClipboard.mockClear();
  trashFile.mockReset().mockResolvedValue(undefined);
});

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

test('binds file clipboard writes to a validated window main frame and a Main-resolved workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-transfer-ipc-'));
  temporaryDirectories.push(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'source');
  const resolveWorkspaceRoot = vi.fn((sessionId: string) =>
    sessionId === 'session' ? root : null,
  );
  registerShellHandlers({ resolveWorkspaceRoot });
  const handler = ipcHandle.mock.calls.find(
    ([channel]) => channel === WorkspaceFilesIpc.WriteClipboard,
  )![1];
  const frame = {};
  const sender = { getType: () => 'window', mainFrame: frame, isDestroyed: () => false };
  const request = {
    sessionId: 'session',
    sourcePath: 'a.txt',
    mode: WorkspaceFileTransferMode.Copy,
  };
  for (const [event, payload] of [
    [{ sender: { ...sender, getType: () => 'webview' }, senderFrame: frame }, request],
    [{ sender, senderFrame: {} }, request],
    [
      { sender, senderFrame: frame },
      { ...request, sourcePath: '../outside' },
    ],
    [
      { sender, senderFrame: frame },
      { ...request, mode: 'delete' },
    ],
    [{ sender, senderFrame: frame }, null],
  ]) {
    expect(await handler(event, payload)).toMatchObject({ success: false });
  }
  expect(resolveWorkspaceRoot).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual(['a.txt']);

  await expect(handler({ sender, senderFrame: frame }, request)).resolves.toMatchObject({
    success: true,
  });
  expect(writeFileClipboard).toHaveBeenCalledWith(
    [path.join(root, 'a.txt')],
    WorkspaceFileTransferMode.Copy,
  );
  expect(fs.readdirSync(root)).toEqual(['a.txt']);
});

test('restricts every file clipboard bridge to a window main frame', async () => {
  registerShellHandlers();
  const frame = {};
  for (const channel of Object.values(WorkspaceFilesIpc)) {
    const handler = ipcHandle.mock.calls.find(([name]) => name === channel)![1];
    for (const event of [
      {
        sender: { getType: () => 'webview', mainFrame: frame, isDestroyed: () => false },
        senderFrame: frame,
      },
      {
        sender: { getType: () => 'window', mainFrame: frame, isDestroyed: () => false },
        senderFrame: {},
      },
    ])
      expect(await handler(event, {})).toMatchObject({ success: false });
  }
});

test('routes deletion exclusively to the system recycle bin after source validation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-mutation-ipc-'));
  temporaryDirectories.push(root);
  const filePath = path.join(root, 'a.txt');
  fs.writeFileSync(filePath, 'keep');
  registerShellHandlers({ resolveWorkspaceRoot: sessionId => sessionId === 'session' ? root : null });
  const prepare = ipcHandle.mock.calls.find(([name]) => name === WorkspaceFilesIpc.PrepareMutation)![1];
  const mutate = ipcHandle.mock.calls.find(([name]) => name === WorkspaceFilesIpc.Mutate)![1];
  const frame = {};
  const sender = { getType: () => 'window', mainFrame: frame, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  const target = { sessionId: 'session', relativePath: 'a.txt', kind: WorkspaceFileMutationKind.Trash };
  for (const payload of [null, {}, { ...target, relativePath: '' }, { ...target, relativePath: '../outside' }, { ...target, kind: 'remove' }]) {
    expect(await prepare(event, payload)).toMatchObject({ success: false });
    expect(await mutate(event, payload)).toMatchObject({ success: false });
  }
  expect(trashFile).not.toHaveBeenCalled();
  const preparation = await prepare(event, target);
  expect(preparation).toMatchObject({ success: true, value: { affectedPaths: [filePath] } });
  trashFile.mockRejectedValueOnce(new Error('Not recyclable'));
  expect(await mutate(event, { ...target, revision: preparation.value.revision })).toMatchObject({ success: false });
  expect(trashFile).toHaveBeenCalledExactlyOnceWith(filePath, {
    dev: fs.lstatSync(filePath, { bigint: true }).dev.toString(),
    ino: fs.lstatSync(filePath, { bigint: true }).ino.toString(),
    parentDev: fs.lstatSync(root, { bigint: true }).dev.toString(),
    parentIno: fs.lstatSync(root, { bigint: true }).ino.toString(),
  });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('keep');
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

test('lists workspace directories with folders first and stable relative paths', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-files-'));
  temporaryDirectories.push(workingDirectory);
  fs.mkdirSync(path.join(workingDirectory, 'src'));
  fs.writeFileSync(path.join(workingDirectory, 'README.md'), '# Readme', 'utf8');

  await expect(listWorkspaceDirectory(workingDirectory)).resolves.toEqual({
    success: true,
    entries: [
      {
        filePath: path.join(workingDirectory, 'src'),
        kind: 'directory',
        name: 'src',
        relativePath: 'src',
      },
      {
        filePath: path.join(workingDirectory, 'README.md'),
        kind: 'file',
        name: 'README.md',
        relativePath: 'README.md',
      },
    ],
    truncated: false,
  });
});

test('rejects workspace directory traversal outside the selected root', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-files-'));
  temporaryDirectories.push(workingDirectory);

  await expect(listWorkspaceDirectory(workingDirectory, '..')).resolves.toMatchObject({
    success: false,
    error: 'Workspace directory is outside the workspace root',
  });
});

test('does not expose symbolic links in workspace listings', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-files-'));
  temporaryDirectories.push(workingDirectory);
  const targetPath = path.join(workingDirectory, 'target.txt');
  const linkPath = path.join(workingDirectory, 'link.txt');
  fs.writeFileSync(targetPath, 'target', 'utf8');
  try {
    fs.symlinkSync(targetPath, linkPath, 'file');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return;
    throw error;
  }

  const result = await listWorkspaceDirectory(workingDirectory);

  expect(result.success).toBe(true);
  if (result.success) expect(result.entries.map(entry => entry.name)).toEqual(['target.txt']);
});

test('accepts a symbolic-link workspace root while keeping child links hidden', async () => {
  const parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-files-'));
  temporaryDirectories.push(parentDirectory);
  const targetDirectory = path.join(parentDirectory, 'target');
  const rootLink = path.join(parentDirectory, 'workspace-link');
  fs.mkdirSync(targetDirectory);
  fs.writeFileSync(path.join(targetDirectory, 'README.md'), '# Readme', 'utf8');
  try {
    fs.symlinkSync(targetDirectory, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return;
    throw error;
  }

  const result = await listWorkspaceDirectory(rootLink);

  expect(result.success).toBe(true);
  if (result.success) expect(result.entries.map(entry => entry.name)).toEqual(['README.md']);
});

test('caps large workspace listings and reports truncation', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-files-'));
  temporaryDirectories.push(workingDirectory);
  for (let index = 0; index < 2_001; index += 1) {
    fs.writeFileSync(path.join(workingDirectory, `file-${index}.txt`), '', 'utf8');
  }

  const result = await listWorkspaceDirectory(workingDirectory);

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.entries).toHaveLength(2_000);
    expect(result.truncated).toBe(true);
  }
});

test('binds workspace listing IPC to a main-process session root and window sender', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-files-'));
  temporaryDirectories.push(workingDirectory);
  fs.writeFileSync(path.join(workingDirectory, 'README.md'), '# Readme', 'utf8');
  registerShellHandlers({
    resolveWorkspaceRoot: sessionId => (sessionId === 'session-1' ? workingDirectory : null),
  });
  const registration = ipcHandle.mock.calls.find(
    ([channel]) => channel === 'shell:listWorkspaceDirectory',
  );
  expect(registration).toBeDefined();
  const handler = registration?.[1] as (
    event: { sender: { getType: () => string } },
    sessionId: string,
    relativeDirectory?: string,
  ) => Promise<unknown> | unknown;

  await expect(
    Promise.resolve(handler({ sender: { getType: () => 'webview' } }, 'session-1')),
  ).resolves.toMatchObject({ success: false, error: 'Access denied' });
  await expect(
    Promise.resolve(handler({ sender: { getType: () => 'window' } }, 'unknown-session')),
  ).resolves.toMatchObject({ success: false, error: 'Workspace session is unavailable' });
  await expect(
    Promise.resolve(handler({ sender: { getType: () => 'window' } }, 'session-1')),
  ).resolves.toMatchObject({ success: true });
});

test('rejects system app chooser requests from non-window senders', async () => {
  registerShellHandlers();
  const registration = ipcHandle.mock.calls.find(([channel]) => channel === 'shell:openPathWith');
  expect(registration).toBeDefined();
  const handler = registration?.[1] as (
    event: { sender: { getType: () => string } },
    filePath: string,
  ) => Promise<unknown> | unknown;

  await expect(
    Promise.resolve(handler({ sender: { getType: () => 'webview' } }, 'C:\\archive.zip')),
  ).resolves.toEqual({ success: false, error: 'Access denied' });
});

test('rejects unsafe external URL schemes and non-main-frame callers', async () => {
  registerShellHandlers();
  const registration = ipcHandle.mock.calls.find(([channel]) => channel === 'shell:openExternal');
  expect(registration).toBeDefined();
  const handler = registration?.[1] as (...args: unknown[]) => Promise<unknown>;
  const mainFrame = {};
  const trustedEvent = {
    sender: { getType: () => 'window', mainFrame },
    senderFrame: mainFrame,
  };

  await expect(handler(trustedEvent, 'file:///C:/Windows/System32/calc.exe')).resolves.toEqual({
    success: false,
    error: 'Access denied',
  });
  await expect(handler(trustedEvent, 'custom:payload')).resolves.toEqual({
    success: false,
    error: 'Access denied',
  });
  await expect(
    handler(
      { sender: { getType: () => 'window', mainFrame }, senderFrame: {} },
      'https://example.com/',
    ),
  ).resolves.toEqual({ success: false, error: 'Access denied' });
  expect(openExternal).not.toHaveBeenCalled();
});

test('opens only a registered local HTML preview with its query and fragment', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-html-external-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'quarterly #100%.html');
  fs.writeFileSync(filePath, '<p>Report</p>');
  const preview = await createLocalHtmlPreview(filePath);
  expect(preview.success).toBe(true);
  if (!preview.success) return;
  registerShellHandlers();
  const registration = ipcHandle.mock.calls.find(
    ([channel]) => channel === 'shell:openLocalHtmlExternal',
  );
  expect(registration).toBeDefined();
  const handler = registration?.[1] as (...args: unknown[]) => Promise<unknown>;
  const mainFrame = {};

  await expect(
    handler(
      { sender: { getType: () => 'window', mainFrame }, senderFrame: mainFrame },
      `${preview.url}?mode=3d#camera`,
    ),
  ).resolves.toEqual({ success: true });
  const openedUrl = new URL(openExternal.mock.calls[0]?.[0] as string);
  expect(decodeURIComponent(openedUrl.pathname)).toContain('quarterly #100%.html');
  expect(openedUrl.search).toBe('?mode=3d');
  expect(openedUrl.hash).toBe('#camera');
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

test.each([
  ['notes.md', '# Notes\n'],
  ['orders.jsonl', '{"order":1}\n{"order":2}\n'],
])('reads %s for preview without changing its contents', async (fileName, content) => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, fileName);
  fs.writeFileSync(filePath, content, 'utf8');

  await expect(readPreviewFile(filePath)).resolves.toEqual(
    expect.objectContaining({
      success: true,
      content,
      editToken: expect.any(String),
      filePath,
      version: createPreviewFileVersion(content),
    }),
  );
});

test('returns a structured unsupported result for a non-previewable file', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-preview-'));
  temporaryDirectories.push(workingDirectory);
  const filePath = path.join(workingDirectory, 'archive.zip');
  fs.writeFileSync(filePath, 'not-used', 'utf8');

  await expect(readPreviewFile(filePath)).resolves.toEqual({
    success: false,
    unsupportedType: true,
  });
});

test('prepares a PDF larger than the text limit as an original file URL without text or edit grants', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, '地球 #100%.PDF');
  fs.writeFileSync(filePath, Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1024));
  const canonicalPath = fs.realpathSync(filePath);
  const expectedUrl = pathToFileURL(canonicalPath);
  expectedUrl.hash = 'page=2';
  const sourceUrl = pathToFileURL(filePath);
  sourceUrl.hash = 'page=2';

  await expect(readPreviewFile(sourceUrl.href)).resolves.toEqual({
    success: true,
    kind: 'pdf',
    filePath: canonicalPath,
    url: expectedUrl.href,
  });
  await expect(readPreviewFile(path.basename(filePath), directory)).resolves.toEqual({
    success: true,
    kind: 'pdf',
    filePath: canonicalPath,
    url: pathToFileURL(canonicalPath).href,
  });
});

test('rejects missing PDFs and directories before returning a browser preview', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-'));
  temporaryDirectories.push(directory);
  const folder = path.join(directory, 'folder.pdf');
  fs.mkdirSync(folder);
  await expect(readPreviewFile(folder)).resolves.toMatchObject({ success: false });
  await expect(readPreviewFile('missing.pdf', directory)).resolves.toEqual({
    success: false,
    notFound: true,
  });
});

test.each([
  ['sound.mp3', 'audio'],
  ['sound.wav', 'audio'],
  ['sound.flac', 'audio'],
  ['sound.opus', 'audio'],
  ['movie.mp4', 'video'],
  ['movie.webm', 'video'],
  ['movie.mkv', 'video'],
])('prepares %s without decoding it as text or creating an edit grant', async (fileName, kind) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-preview-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1024));
  const canonicalPath = fs.realpathSync(filePath);
  await expect(readPreviewFile(filePath)).resolves.toEqual({
    success: true,
    kind,
    filePath: canonicalPath,
    url: pathToFileURL(canonicalPath).href,
  });
});

test.each([
  'table.tsv',
  'records.ndjson',
  'captions.srt',
  'changes.patch',
  'component.vue',
  'component.svelte',
  'config.cfg',
  'notebook.ipynb',
])('opens %s as editable source without executing or converting it', async fileName => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preview-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, 'source text', 'utf8');
  await expect(readPreviewFile(filePath)).resolves.toMatchObject({
    success: true,
    content: 'source text',
    editToken: expect.any(String),
  });
});

test('only allows validated file preview requests from a window main frame', async () => {
  registerShellHandlers();
  const handler = ipcHandle.mock.calls.find(([channel]) => channel === FilePreviewIpc.Read)![1];
  const mainFrame = {};
  const sender = { id: 11, getType: () => 'window', mainFrame };
  for (const [event, filePath, directory] of [
    [{ sender: { ...sender, getType: () => 'webview' }, senderFrame: mainFrame }, 'report.pdf'],
    [{ sender, senderFrame: {} }, 'report.pdf'],
    [{ sender, senderFrame: mainFrame }, { path: 'report.pdf' }],
    [{ sender, senderFrame: mainFrame }, 'report.pdf', 42],
  ]) {
    await expect(Promise.resolve(handler(event, filePath, directory))).resolves.toEqual({
      success: false,
      error: 'Access denied',
    });
  }
  await expect(
    handler({ sender, senderFrame: mainFrame }, path.join(os.tmpdir(), 'missing-document.pdf')),
  ).resolves.toEqual({ success: false, notFound: true });
});

test('builds the Windows system app chooser command without shell interpolation', () => {
  expect(
    resolveSystemOpenWithCommand('C:\\workspace with spaces\\archive.zip', 'win32', 'C:\\Windows'),
  ).toEqual({
    command: 'C:\\Windows\\System32\\rundll32.exe',
    args: ['shell32.dll,OpenAs_RunDLL', 'C:\\workspace with spaces\\archive.zip'],
  });
  expect(resolveSystemOpenWithCommand('/tmp/archive.zip', 'linux')).toBeNull();
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

test.each(['notes.txt#payload', 'unsupported.docx'])(
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
