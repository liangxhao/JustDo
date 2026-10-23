// @vitest-environment jsdom

import type {
  WorkspaceFileClipboardResult,
  WorkspaceFileClipboardSnapshot,
  WorkspaceFileMutationPreparation,
  WorkspaceFilePasteOutcome,
  WorkspaceFilePastePreparation,
} from '@shared/preview/workspaceFiles';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';
import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import WorkspaceFilesPanel from './WorkspaceFilesPanel';

const listWorkspaceDirectory = vi.fn();
const readWorkspaceFileClipboard = vi.fn();
const writeWorkspaceFileClipboard = vi.fn();
const prepareWorkspaceFilePaste = vi.fn();
const pasteWorkspaceFiles = vi.fn();
const prepareWorkspaceFileMutation = vi.fn();
const mutateWorkspaceFile = vi.fn();
const writeClipboardText = vi.fn();
const showItemInFolder = vi.fn();
let systemClipboard: WorkspaceFileClipboardSnapshot;

const succeeded = <T,>(value: T) => ({ success: true as const, value });
const emptyClipboard = (): WorkspaceFileClipboardSnapshot => ({
  paths: [],
  mode: 'copy',
  revision: 'empty',
});
const externalClipboard = (
  paths = ['D:/incoming/report.md'],
  mode: 'copy' | 'move' = 'copy',
  revision = 'external',
) => {
  systemClipboard = { paths, mode, revision };
  return systemClipboard;
};
const deferred = <T,>() => {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  systemClipboard = emptyClipboard();
  readWorkspaceFileClipboard.mockReset().mockImplementation(async () => succeeded(systemClipboard));
  writeWorkspaceFileClipboard.mockReset().mockImplementation(async request => {
    systemClipboard = {
      paths: [`C:/workspace/${request.sourcePath}`],
      mode: request.mode,
      revision: 'written',
    };
    return succeeded(systemClipboard);
  });
  prepareWorkspaceFilePaste.mockReset().mockImplementation(async request => {
    const targetPath = `C:/workspace${request.targetDirectory ? `/${request.targetDirectory}` : ''}`;
    const affectedPaths = systemClipboard.paths.flatMap(sourcePath => {
      const normalized = sourcePath.replace(/\\/g, '/');
      const lastSlash = normalized.lastIndexOf('/');
      if (systemClipboard.mode === 'move' && normalized.slice(0, lastSlash) === targetPath)
        return [];
      return [
        ...(systemClipboard.mode === 'move' ? [sourcePath] : []),
        `${targetPath}/${normalized.slice(lastSlash + 1)}`,
      ];
    });
    return succeeded({
      clipboard: systemClipboard,
      affectedPaths,
      destinationRevision: 'destination',
    });
  });
  pasteWorkspaceFiles.mockReset().mockImplementation(async () => {
    if (systemClipboard.mode === 'move') systemClipboard = emptyClipboard();
    return succeeded({ cancelled: false, clipboard: systemClipboard });
  });
  prepareWorkspaceFileMutation.mockReset().mockImplementation(async request =>
    succeeded({
      affectedPaths:
        request.kind === 'create-directory' ? [] : [`C:/workspace/${request.relativePath}`],
      revision: 'mutation-1',
      locationRevision: 'location-1',
    }),
  );
  mutateWorkspaceFile.mockReset().mockImplementation(async request => {
    const parent = request.relativePath.includes('/')
      ? request.relativePath.slice(0, request.relativePath.lastIndexOf('/'))
      : '';
    return succeeded({
      relativePath:
        request.kind === 'trash'
          ? request.relativePath
          : request.kind === 'create-directory'
            ? [request.relativePath, request.newName].filter(Boolean).join('/')
            : [parent, request.newName].filter(Boolean).join('/'),
    });
  });
  writeClipboardText.mockReset().mockImplementation(async () => {
    systemClipboard = emptyClipboard();
  });
  showItemInFolder.mockReset().mockResolvedValue({ success: true });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeClipboardText },
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      shell: {
        listWorkspaceDirectory,
        readWorkspaceFileClipboard,
        writeWorkspaceFileClipboard,
        prepareWorkspaceFilePaste,
        pasteWorkspaceFiles,
        prepareWorkspaceFileMutation,
        mutateWorkspaceFile,
        showItemInFolder,
      },
    },
  });
});

afterEach(cleanup);

const mockFileOperationTree = () => {
  listWorkspaceDirectory.mockImplementation(async (_session: string, directory = '') => ({
    success: true,
    truncated: false,
    entries:
      directory === ''
        ? [
            { filePath: 'C:/workspace/src', kind: 'directory', name: 'src', relativePath: 'src' },
            {
              filePath: 'C:/workspace/target',
              kind: 'directory',
              name: 'target',
              relativePath: 'target',
            },
            {
              filePath: 'C:/workspace/readme.md',
              kind: 'file',
              name: 'readme.md',
              relativePath: 'readme.md',
            },
          ]
        : directory === 'src'
          ? [
              {
                filePath: 'C:/workspace/src/a.txt',
                kind: 'file',
                name: 'a.txt',
                relativePath: 'src\\a.txt',
              },
            ]
          : [],
  }));
};
const menuItem = (key: Parameters<typeof i18nService.t>[0]) =>
  screen.getByRole('menuitem', { name: i18nService.t(key) });
const openMenu = async (target: HTMLElement) => {
  await act(async () => {
    fireEvent.contextMenu(target);
  });
};
const choose = async (key: Parameters<typeof i18nService.t>[0]) => {
  await act(async () => {
    fireEvent.click(menuItem(key));
  });
};

test('opens a file menu without opening or expanding it and supports path and reveal actions', async () => {
  mockFileOperationTree();
  const onOpenFile = vi.fn();
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={onOpenFile} />);
  const file = await screen.findByRole('treeitem', { name: 'readme.md' });
  await openMenu(file);
  expect(menuItem('coworkWorkspaceFilesPaste')).toHaveProperty('disabled', true);
  expect(onOpenFile).not.toHaveBeenCalled();
  await choose('coworkWorkspaceFilesCopyPath');
  expect(writeClipboardText).toHaveBeenCalledWith('C:/workspace/readme.md');
  expect(readWorkspaceFileClipboard).toHaveBeenCalledTimes(2);
  expect(file).toBe(document.activeElement);
  await openMenu(file);
  await choose('coworkFilePreviewShowInFolder');
  expect(showItemInFolder).toHaveBeenCalledWith('C:/workspace/readme.md');
  await openMenu(screen.getByRole('treeitem', { name: 'src' }));
  expect(screen.queryByText('a.txt')).toBeNull();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  expect(screen.getByRole('treeitem', { name: 'src' })).toBe(document.activeElement);
});

