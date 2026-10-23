import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import {
  type WorkspaceFileClipboardSnapshot,
  type WorkspaceFileClipboardWriteRequest,
  WorkspaceFileMutationKind,
  type WorkspaceFileMutationRequest,
  type WorkspaceFileMutationTarget,
  type WorkspaceFilePasteRequest,
  WorkspaceFileTransferMode,
} from '../../../shared/preview/workspaceFiles';
import { WorkspaceFileOperations } from './workspaceFiles';

const directories: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-files-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-files-'));
  directories.push(root, external);
  fs.mkdirSync(path.join(root, 'target'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'workspace');
  fs.writeFileSync(path.join(external, 'b.txt'), 'external');
  let clipboard: WorkspaceFileClipboardSnapshot = {
    paths: [path.join(external, 'b.txt')],
    mode: WorkspaceFileTransferMode.Copy,
    revision: '1',
  };
  const trash = vi.fn(async (_filePath: string) => {});
  const native = {
    trash,
    read: vi.fn(async () => ({ ...clipboard, paths: [...clipboard.paths] })),
    write: vi.fn(async (paths: string[], mode: WorkspaceFileTransferMode) => {
      clipboard = { paths, mode, revision: String(Number(clipboard.revision) + 1) };
      return clipboard;
    }),
    paste: vi.fn(async () => ({ cancelled: false, clipboard })),
    rename: vi.fn(async (source: string, newName: string) => {
      fs.renameSync(source, path.join(path.dirname(source), newName));
    }),
  };
  let selectedRoot = root;
  const service = new WorkspaceFileOperations(
    sessionId => (sessionId === 'session' ? selectedRoot : null),
    native,
  );
  const target = { sessionId: 'session', targetDirectory: 'target' };
  const prepare = async () => {
    const result = await service.prepare(target, () => true);
    if (!result.success) throw new Error('Expected paste preparation');
    return result.value;
  };
  const request = async (): Promise<WorkspaceFilePasteRequest> => {
    const prepared = await prepare();
    return {
      ...target,
      clipboardRevision: prepared.clipboard.revision,
      destinationRevision: prepared.destinationRevision,
    };
  };
  return {
    root,
    external,
    native,
    trash,
    service,
    target,
    prepare,
    request,
    setClipboard: (next: WorkspaceFileClipboardSnapshot) => {
      clipboard = next;
    },
    setRoot: (value: string) => {
      selectedRoot = value;
    },
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const mutationRequest = async (
  service: WorkspaceFileOperations,
  target: WorkspaceFileMutationTarget,
): Promise<WorkspaceFileMutationRequest> => {
  const preparation = await service.prepareMutation(target, () => true);
  if (!preparation.success) throw new Error('Expected mutation preparation');
  return { ...target, revision: preparation.value.revision };
};

test('creates one named folder in the selected directory without touching clipboard data', async () => {
  const { service, root, native, trash } = fixture();
  const target = {
    sessionId: 'session',
    kind: WorkspaceFileMutationKind.CreateDirectory,
    relativePath: 'target',
    newName: '项目 资料',
  };
  const request = await mutationRequest(service, target);
  expect(await service.mutate(request, () => true)).toEqual({
    success: true,
    value: { relativePath: 'target/项目 资料' },
  });
  expect(fs.statSync(path.join(root, 'target', '项目 资料')).isDirectory()).toBe(true);
  expect(native.read).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
  expect(trash).not.toHaveBeenCalled();
});

test('renames a directory and guards all previews beneath the original directory', async () => {
  const { service, root, native } = fixture();
  fs.writeFileSync(path.join(root, 'target', 'child.txt'), 'kept');
  const target = {
    sessionId: 'session',
    kind: WorkspaceFileMutationKind.Rename,
    relativePath: 'target',
    newName: 'renamed',
  };
  expect(await service.prepareMutation(target, () => true)).toMatchObject({
    success: true,
    value: { affectedPaths: [path.join(root, 'target')] },
  });
  expect(await service.mutate(await mutationRequest(service, target), () => true)).toEqual({
    success: true,
    value: { relativePath: 'renamed' },
  });
  expect(native.rename).toHaveBeenCalledExactlyOnceWith(path.join(root, 'target'), 'renamed', {
    dev: fs.lstatSync(path.join(root, 'renamed'), { bigint: true }).dev.toString(),
    ino: fs.lstatSync(path.join(root, 'renamed'), { bigint: true }).ino.toString(),
    parentDev: fs.lstatSync(root, { bigint: true }).dev.toString(),
    parentIno: fs.lstatSync(root, { bigint: true }).ino.toString(),
  });
  expect(fs.readFileSync(path.join(root, 'renamed', 'child.txt'), 'utf8')).toBe('kept');
});

test('uses only the system recycle bin and leaves files intact when recycling fails', async () => {
  const { service, root, trash, native } = fixture();
  const target = {
    sessionId: 'session',
    kind: WorkspaceFileMutationKind.Trash,
    relativePath: 'a.txt',
  };
  const request = await mutationRequest(service, target);
  expect(await service.prepareMutation(target, () => true)).toMatchObject({
    success: true,
    value: { affectedPaths: [path.join(root, 'a.txt')] },
  });
  trash.mockRejectedValueOnce(new Error('Volume has no recycle bin'));
  expect(await service.mutate(request, () => true)).toMatchObject({ success: false });
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('workspace');
  expect(trash).toHaveBeenCalledExactlyOnceWith(path.join(root, 'a.txt'), {
    dev: fs.lstatSync(path.join(root, 'a.txt'), { bigint: true }).dev.toString(),
    ino: fs.lstatSync(path.join(root, 'a.txt'), { bigint: true }).ino.toString(),
    parentDev: fs.lstatSync(root, { bigint: true }).dev.toString(),
    parentIno: fs.lstatSync(root, { bigint: true }).ino.toString(),
  });
  expect(native.rename).not.toHaveBeenCalled();
  expect(await service.mutate(request, () => true)).toMatchObject({ success: true });
  expect(trash).toHaveBeenCalledTimes(2);
});

test.each([WorkspaceFileMutationKind.Rename, WorkspaceFileMutationKind.CreateDirectory])(
  'rejects a name collision before %s and after preparation without changing the existing file',
  async kind => {
    const { service, root, native } = fixture();
    const target = {
      sessionId: 'session',
      kind,
      relativePath: kind === 'rename' ? 'a.txt' : '',
      newName: 'b.txt',
    };
    const request = await mutationRequest(service, target);
    fs.writeFileSync(path.join(root, 'b.txt'), 'existing');
    expect(await service.prepareMutation(target, () => true)).toMatchObject({
      success: false,
      code: 'already-exists',
    });
    expect(await service.mutate(request, () => true)).toMatchObject({
      success: false,
      code: 'already-exists',
    });
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('existing');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('workspace');
    expect(native.rename).not.toHaveBeenCalled();
  },
);

test('treats an unchanged filename as a no-op without closing previews', async () => {
  const { service, native } = fixture();
  const target = {
    sessionId: 'session',
    kind: WorkspaceFileMutationKind.Rename,
    relativePath: 'a.txt',
    newName: 'a.txt',
  };
  expect(await service.prepareMutation(target, () => true)).toMatchObject({
    success: true,
    value: { affectedPaths: [] },
  });
  expect(await service.mutate(await mutationRequest(service, target), () => true)).toMatchObject({
    success: true,
  });
  expect(native.rename).not.toHaveBeenCalled();
});

test.each([
  '',
  '.',
  '..',
  '../escape',
  'a/b',
  'a\\b',
  'C:stream',
  'NUL.txt',
  'COM¹',
  'name.',
  'name ',
  'a?b',
  'a\0b',
])('rejects invalid folder names %j without making a mutation', async newName => {
  const { service, native, trash } = fixture();
  const target = {
    sessionId: 'session',
    kind: WorkspaceFileMutationKind.CreateDirectory,
    relativePath: '',
    newName,
  };
  expect(await service.prepareMutation(target, () => true)).toMatchObject({ success: false });
  expect(await service.mutate({ ...target, revision: 'fake' }, () => true)).toMatchObject({
    success: false,
  });
  expect(native.rename).not.toHaveBeenCalled();
  expect(trash).not.toHaveBeenCalled();
});

test.each([
  '',
  '../a.txt',
  '.. ',
  'target/.. ',
  'a.txt.',
  'a.txt:stream',
  '/absolute',
  'C:\\outside',
])('rejects unsafe delete sources %j and cannot recycle the workspace root', async relativePath => {
  const { service, trash } = fixture();
  const target = { sessionId: 'session', kind: WorkspaceFileMutationKind.Trash, relativePath };
  expect(await service.prepareMutation(target, () => true)).toMatchObject({ success: false });
  expect(await service.mutate({ ...target, revision: 'fake' }, () => true)).toMatchObject({
    success: false,
  });
  expect(trash).not.toHaveBeenCalled();
});

test('does not mutate a replaced source, a switched workspace, or a vanished caller', async () => {
  const { service, root, external, native, trash, setRoot } = fixture();
  const target = {
    sessionId: 'session',
    kind: WorkspaceFileMutationKind.Trash,
    relativePath: 'a.txt',
  };
  const request = await mutationRequest(service, target);
  fs.renameSync(path.join(root, 'a.txt'), path.join(root, 'original.txt'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'replacement');
  expect(await service.mutate(request, () => true)).toMatchObject({ success: false });
  const updated = await mutationRequest(service, target);
  setRoot(external);
  fs.writeFileSync(path.join(external, 'a.txt'), 'another-workspace');
  expect(await service.mutate(updated, () => true)).toMatchObject({ success: false });
  setRoot(root);
  expect(await service.mutate(updated, () => false)).toMatchObject({ success: false });
  expect(native.rename).not.toHaveBeenCalled();
  expect(trash).not.toHaveBeenCalled();
});

test('rejects source and create-parent directory junctions for mutations', async () => {
  const { service, root, external, trash, native } = fixture();
  fs.symlinkSync(
    external,
    path.join(root, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const target of [
    { sessionId: 'session', kind: WorkspaceFileMutationKind.Trash, relativePath: 'link' },
    {
      sessionId: 'session',
      kind: WorkspaceFileMutationKind.Rename,
      relativePath: 'link',
      newName: 'renamed',
    },
    {
      sessionId: 'session',
      kind: WorkspaceFileMutationKind.CreateDirectory,
      relativePath: 'link',
      newName: 'new',
    },
  ]) {
    expect(await service.prepareMutation(target, () => true)).toMatchObject({ success: false });
  }
  expect(trash).not.toHaveBeenCalled();
  expect(native.rename).not.toHaveBeenCalled();
});

test('shares the paste operation queue and rechecks a queued mutation identity before execution', async () => {
  const { service, root, native, request, trash } = fixture();
  let finish!: (value: { cancelled: boolean; clipboard: WorkspaceFileClipboardSnapshot }) => void;
  native.paste.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const first = service.paste(await request(), '0', () => true);
  await vi.waitFor(() => expect(native.paste).toHaveBeenCalledOnce());
  const target = {
    sessionId: 'session',
    kind: WorkspaceFileMutationKind.Trash,
    relativePath: 'a.txt',
  };
  const next = service.mutate(await mutationRequest(service, target), () => true);
  await Promise.resolve();
  expect(trash).not.toHaveBeenCalled();
  fs.renameSync(path.join(root, 'a.txt'), path.join(root, 'old.txt'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'replacement');
  finish({ cancelled: false, clipboard: { paths: [], mode: 'copy', revision: '2' } });
  expect(await first).toMatchObject({ success: true });
  expect(await next).toMatchObject({ success: false });
  expect(trash).not.toHaveBeenCalled();
});

test('writes a selected workspace file to the operating system clipboard without moving it', async () => {
  const { root, service, native } = fixture();
  await expect(
    service.write(
      { sessionId: 'session', sourcePath: 'a.txt', mode: WorkspaceFileTransferMode.Move },
      () => true,
    ),
  ).resolves.toMatchObject({ success: true });
  expect(native.write).toHaveBeenCalledWith(
    [path.join(root, 'a.txt')],
    WorkspaceFileTransferMode.Move,
  );
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('workspace');
});

test.each([
  '../outside',
  '/absolute',
  'C:\\outside',
  'C:relative',
  '\\\\server\\share',
  'file.txt:stream',
  '.',
  '',
  'a/../../b',
  'a\u0000b',
])('rejects invalid copy/cut source %j', async sourcePath => {
  const { service, native } = fixture();
  await expect(
    service.write(
      { sessionId: 'session', sourcePath, mode: WorkspaceFileTransferMode.Copy },
      () => true,
    ),
  ).resolves.toMatchObject({ success: false });
  expect(native.write).not.toHaveBeenCalled();
});

test('rejects malformed copy/cut payloads and unavailable sessions', async () => {
  const { service, native } = fixture();
  for (const request of [
    null,
    {},
    { sessionId: 'session', sourcePath: 'a.txt', mode: 'delete' },
    { sessionId: 'missing', sourcePath: 'a.txt', mode: 'copy' },
  ]) {
    expect(
      await service.write(request as WorkspaceFileClipboardWriteRequest, () => true),
    ).toMatchObject({ success: false });
  }
  expect(native.write).not.toHaveBeenCalled();
});

test('reads the actual system clipboard independently of the current workspace', async () => {
  const { external, service, native } = fixture();
  expect(await service.read()).toMatchObject({
    success: true,
    value: { paths: [path.join(external, 'b.txt')], revision: '1' },
  });
  expect(native.read).toHaveBeenCalledOnce();
});

test('accepts multiple files and folders copied outside the application and guards their destinations', async () => {
  const { root, external, setClipboard, prepare } = fixture();
  fs.mkdirSync(path.join(external, 'folder'));
  setClipboard({
    paths: [path.join(external, 'b.txt'), path.join(external, 'folder')],
    mode: WorkspaceFileTransferMode.Copy,
    revision: '2',
  });
  const prepared = await prepare();
  expect(prepared.affectedPaths).toEqual([
    path.join(root, 'target', 'b.txt'),
    path.join(root, 'target', 'folder'),
  ]);
});

test('guards both moved source previews and potentially overwritten target previews', async () => {
  const { root, external, setClipboard, prepare } = fixture();
  setClipboard({
    paths: [path.join(external, 'b.txt')],
    mode: WorkspaceFileTransferMode.Move,
    revision: '2',
  });
  const prepared = await prepare();
  expect(prepared.affectedPaths).toContain(path.join(external, 'b.txt'));
  expect(prepared.affectedPaths).toContain(path.join(root, 'target', 'b.txt'));
});

test.each([WorkspaceFileTransferMode.Copy, WorkspaceFileTransferMode.Move])(
  'does not close previews for same-folder %s',
  async mode => {
    const { root, service, setClipboard } = fixture();
    setClipboard({ paths: [path.join(root, 'a.txt')], mode, revision: '3' });
    expect(
      await service.prepare({ sessionId: 'session', targetDirectory: '' }, () => true),
    ).toMatchObject({ success: true, value: { affectedPaths: [] } });
  },
);

test('delegates the frozen clipboard selection and directory to the native Shell', async () => {
  const { root, external, native, service, request } = fixture();
  const payload = await request();
  expect(await service.paste(payload, '12345', () => true)).toMatchObject({
    success: true,
    value: { cancelled: false },
  });
  expect(native.paste).toHaveBeenCalledWith(
    { paths: [path.join(external, 'b.txt')], mode: 'copy', revision: '1' },
    path.join(root, 'target'),
    '12345',
    {
      dev: fs.lstatSync(path.join(root, 'target'), { bigint: true }).dev.toString(),
      ino: fs.lstatSync(path.join(root, 'target'), { bigint: true }).ino.toString(),
    },
  );
  // Main never performs a second, custom filesystem copy.
  expect(fs.readdirSync(path.join(root, 'target'))).toEqual([]);
});

test('does not paste a new clipboard selection after preview confirmation', async () => {
  const { service, native, request, setClipboard, root } = fixture();
  const payload = await request();
  setClipboard({
    paths: [path.join(root, 'a.txt')],
    mode: WorkspaceFileTransferMode.Move,
    revision: '9',
  });
  expect(await service.paste(payload, '0', () => true)).toMatchObject({
    success: false,
    code: 'clipboard-changed',
  });
  expect(native.paste).not.toHaveBeenCalled();
});

test('rejects a changed workspace or replaced target after preparation', async () => {
  const { service, native, request, setRoot, root, external } = fixture();
  const payload = await request();
  fs.mkdirSync(path.join(external, 'target'));
  setRoot(external);
  expect(await service.paste(payload, '0', () => true)).toMatchObject({ success: false });
  setRoot(root);
  fs.renameSync(path.join(root, 'target'), path.join(root, 'old-target'));
  fs.mkdirSync(path.join(root, 'target'));
  expect(await service.paste(payload, '0', () => true)).toMatchObject({ success: false });
  expect(native.paste).not.toHaveBeenCalled();
});

test('keeps a queued paste bound to its original workspace', async () => {
  const { service, request, native, setRoot, external } = fixture();
  const payload = await request();
  let finish: (value: {
    cancelled: boolean;
    clipboard: WorkspaceFileClipboardSnapshot;
  }) => void = () => {};
  native.paste.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const first = service.paste(payload, '0', () => true);
  await vi.waitFor(() => expect(native.paste).toHaveBeenCalledTimes(1));
  const second = service.paste(payload, '0', () => true);
  await Promise.resolve();
  await Promise.resolve();
  setRoot(external);
  finish({
    cancelled: false,
    clipboard: { paths: [], mode: WorkspaceFileTransferMode.Copy, revision: '2' },
  });
  expect(await first).toMatchObject({ success: true });
  expect(await second).toMatchObject({ success: false });
  expect(native.paste).toHaveBeenCalledTimes(1);
});

test('returns system cancellation without retrying or clearing the clipboard itself', async () => {
  const { service, request, native } = fixture();
  native.paste.mockResolvedValueOnce({
    cancelled: true,
    clipboard: { paths: ['preserved'], mode: WorkspaceFileTransferMode.Move, revision: '1' },
  });
  expect(await service.paste(await request(), '0', () => true)).toMatchObject({
    success: true,
    value: { cancelled: true, clipboard: { paths: ['preserved'] } },
  });
  expect(native.paste).toHaveBeenCalledOnce();
  expect(native.write).not.toHaveBeenCalled();
});

test('rejects target directory junctions while permitting a linked workspace root', async () => {
  const { root, external, service, setRoot, native } = fixture();
  fs.symlinkSync(
    external,
    path.join(root, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(
    await service.prepare({ sessionId: 'session', targetDirectory: 'link' }, () => true),
  ).toMatchObject({ success: false });
  fs.symlinkSync(
    root,
    path.join(external, 'root-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  setRoot(path.join(external, 'root-link'));
  expect(
    await service.write(
      { sessionId: 'session', sourcePath: 'a.txt', mode: WorkspaceFileTransferMode.Copy },
      () => true,
    ),
  ).toMatchObject({ success: true });
  expect(native.write).toHaveBeenCalledWith(
    [path.join(root, 'a.txt')],
    WorkspaceFileTransferMode.Copy,
  );
});

test.each([WorkspaceFileTransferMode.Copy, WorkspaceFileTransferMode.Move])(
  'rejects a %s merge into an existing destination junction before preview confirmation',
  async mode => {
    const { root, external, service, native, setClipboard } = fixture();
    fs.mkdirSync(path.join(external, 'folder'));
    fs.symlinkSync(
      external,
      path.join(root, 'target', 'folder'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    setClipboard({ paths: [path.join(external, 'folder')], mode, revision: '3' });
    expect(
      await service.prepare({ sessionId: 'session', targetDirectory: 'target' }, () => true),
    ).toMatchObject({ success: false });
    expect(native.paste).not.toHaveBeenCalled();
  },
);

test('rejects invalid targets and vanished callers while treating a text clipboard as no files', async () => {
  const { service, target, native, setClipboard } = fixture();
  expect(
    await service.prepare({ ...target, targetDirectory: '../outside' }, () => true),
  ).toMatchObject({ success: false });
  expect(await service.prepare(target, () => false)).toMatchObject({ success: false });
  expect(native.read).not.toHaveBeenCalled();
  setClipboard({ paths: [], mode: WorkspaceFileTransferMode.Copy, revision: '0' });
  expect(await service.prepare(target, () => true)).toMatchObject({
    success: true,
    value: { affectedPaths: [], clipboard: { paths: [] } },
  });
  expect(native.paste).not.toHaveBeenCalled();
});

test('preserves a clipboard change detected at the final native admission check', async () => {
  const { service, request, native } = fixture();
  native.paste.mockRejectedValueOnce(
    Object.assign(new Error('The system clipboard changed before paste.'), {
      code: 'clipboard-changed',
    }),
  );
  expect(await service.paste(await request(), '0', () => true)).toMatchObject({
    success: false,
    code: 'clipboard-changed',
  });
  expect(native.paste).toHaveBeenCalledOnce();
});

test('allows remaining cut items after a partial move while still guarding every potential target', async () => {
  const { service, native, prepare, request, setClipboard, external, root } = fixture();
  const missing = path.join(external, 'already-moved.txt');
  const remaining = path.join(external, 'b.txt');
  setClipboard({
    paths: [missing, remaining],
    mode: WorkspaceFileTransferMode.Move,
    revision: '8',
  });
  const prepared = await prepare();
  expect(prepared.affectedPaths).toContain(missing);
  expect(prepared.affectedPaths).toContain(path.join(root, 'target', 'already-moved.txt'));
  expect(prepared.affectedPaths).toContain(remaining);
  expect(prepared.affectedPaths).toContain(path.join(root, 'target', 'b.txt'));
  expect(await service.paste(await request(), '0', () => true)).toMatchObject({ success: true });
  // Keep the full snapshot for native revision validation; only Shell execution
  // filters references which no longer exist after an earlier partial move.
  expect(native.paste).toHaveBeenCalledWith(
    { paths: [missing, remaining], mode: 'move', revision: '8' },
    path.join(root, 'target'),
    '0',
    {
      dev: fs.lstatSync(path.join(root, 'target'), { bigint: true }).dev.toString(),
      ino: fs.lstatSync(path.join(root, 'target'), { bigint: true }).ino.toString(),
    },
  );
});