test('pastes Explorer files and folders with Ctrl+V without opening a menu first', async () => {
  mockFileOperationTree();
  externalClipboard(['D:/incoming/report.md', 'D:/incoming/assets']);
  const onBeforeMutation = vi.fn(async () => true);
  render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.keyDown(screen.getByRole('tree'), { key: 'v', ctrlKey: true });
  await waitFor(() =>
    expect(pasteWorkspaceFiles).toHaveBeenCalledWith({
      sessionId: 'session',
      targetDirectory: '',
      clipboardRevision: 'external',
      destinationRevision: 'destination',
    }),
  );
  expect(onBeforeMutation).toHaveBeenCalledWith(['C:/workspace/report.md', 'C:/workspace/assets']);
  expect(readWorkspaceFileClipboard).not.toHaveBeenCalled();
  expect(writeWorkspaceFileClipboard).not.toHaveBeenCalled();
});

test('uses folder, file-parent and blank-root paste targets with normalized Windows paths', async () => {
  mockFileOperationTree();
  externalClipboard();
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  await openMenu(await screen.findByRole('treeitem', { name: 'target' }));
  await choose('coworkWorkspaceFilesPaste');
  expect(prepareWorkspaceFilePaste).toHaveBeenLastCalledWith({
    sessionId: 'session',
    targetDirectory: 'target',
  });
  fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
  await openMenu(await screen.findByRole('treeitem', { name: 'a.txt' }));
  await choose('coworkWorkspaceFilesPaste');
  expect(prepareWorkspaceFilePaste).toHaveBeenLastCalledWith({
    sessionId: 'session',
    targetDirectory: 'src',
  });
  await openMenu(screen.getByRole('tree'));
  await choose('coworkWorkspaceFilesPaste');
  expect(prepareWorkspaceFilePaste).toHaveBeenLastCalledWith({
    sessionId: 'session',
    targetDirectory: '',
  });
});

test('writes copy and cut to the system clipboard and keeps it across sessions and Escape', async () => {
  mockFileOperationTree();
  const view = render(<WorkspaceFilesPanel sessionId="old" onOpenFile={vi.fn()} />);
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  await openMenu(source);
  await choose('coworkWorkspaceFilesCopy');
  expect(writeWorkspaceFileClipboard).toHaveBeenLastCalledWith({
    sessionId: 'old',
    sourcePath: 'readme.md',
    mode: 'copy',
  });
  fireEvent.keyDown(source, { key: 'x', ctrlKey: true });
  await waitFor(() => expect(source.className).toContain('opacity-50'));
  expect(writeWorkspaceFileClipboard).toHaveBeenLastCalledWith({
    sessionId: 'old',
    sourcePath: 'readme.md',
    mode: 'move',
  });
  fireEvent.keyDown(source, { key: 'Escape' });
  expect(source.className).toContain('opacity-50');
  view.rerender(<WorkspaceFilesPanel sessionId="new" onOpenFile={vi.fn()} />);
  const target = await screen.findByRole('treeitem', { name: 'target' });
  fireEvent.keyDown(target, { key: 'v', ctrlKey: true });
  await waitFor(() =>
    expect(pasteWorkspaceFiles).toHaveBeenCalledWith({
      sessionId: 'new',
      targetDirectory: 'target',
      clipboardRevision: 'written',
      destinationRevision: 'destination',
    }),
  );
  expect(writeWorkspaceFileClipboard).toHaveBeenCalledTimes(2);
});

test('keeps Paste disabled during a menu read and prepares the current clipboard again on selection', async () => {
  mockFileOperationTree();
  const reading = deferred<WorkspaceFileClipboardResult<WorkspaceFileClipboardSnapshot>>();
  readWorkspaceFileClipboard.mockImplementationOnce(() => reading.promise);
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'target' }));
  expect(menuItem('coworkWorkspaceFilesPaste')).toHaveProperty('disabled', true);
  reading.resolve(succeeded(externalClipboard(['D:/old.md'], 'copy', 'old')));
  await waitFor(() =>
    expect(menuItem('coworkWorkspaceFilesPaste')).toHaveProperty('disabled', false),
  );
  externalClipboard(['D:/new.md'], 'copy', 'new');
  await choose('coworkWorkspaceFilesPaste');
  expect(pasteWorkspaceFiles).toHaveBeenCalledWith({
    sessionId: 'session',
    targetDirectory: 'target',
    clipboardRevision: 'new',
    destinationRevision: 'destination',
  });
});

test('does not let a pending availability read block Ctrl+V or restore an older cut snapshot', async () => {
  mockFileOperationTree();
  const reading = deferred<WorkspaceFileClipboardResult<WorkspaceFileClipboardSnapshot>>();
  readWorkspaceFileClipboard.mockImplementationOnce(() => reading.promise);
  externalClipboard(['D:/new.md']);
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.contextMenu(source);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  fireEvent.keyDown(source, { key: 'v', ctrlKey: true });
  await waitFor(() => expect(pasteWorkspaceFiles).toHaveBeenCalledOnce());
  await act(async () => {
    reading.resolve(
      succeeded({ paths: ['C:/workspace/readme.md'], mode: 'move', revision: 'stale' }),
    );
  });
  expect(source.className).not.toContain('opacity-50');
});

test('serializes clipboard writes until they finish and leaves text-input shortcuts untouched', async () => {
  mockFileOperationTree();
  const writing = deferred<WorkspaceFileClipboardResult<WorkspaceFileClipboardSnapshot>>();
  writeWorkspaceFileClipboard.mockImplementationOnce(() => writing.promise);
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.keyDown(source, { key: 'x', ctrlKey: true });
  fireEvent.keyDown(source, { key: 'c', ctrlKey: true });
  fireEvent.keyDown(source, { key: 'v', ctrlKey: true });
  expect(writeWorkspaceFileClipboard).toHaveBeenCalledOnce();
  expect(prepareWorkspaceFilePaste).not.toHaveBeenCalled();
  await act(async () => {
    writing.resolve(succeeded(externalClipboard(['C:/workspace/readme.md'], 'move', 'written')));
  });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'v', ctrlKey: true });
  expect(prepareWorkspaceFilePaste).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'target' }), { key: 'v', ctrlKey: true });
  await waitFor(() => expect(pasteWorkspaceFiles).toHaveBeenCalledOnce());
});

test('disables Copy Path until an earlier system file clipboard write finishes', async () => {
  mockFileOperationTree();
  const writing = deferred<WorkspaceFileClipboardResult<WorkspaceFileClipboardSnapshot>>();
  writeWorkspaceFileClipboard.mockImplementationOnce(() => writing.promise);
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.keyDown(source, { key: 'c', ctrlKey: true });
  await openMenu(source);
  expect(menuItem('coworkWorkspaceFilesCopyPath')).toHaveProperty('disabled', true);
  fireEvent.click(menuItem('coworkWorkspaceFilesCopyPath'));
  expect(writeClipboardText).not.toHaveBeenCalled();
  await act(async () => {
    writing.resolve(succeeded(externalClipboard(['C:/workspace/readme.md'], 'copy', 'written')));
  });
  expect(menuItem('coworkWorkspaceFilesCopyPath')).toHaveProperty('disabled', false);
  await choose('coworkWorkspaceFilesCopyPath');
  expect(writeClipboardText).toHaveBeenCalledWith('C:/workspace/readme.md');
  expect(systemClipboard.paths).toEqual([]);
});

test('guards affected source and destination previews, blocks duplicate paste and preserves cut on cancel', async () => {
  mockFileOperationTree();
  externalClipboard(['C:/workspace/readme.md'], 'move');
  const decision = deferred<boolean>();
  const onBeforeMutation = vi.fn(() => decision.promise);
  render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  const target = screen.getByRole('treeitem', { name: 'target' });
  fireEvent.keyDown(target, { key: 'v', ctrlKey: true });
  fireEvent.keyDown(target, { key: 'v', ctrlKey: true });
  await waitFor(() =>
    expect(onBeforeMutation).toHaveBeenCalledWith([
      'C:/workspace/readme.md',
      'C:/workspace/target/readme.md',
    ]),
  );
  await act(async () => {
    decision.resolve(false);
  });
  expect(pasteWorkspaceFiles).not.toHaveBeenCalled();
  expect(source.className).toContain('opacity-50');
  expect(prepareWorkspaceFilePaste).toHaveBeenCalledOnce();
});

test('does not guard a no-op paste or invoke native paste after invalid preparation', async () => {
  mockFileOperationTree();
  externalClipboard(['C:/workspace/readme.md'], 'move');
  const onBeforeMutation = vi.fn(async () => true);
  render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.keyDown(source, { key: 'v', ctrlKey: true });
  await waitFor(() => expect(pasteWorkspaceFiles).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(onBeforeMutation).not.toHaveBeenCalled();
  prepareWorkspaceFilePaste.mockResolvedValueOnce({ success: false, code: 'invalid-target' });
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'src' }), { key: 'v', ctrlKey: true });
  expect((await screen.findByRole('alert')).textContent).toBe(
    i18nService.t('coworkWorkspaceFilesInvalidTarget'),
  );
  expect(onBeforeMutation).not.toHaveBeenCalled();
  expect(pasteWorkspaceFiles).toHaveBeenCalledOnce();
});

test('does not commit an old paste after changing sessions during preview confirmation', async () => {
  mockFileOperationTree();
  externalClipboard();
  const decision = deferred<boolean>();
  const onBeforeMutation = vi.fn(() => decision.promise);
  const view = render(
    <WorkspaceFilesPanel
      sessionId="old"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'target' }), {
    key: 'v',
    ctrlKey: true,
  });
  await waitFor(() => expect(onBeforeMutation).toHaveBeenCalledOnce());
  view.rerender(
    <WorkspaceFilesPanel
      sessionId="new"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  await act(async () => {
    decision.resolve(true);
  });
  expect(pasteWorkspaceFiles).not.toHaveBeenCalled();
  await openMenu(await screen.findByRole('treeitem', { name: 'target' }));
  expect(menuItem('coworkWorkspaceFilesPaste')).toHaveProperty('disabled', false);
  expect(writeWorkspaceFileClipboard).not.toHaveBeenCalled();
});

test('does not commit after unmounting during preparation or preview confirmation', async () => {
  mockFileOperationTree();
  externalClipboard();
  const preparing = deferred<WorkspaceFileClipboardResult<WorkspaceFilePastePreparation>>();
  prepareWorkspaceFilePaste.mockImplementationOnce(() => preparing.promise);
  const onBeforeMutation = vi.fn(async () => true);
  const view = render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'target' }), {
    key: 'v',
    ctrlKey: true,
  });
  view.unmount();
  await act(async () => {
    preparing.resolve(
      succeeded({
        clipboard: systemClipboard,
        affectedPaths: ['C:/workspace/report.md'],
        destinationRevision: 'destination',
      }),
    );
  });
  expect(onBeforeMutation).not.toHaveBeenCalled();
  expect(pasteWorkspaceFiles).not.toHaveBeenCalled();

  const decision = deferred<boolean>();
  onBeforeMutation.mockImplementationOnce(() => decision.promise);
  const next = render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'target' }), {
    key: 'v',
    ctrlKey: true,
  });
  await waitFor(() => expect(onBeforeMutation).toHaveBeenCalledOnce());
  next.unmount();
  await act(async () => {
    decision.resolve(true);
  });
  expect(pasteWorkspaceFiles).not.toHaveBeenCalled();
});

test('blocks reopening copy-overwrite targets and move sources while native paste is pending', async () => {
  mockFileOperationTree();
  externalClipboard(['D:/incoming/readme.md']);
  const transferring = deferred<WorkspaceFileClipboardResult<WorkspaceFilePasteOutcome>>();
  pasteWorkspaceFiles.mockImplementationOnce(() => transferring.promise);
  const onOpenFile = vi.fn();
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={onOpenFile} />);
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.keyDown(screen.getByRole('tree'), { key: 'v', ctrlKey: true });
  await waitFor(() => expect(pasteWorkspaceFiles).toHaveBeenCalledOnce());
  fireEvent.click(source);
  expect(onOpenFile).not.toHaveBeenCalled();
  await openMenu(source);
  expect(menuItem('coworkWorkspaceFilesOpenFile')).toHaveProperty('disabled', true);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
  fireEvent.click(await screen.findByRole('treeitem', { name: 'a.txt' }));
  expect(onOpenFile).toHaveBeenCalledWith('C:/workspace/src/a.txt');
  await act(async () => {
    transferring.resolve(succeeded({ cancelled: true, clipboard: systemClipboard }));
  });
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(source);
  expect(onOpenFile).toHaveBeenLastCalledWith('C:/workspace/readme.md');

  const moving = deferred<WorkspaceFileClipboardResult<WorkspaceFilePasteOutcome>>();
  externalClipboard(['C:/workspace/readme.md'], 'move');
  pasteWorkspaceFiles.mockImplementationOnce(() => moving.promise);
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'target' }), { key: 'v', ctrlKey: true });
  await waitFor(() => expect(pasteWorkspaceFiles).toHaveBeenCalledTimes(2));
  onOpenFile.mockClear();
  fireEvent.click(source);
  expect(onOpenFile).not.toHaveBeenCalled();
  await act(async () => {
    moving.resolve(succeeded({ cancelled: false, clipboard: emptyClipboard() }));
  });
});

test('refreshes newly expanded folders after a partially cancelled native paste', async () => {
  mockFileOperationTree();
  externalClipboard();
  const transferring = deferred<WorkspaceFileClipboardResult<WorkspaceFilePasteOutcome>>();
  pasteWorkspaceFiles.mockImplementationOnce(() => transferring.promise);
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  const target = await screen.findByRole('treeitem', { name: 'target' });
  fireEvent.keyDown(target, { key: 'v', ctrlKey: true });
  await waitFor(() => expect(pasteWorkspaceFiles).toHaveBeenCalledOnce());
  fireEvent.click(target);
  await waitFor(() => expect(listWorkspaceDirectory).toHaveBeenCalledWith('session', 'target'));
  listWorkspaceDirectory.mockClear();
  await act(async () => {
    transferring.resolve(succeeded({ cancelled: true, clipboard: systemClipboard }));
  });
  await waitFor(() => expect(listWorkspaceDirectory).toHaveBeenCalledWith('session', 'target'));
  expect(target.getAttribute('aria-expanded')).toBe('true');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('reports a changed clipboard without retrying or consuming the newer clipboard', async () => {
  mockFileOperationTree();
  externalClipboard();
  pasteWorkspaceFiles.mockResolvedValueOnce({ success: false, code: 'clipboard-changed' });
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'target' }), {
    key: 'v',
    ctrlKey: true,
  });
  expect((await screen.findByRole('alert')).textContent).toBe(
    i18nService.t('coworkWorkspaceFilesClipboardChanged'),
  );
  expect(pasteWorkspaceFiles).toHaveBeenCalledOnce();
  expect(prepareWorkspaceFilePaste).toHaveBeenCalledOnce();
  expect(writeWorkspaceFileClipboard).not.toHaveBeenCalled();
});

test('provides keyboard menu navigation without intercepting text-field clipboard commands', async () => {
  mockFileOperationTree();
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  source.focus();
  fireEvent.keyDown(source, { key: 'F10', shiftKey: true });
  const first = menuItem('coworkWorkspaceFilesOpenFile');
  expect(first).toBe(document.activeElement);
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(menuItem('coworkWorkspaceFilesCopy')).toBe(document.activeElement);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'c', ctrlKey: true });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'v', ctrlKey: true });
  expect(writeWorkspaceFileClipboard).not.toHaveBeenCalled();
  expect(prepareWorkspaceFilePaste).not.toHaveBeenCalled();
});

test('reads the system clipboard from the owning window focus and renders its menu there', async () => {
  mockFileOperationTree();
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const ownerDocument = frame.contentDocument!;
  const ownerWindow = frame.contentWindow!;
  try {
    const view = render(
      <OwnerDocumentContext.Provider value={ownerDocument}>
        <WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />
      </OwnerDocumentContext.Provider>,
    );
    const source = await screen.findByRole('treeitem', { name: 'readme.md' });
    externalClipboard(['C:/workspace/readme.md'], 'move');
    await act(async () => {
      ownerWindow.dispatchEvent(new Event('focus'));
    });
    expect(readWorkspaceFileClipboard).toHaveBeenCalledOnce();
    expect(source.className).toContain('opacity-50');
    await openMenu(source);
    expect(within(ownerDocument.body).getByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    view.rerender(
      <OwnerDocumentContext.Provider value={ownerDocument}>
        <WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} isVisible={false} />
      </OwnerDocumentContext.Provider>,
    );
    expect(within(ownerDocument.body).queryByRole('menu')).toBeNull();
  } finally {
    frame.remove();
  }
});

test('opens a rename dialog with the basename selected and cancels without filesystem calls', async () => {
  mockFileOperationTree();
  const onOpenFile = vi.fn();
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={onOpenFile} />);
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  await openMenu(source);
  await choose('coworkWorkspaceFilesRename');
  const input = screen.getByRole('textbox', {
    name: i18nService.t('coworkWorkspaceFilesName'),
  }) as HTMLInputElement;
  expect(input.value).toBe('readme.md');
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(6);
  expect(input).toBe(document.activeElement);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(source).toBe(document.activeElement);
  expect(prepareWorkspaceFileMutation).not.toHaveBeenCalled();
  expect(onOpenFile).not.toHaveBeenCalled();
});

test('keeps a failed rename editable for retry and treats an unchanged name as a no-op', async () => {
  mockFileOperationTree();
  mutateWorkspaceFile.mockResolvedValueOnce({ success: false, code: 'already-exists' });
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.keyDown(source, { key: 'F2' });
  await act(async () => {
    fireEvent.submit(screen.getByRole('dialog'));
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(prepareWorkspaceFileMutation).not.toHaveBeenCalled();
  fireEvent.keyDown(source, { key: 'F2' });
  fireEvent.change(
    screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') }),
    { target: { value: '季度 report.md' } },
  );
  await act(async () => {
    fireEvent.submit(screen.getByRole('dialog'));
  });
  expect(screen.getByRole('alert').textContent).toBe(
    i18nService.t('coworkWorkspaceFilesAlreadyExists'),
  );
  const retry = screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') });
  expect(retry).toHaveProperty('value', '季度 report.md');
  expect(retry).not.toHaveProperty('disabled', true);
  fireEvent.change(retry, { target: { value: 'final.md' } });
  await act(async () => {
    fireEvent.submit(screen.getByRole('dialog'));
  });
  expect(mutateWorkspaceFile).toHaveBeenLastCalledWith({
    sessionId: 'session',
    kind: 'rename',
    relativePath: 'readme.md',
    newName: 'final.md',
    revision: 'mutation-1',
  });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('uses a refreshed source revision after the preview guard saves an atomic file replacement', async () => {
  mockFileOperationTree();
  prepareWorkspaceFileMutation.mockResolvedValueOnce(
    succeeded({
      affectedPaths: ['C:/workspace/readme.md'],
      revision: 'before-save',
      locationRevision: 'location-1',
    }),
  );
  prepareWorkspaceFileMutation.mockResolvedValueOnce(
    succeeded({
      affectedPaths: ['C:/workspace/readme.md'],
      revision: 'after-save',
      locationRevision: 'location-1',
    }),
  );
  const onBeforeMutation = vi.fn(async () => true);
  render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'readme.md' }), { key: 'F2' });
  fireEvent.change(
    screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') }),
    { target: { value: 'saved.md' } },
  );
  await act(async () => {
    fireEvent.submit(screen.getByRole('dialog'));
  });
  expect(onBeforeMutation).toHaveBeenCalledWith(['C:/workspace/readme.md']);
  expect(prepareWorkspaceFileMutation).toHaveBeenCalledTimes(2);
  expect(mutateWorkspaceFile).toHaveBeenCalledWith({
    sessionId: 'session',
    kind: 'rename',
    relativePath: 'readme.md',
    newName: 'saved.md',
    revision: 'after-save',
  });
});

test('rejects a changed set of affected paths after preview confirmation', async () => {
  mockFileOperationTree();
  prepareWorkspaceFileMutation.mockResolvedValueOnce(
    succeeded({
      affectedPaths: ['C:/workspace/readme.md'],
      revision: 'old',
      locationRevision: 'location-1',
    }),
  );
  prepareWorkspaceFileMutation.mockResolvedValueOnce(
    succeeded({
      affectedPaths: ['D:/other/readme.md'],
      revision: 'new',
      locationRevision: 'location-1',
    }),
  );
  render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={async () => true}
    />,
  );
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'readme.md' }), { key: 'F2' });
  fireEvent.change(
    screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') }),
    { target: { value: 'new.md' } },
  );
  await act(async () => {
    fireEvent.submit(screen.getByRole('dialog'));
  });
  expect(mutateWorkspaceFile).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
});

test('rejects replacing the same named parent while a preview guard is pending', async () => {
  mockFileOperationTree();
  prepareWorkspaceFileMutation.mockResolvedValueOnce(
    succeeded({
      affectedPaths: ['C:/workspace/readme.md'],
      revision: 'old',
      locationRevision: 'location-1',
    }),
  );
  prepareWorkspaceFileMutation.mockResolvedValueOnce(
    succeeded({
      affectedPaths: ['C:/workspace/readme.md'],
      revision: 'new',
      locationRevision: 'replaced-location',
    }),
  );
  render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={async () => true}
    />,
  );
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'readme.md' }), { key: 'F2' });
  fireEvent.change(
    screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') }),
    { target: { value: 'new.md' } },
  );
  await act(async () => {
    fireEvent.submit(screen.getByRole('dialog'));
  });
  expect(prepareWorkspaceFileMutation).toHaveBeenCalledTimes(2);
  expect(mutateWorkspaceFile).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
});

test('restores the rename draft after guard cancellation and shares its operation lock with paste and delete', async () => {
  mockFileOperationTree();
  const decision = deferred<boolean>();
  const onBeforeMutation = vi.fn(() => decision.promise);
  render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.keyDown(source, { key: 'F2' });
  fireEvent.change(
    screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') }),
    { target: { value: 'draft.md' } },
  );
  fireEvent.submit(screen.getByRole('dialog'));
  await waitFor(() => expect(onBeforeMutation).toHaveBeenCalledOnce());
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.keyDown(source, { key: 'Delete' });
  fireEvent.keyDown(source, { key: 'v', ctrlKey: true });
  fireEvent.keyDown(source, { key: 'x', ctrlKey: true });
  expect(prepareWorkspaceFileMutation).toHaveBeenCalledOnce();
  expect(prepareWorkspaceFilePaste).not.toHaveBeenCalled();
  expect(writeWorkspaceFileClipboard).not.toHaveBeenCalled();
  await act(async () => {
    decision.resolve(false);
  });
  expect(mutateWorkspaceFile).not.toHaveBeenCalled();
  expect(
    screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') }),
  ).toHaveProperty('value', 'draft.md');
});

test('deletes only a selected tree entry through recycling and preserves it when the guard cancels', async () => {
  mockFileOperationTree();
  const onBeforeMutation = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  const source = await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.keyDown(source, { key: 'Delete', shiftKey: true });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Delete' });
  fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' });
  expect(prepareWorkspaceFileMutation).not.toHaveBeenCalled();
  fireEvent.keyDown(source, { key: 'Delete' });
  await waitFor(() => expect(onBeforeMutation).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(mutateWorkspaceFile).not.toHaveBeenCalled();
  await openMenu(source);
  await choose('coworkWorkspaceFilesTrash');
  expect(mutateWorkspaceFile).toHaveBeenCalledWith({
    sessionId: 'session',
    kind: 'trash',
    relativePath: 'readme.md',
    revision: 'mutation-1',
  });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test.each([
  ['blank', ''],
  ['file', ''],
  ['directory', 'src'],
  ['nested-file', 'src'],
])(
  'creates a folder in the correct %s target without touching previews',
  async (targetKind, relativePath) => {
    mockFileOperationTree();
    const onBeforeMutation = vi.fn(async () => true);
    render(
      <WorkspaceFilesPanel
        sessionId="session"
        onOpenFile={vi.fn()}
        onBeforeMutation={onBeforeMutation}
      />,
    );
    await screen.findByRole('treeitem', { name: 'readme.md' });
    let target = screen.getByRole('tree');
    if (targetKind === 'file') target = screen.getByRole('treeitem', { name: 'readme.md' });
    if (targetKind === 'directory') target = screen.getByRole('treeitem', { name: 'src' });
    if (targetKind === 'nested-file') {
      fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
      target = await screen.findByRole('treeitem', { name: 'a.txt' });
    }
    fireEvent.keyDown(target, { key: 'N', ctrlKey: true, shiftKey: true });
    const input = screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') });
    fireEvent.change(input, { target: { value: '中文 folder' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('dialog'));
    });
    expect(mutateWorkspaceFile).toHaveBeenCalledWith({
      sessionId: 'session',
      kind: 'create-directory',
      relativePath,
      newName: '中文 folder',
      revision: 'mutation-1',
    });
    expect(onBeforeMutation).not.toHaveBeenCalled();
    expect(prepareWorkspaceFileMutation).toHaveBeenCalledOnce();
  },
);

test('reveals and focuses a created folder without opening a file preview', async () => {
  let created = false;
  listWorkspaceDirectory.mockImplementation(async () => ({
    success: true,
    truncated: false,
    entries: [
      {
        filePath: 'C:/workspace/readme.md',
        kind: 'file',
        name: 'readme.md',
        relativePath: 'readme.md',
      },
      ...(created
        ? [
            {
              filePath: 'C:/workspace/新资料',
              kind: 'directory',
              name: '新资料',
              relativePath: '新资料',
            },
          ]
        : []),
    ],
  }));
  mutateWorkspaceFile.mockImplementationOnce(async () => {
    created = true;
    return succeeded({ relativePath: '新资料' });
  });
  const onOpenFile = vi.fn();
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={onOpenFile} />);
  await screen.findByRole('treeitem', { name: 'readme.md' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'read' } });
  fireEvent.keyDown(screen.getByRole('tree'), { key: 'N', ctrlKey: true, shiftKey: true });
  fireEvent.change(
    screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') }),
    { target: { value: '新资料' } },
  );
  await act(async () => {
    fireEvent.submit(screen.getByRole('dialog'));
  });
  const folder = await screen.findByRole('treeitem', { name: '新资料' });
  await waitFor(() => expect(document.activeElement).toBe(folder));
  expect(screen.getByRole('textbox')).toHaveProperty('value', '');
  expect(onOpenFile).not.toHaveBeenCalled();
});

test('offers only folder creation at the root and rejects invalid names and IME submit', async () => {
  mockFileOperationTree();
  render(<WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />);
  await screen.findByRole('treeitem', { name: 'readme.md' });
  await openMenu(screen.getByRole('tree'));
  expect(
    screen.queryByRole('menuitem', { name: i18nService.t('coworkWorkspaceFilesRename') }),
  ).toBeNull();
  expect(
    screen.queryByRole('menuitem', { name: i18nService.t('coworkWorkspaceFilesTrash') }),
  ).toBeNull();
  await choose('coworkWorkspaceFilesNewFolder');
  const input = screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') });
  fireEvent.change(input, { target: { value: '../outside' } });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(screen.getByRole('alert').textContent).toBe(
    i18nService.t('coworkWorkspaceFilesInvalidName'),
  );
  expect(prepareWorkspaceFileMutation).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '中文' } });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(prepareWorkspaceFileMutation).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await act(async () => {
    fireEvent.submit(screen.getByRole('dialog'));
  });
  expect(mutateWorkspaceFile).toHaveBeenCalledOnce();
});

test('does not resurrect a name dialog or commit after session change during mutation preparation', async () => {
  mockFileOperationTree();
  const preparation = deferred<WorkspaceFileClipboardResult<WorkspaceFileMutationPreparation>>();
  prepareWorkspaceFileMutation.mockImplementationOnce(() => preparation.promise);
  const view = render(<WorkspaceFilesPanel sessionId="old" onOpenFile={vi.fn()} />);
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'readme.md' }), { key: 'F2' });
  fireEvent.change(
    screen.getByRole('textbox', { name: i18nService.t('coworkWorkspaceFilesName') }),
    { target: { value: 'new.md' } },
  );
  fireEvent.submit(screen.getByRole('dialog'));
  view.rerender(<WorkspaceFilesPanel sessionId="new" onOpenFile={vi.fn()} />);
  await act(async () => {
    preparation.resolve(
      succeeded({
        affectedPaths: ['C:/workspace/readme.md'],
        revision: 'late',
        locationRevision: 'location-1',
      }),
    );
  });
  expect(mutateWorkspaceFile).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('does not commit after the tree unmounts while mutation preview confirmation is pending', async () => {
  mockFileOperationTree();
  const decision = deferred<boolean>();
  const onBeforeMutation = vi.fn(() => decision.promise);
  const view = render(
    <WorkspaceFilesPanel
      sessionId="session"
      onOpenFile={vi.fn()}
      onBeforeMutation={onBeforeMutation}
    />,
  );
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'readme.md' }), { key: 'Delete' });
  await waitFor(() => expect(onBeforeMutation).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => {
    decision.resolve(true);
  });
  expect(mutateWorkspaceFile).not.toHaveBeenCalled();
});

test('renders name entry and its focus trap in a detached workspace document', async () => {
  mockFileOperationTree();
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const ownerDocument = frame.contentDocument!;
  try {
    render(
      <OwnerDocumentContext.Provider value={ownerDocument}>
        <WorkspaceFilesPanel sessionId="session" onOpenFile={vi.fn()} />
      </OwnerDocumentContext.Provider>,
    );
    fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'readme.md' }), { key: 'F2' });
    const dialog = within(ownerDocument.body).getByRole('dialog');
    expect(screen.queryByRole('dialog')).toBeNull();
    const input = within(dialog).getByRole('textbox');
    expect(ownerDocument.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(ownerDocument.activeElement).toBe(
      within(dialog).getByRole('button', { name: i18nService.t('coworkWorkspaceFilesRename') }),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(within(ownerDocument.body).queryByRole('dialog')).toBeNull();
  } finally {
    frame.remove();
  }
});

test('loads folders lazily and opens a selected file', async () => {
  listWorkspaceDirectory.mockImplementation(async (_sessionId: string, relativePath = '') => ({
    success: true,
    truncated: false,
    entries:
      relativePath === ''
        ? [
            {
              filePath: 'C:/workspace/src',
              kind: 'directory',
              name: 'src',
              relativePath: 'src',
            },
            {
              filePath: 'C:/workspace/README.md',
              kind: 'file',
              name: 'README.md',
              relativePath: 'README.md',
            },
          ]
        : [
            {
              filePath: 'C:/workspace/src/main.ts',
              kind: 'file',
              name: 'main.ts',
              relativePath: 'src/main.ts',
            },
          ],
  }));
  const onOpenFile = vi.fn();

  render(<WorkspaceFilesPanel sessionId="session-1" onOpenFile={onOpenFile} />);

  expect(await screen.findByText('README.md')).not.toBeNull();
  expect(document.querySelector('[data-file-icon-kind="markdown"]')).not.toBeNull();
  expect(screen.getByRole('textbox')).toBe(document.activeElement);
  expect(listWorkspaceDirectory).toHaveBeenCalledWith('session-1', '');
  fireEvent.click(screen.getByText('src'));
  expect(await screen.findByText('main.ts')).not.toBeNull();
  expect(listWorkspaceDirectory).toHaveBeenCalledWith('session-1', 'src');
  fireEvent.click(screen.getByText('main.ts'));
  expect(onOpenFile).toHaveBeenCalledWith('C:/workspace/src/main.ts');
});

test('renders distinct colored icons for common workspace file types', async () => {
  listWorkspaceDirectory.mockResolvedValue({
    success: true,
    truncated: false,
    entries: [
      {
        filePath: '/workspace/.gitignore',
        kind: 'file',
        name: '.gitignore',
        relativePath: '.gitignore',
      },
      {
        filePath: '/workspace/package.json',
        kind: 'file',
        name: 'package.json',
        relativePath: 'package.json',
      },
      {
        filePath: '/workspace/main.ts',
        kind: 'file',
        name: 'main.ts',
        relativePath: 'main.ts',
      },
    ],
  });

  render(<WorkspaceFilesPanel sessionId="session-1" onOpenFile={vi.fn()} />);
  await screen.findByText('package.json');

  const gitIcon = document.querySelector<HTMLElement>('[data-file-icon-kind="git"]');
  const jsonIcon = document.querySelector<HTMLElement>('[data-file-icon-kind="json"]');
  const typescriptIcon = document.querySelector<HTMLElement>('[data-file-icon-kind="typescript"]');

  expect(gitIcon?.style.color).toBe('rgb(240, 80, 50)');
  expect(jsonIcon?.style.color).toBe('rgb(232, 121, 36)');
  expect(typescriptIcon?.style.color).toBe('rgb(49, 120, 198)');
});

test('filters the visible tree without creating a tab', async () => {
  listWorkspaceDirectory.mockResolvedValue({
    success: true,
    truncated: false,
    entries: [
      {
        filePath: '/workspace/package.json',
        kind: 'file',
        name: 'package.json',
        relativePath: 'package.json',
      },
      {
        filePath: '/workspace/README.md',
        kind: 'file',
        name: 'README.md',
        relativePath: 'README.md',
      },
    ],
  });

  render(<WorkspaceFilesPanel sessionId="session-1" onOpenFile={vi.fn()} />);
  await screen.findByText('package.json');
  screen.getByRole('treeitem', { name: 'package.json' }).focus();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'read' } });

  await waitFor(() => expect(screen.queryByText('package.json')).toBeNull());
  expect(screen.getByRole('treeitem', { name: 'README.md' }).tabIndex).toBe(0);
});

test('ignores stale directory results after switching sessions', async () => {
  let resolveOldRequest: ((value: unknown) => void) | undefined;
  listWorkspaceDirectory.mockImplementation((sessionId: string) => {
    if (sessionId === 'old-session') {
      return new Promise(resolve => {
        resolveOldRequest = resolve;
      });
    }
    return Promise.resolve({
      success: true,
      truncated: false,
      entries: [
        {
          filePath: '/new/new-file.md',
          kind: 'file',
          name: 'new-file.md',
          relativePath: 'new-file.md',
        },
      ],
    });
  });

  const { rerender } = render(<WorkspaceFilesPanel sessionId="old-session" onOpenFile={vi.fn()} />);
  rerender(<WorkspaceFilesPanel sessionId="new-session" onOpenFile={vi.fn()} />);
  expect(await screen.findByText('new-file.md')).not.toBeNull();

  resolveOldRequest?.({
    success: true,
    truncated: false,
    entries: [
      {
        filePath: '/old/old-file.md',
        kind: 'file',
        name: 'old-file.md',
        relativePath: 'old-file.md',
      },
    ],
  });

  await waitFor(() => expect(screen.queryByText('old-file.md')).toBeNull());
  expect(screen.getByText('new-file.md')).not.toBeNull();
});

test('keeps matching descendants connected to their parent and supports tree keyboard navigation', async () => {
  listWorkspaceDirectory.mockImplementation(async (_sessionId: string, relativePath = '') => ({
    success: true,
    truncated: false,
    entries:
      relativePath === ''
        ? [
            {
              filePath: '/workspace/src',
              kind: 'directory',
              name: 'src',
              relativePath: 'src',
            },
          ]
        : [
            {
              filePath: '/workspace/src/main.ts',
              kind: 'file',
              name: 'main.ts',
              relativePath: 'src/main.ts',
            },
          ],
  }));

  render(
    <WorkspaceFilesPanel
      activeFilePath="/workspace/src/main.ts"
      sessionId="session-1"
      onOpenFile={vi.fn()}
    />,
  );
  const filter = screen.getByRole('textbox');
  await screen.findByText('src');
  fireEvent.keyDown(filter, { key: 'ArrowDown' });
  const directory = screen.getByRole('treeitem', { name: 'src' });
  expect(directory).toBe(document.activeElement);
  fireEvent.keyDown(directory, { key: 'ArrowRight' });
  const file = await screen.findByRole('treeitem', { name: 'main.ts' });
  fireEvent.change(filter, { target: { value: 'main' } });

  expect(screen.getByText('src')).not.toBeNull();
  expect(file.getAttribute('aria-selected')).toBe('true');
});

test('reveals a nested review file by loading its parents without opening a preview', async () => {
  listWorkspaceDirectory.mockImplementation(async (_sessionId: string, relativePath = '') => ({
    success: true,
    truncated: false,
    entries:
      relativePath === ''
        ? [{ filePath: 'C:/work/src', relativePath: 'src', name: 'src', kind: 'directory' }]
        : [
            {
              filePath: 'C:/work/src/中文 文件.ts',
              relativePath: 'src/中文 文件.ts',
              name: '中文 文件.ts',
              kind: 'file',
            },
          ],
  }));
  const onOpenFile = vi.fn();
  render(
    <WorkspaceFilesPanel sessionId="one" revealPath="src/中文 文件.ts" onOpenFile={onOpenFile} />,
  );
  await screen.findByText('中文 文件.ts');
  await waitFor(() => expect(document.activeElement?.textContent).toContain('中文 文件.ts'));
  expect(onOpenFile).not.toHaveBeenCalled();
});

test('does not steal focus back to the review file when another directory loads', async () => {
  listWorkspaceDirectory.mockImplementation(async (_sessionId: string, relativePath = '') => ({
    success: true,
    truncated: false,
    entries:
      relativePath === ''
        ? [
            {
              filePath: '/work/readme.md',
              relativePath: 'readme.md',
              name: 'readme.md',
              kind: 'file',
            },
            { filePath: '/work/src', relativePath: 'src', name: 'src', kind: 'directory' },
          ]
        : [
            {
              filePath: '/work/src/main.ts',
              relativePath: 'src/main.ts',
              name: 'main.ts',
              kind: 'file',
            },
          ],
  }));
  render(<WorkspaceFilesPanel sessionId="one" revealPath="readme.md" onOpenFile={vi.fn()} />);
  const file = await screen.findByRole('treeitem', { name: 'readme.md' });
  await waitFor(() => expect(document.activeElement).toBe(file));
  const directory = screen.getByRole('treeitem', { name: 'src' });
  directory.focus();
  fireEvent.keyDown(directory, { key: 'ArrowRight' });
  await screen.findByRole('treeitem', { name: 'main.ts' });
  expect(document.activeElement).toBe(directory);
});

test('repeats a reveal for the same cached root file after it was filtered out', async () => {
  listWorkspaceDirectory.mockResolvedValue({
    success: true,
    truncated: false,
    entries: [
      { filePath: '/work/main.ts', relativePath: 'main.ts', name: 'main.ts', kind: 'file' },
    ],
  });
  const view = render(
    <WorkspaceFilesPanel
      sessionId="one"
      revealPath="main.ts"
      revealVersion={1}
      onOpenFile={vi.fn()}
    />,
  );
  const file = await screen.findByRole('treeitem', { name: 'main.ts' });
  await waitFor(() => expect(document.activeElement).toBe(file));
  const filter = screen.getByRole('textbox');
  filter.focus();
  fireEvent.change(filter, { target: { value: 'no-match' } });
  expect(screen.queryByRole('treeitem')).toBeNull();

  view.rerender(
    <WorkspaceFilesPanel
      sessionId="one"
      revealPath="main.ts"
      revealVersion={2}
      onOpenFile={vi.fn()}
    />,
  );

  const revealed = await screen.findByRole('treeitem', { name: 'main.ts' });
  await waitFor(() => expect(document.activeElement).toBe(revealed));
  expect(filter).toHaveProperty('value', '');
  expect(listWorkspaceDirectory).toHaveBeenCalledTimes(1);
});

test('refreshes loaded directories while preserving the filter and expanded folders', async () => {
  let refreshed = false;
  listWorkspaceDirectory.mockImplementation(async (_sessionId: string, relativePath: string) => ({
    success: true,
    truncated: false,
    entries:
      relativePath === ''
        ? [
            { filePath: '/work/src', relativePath: 'src', name: 'src', kind: 'directory' },
            {
              filePath: refreshed ? '/work/new.md' : '/work/old.md',
              relativePath: refreshed ? 'new.md' : 'old.md',
              name: refreshed ? 'new.md' : 'old.md',
              kind: 'file',
            },
          ]
        : [
            {
              filePath: refreshed ? '/work/src/new.ts' : '/work/src/old.ts',
              relativePath: refreshed ? 'src/new.ts' : 'src/old.ts',
              name: refreshed ? 'new.ts' : 'old.ts',
              kind: 'file',
            },
          ],
  }));
  const onOpenFile = vi.fn();
  render(<WorkspaceFilesPanel sessionId="one" onOpenFile={onOpenFile} />);
  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
  await screen.findByText('old.ts');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '.ts' } });

  refreshed = true;
  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('coworkWorkspaceFilesRefresh') }),
  );

  await screen.findByText('new.ts');
  expect(screen.queryByText('old.ts')).toBeNull();
  expect(screen.getByRole('textbox')).toHaveProperty('value', '.ts');
  expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe('true');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
  expect(screen.getByText('new.md')).toBeTruthy();
  expect(screen.queryByText('old.md')).toBeNull();
  expect(listWorkspaceDirectory).toHaveBeenCalledTimes(4);
  expect(onOpenFile).not.toHaveBeenCalled();
});

test('collapses all directories and clears filtering without opening or closing a file', async () => {
  listWorkspaceDirectory.mockImplementation(async (_sessionId: string, relativePath: string) => ({
    success: true,
    entries:
      relativePath === ''
        ? [{ filePath: '/work/src', relativePath: 'src', name: 'src', kind: 'directory' }]
        : [
            {
              filePath: '/work/src/main.ts',
              relativePath: 'src/main.ts',
              name: 'main.ts',
              kind: 'file',
            },
          ],
  }));
  const onOpenFile = vi.fn();
  render(<WorkspaceFilesPanel sessionId="one" onOpenFile={onOpenFile} />);
  fireEvent.click(await screen.findByText('src'));
  await screen.findByText('main.ts');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'main' } });

  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('coworkWorkspaceFilesCollapseAll') }),
  );

  expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('main.ts')).toBeNull();
  expect(screen.getByRole('textbox')).toHaveProperty('value', '');
  expect(onOpenFile).not.toHaveBeenCalled();
});

test('discards an older directory read after a refresh finishes', async () => {
  let resolveOldRequest: ((value: unknown) => void) | undefined;
  listWorkspaceDirectory
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOldRequest = resolve;
        }),
    )
    .mockResolvedValue({
      success: true,
      entries: [{ filePath: '/work/new.md', relativePath: 'new.md', name: 'new.md', kind: 'file' }],
    });
  render(<WorkspaceFilesPanel sessionId="one" onOpenFile={vi.fn()} />);

  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('coworkWorkspaceFilesRefresh') }),
  );
  await screen.findByText('new.md');
  resolveOldRequest?.({
    success: true,
    entries: [{ filePath: '/work/old.md', relativePath: 'old.md', name: 'old.md', kind: 'file' }],
  });

  await waitFor(() => expect(screen.queryByText('old.md')).toBeNull());
  expect(screen.getByText('new.md')).toBeTruthy();
});

test('retries a failed root directory read from the refresh button', async () => {
  listWorkspaceDirectory.mockResolvedValueOnce({ success: false }).mockResolvedValue({
    success: true,
    entries: [
      { filePath: '/work/main.ts', relativePath: 'main.ts', name: 'main.ts', kind: 'file' },
    ],
  });
  render(<WorkspaceFilesPanel sessionId="one" onOpenFile={vi.fn()} />);
  await screen.findByRole('alert');

  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('coworkWorkspaceFilesRefresh') }),
  );

  await screen.findByText('main.ts');
  expect(screen.queryByRole('alert')).toBeNull();
});
