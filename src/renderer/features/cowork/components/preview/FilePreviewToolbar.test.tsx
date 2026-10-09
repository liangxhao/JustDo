// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import CoworkDisplayPanel from '../display/CoworkDisplayPanel';
import { fileDisplayTabId, WORKSPACE_FILES_DISPLAY_TAB_ID } from '../display/displayTabIds';
import FilePreviewDrawer, { type FilePreviewDrawerHandle } from './FilePreviewDrawer';
import UnsupportedFilePreview from './UnsupportedFilePreview';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea
      aria-label="File editor"
      value={value}
      onChange={event => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock('@/libs/openclaw-chat/components/markdown', () => ({
  toSanitizedMarkdownHtml: (content: string) => content,
}));
vi.mock('./PreviewMarkdown', () => ({
  default: ({ html }: { html: string }) => <div>{html}</div>,
}));

const textPath = 'E:/work/notes.md';
const imagePath = 'E:/work/image.png';
const unsupportedPath = 'E:/work/archive.zip';
const shell = {
  authorizePreviewFileEdit: vi.fn(),
  revokePreviewFileEdit: vi.fn(),
  writePreviewFile: vi.fn(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
  openPathWith: vi.fn(),
};

function PreviewHarness() {
  const [selected, setSelected] = useState<string | null>(textPath);
  const [treeOpen, setTreeOpen] = useState(true);
  const textPreviewRef = useRef<FilePreviewDrawerHandle>(null);
  return (
    <CoworkDisplayPanel
      activeTabId={
        selected === 'browser'
          ? 'browser:page'
          : selected
            ? fileDisplayTabId(selected)
            : WORKSPACE_FILES_DISPLAY_TAB_ID
      }
      isOpen
      onClose={() => undefined}
      tabs={[
        ...[textPath, imagePath, unsupportedPath].map(filePath => ({
          id: fileDisplayTabId(filePath),
          label: filePath.split('/').pop()!,
          icon: null,
          onSelect: () => setSelected(filePath),
          onClose: async () => {
            if (filePath === textPath && !(await textPreviewRef.current?.requestTransition()))
              return false;
            setSelected(null);
          },
        })),
        {
          id: 'browser:page',
          label: 'New tab',
          icon: null,
          onSelect: () => {
            setSelected('browser');
            setTreeOpen(false);
          },
        },
      ]}
      workspacePath="E:/work"
      sidePanel={<div>File tree</div>}
      sidePanelVisible={treeOpen}
      onSidePanelToggle={() => setTreeOpen(open => !open)}
    >
      <FilePreviewDrawer
        ref={textPreviewRef}
        embedded
        preview={{ filePath: textPath, editToken: 'text-grant', version: 'v1', content: '# Notes' }}
        isObscured={selected !== textPath}
        onClose={() => setSelected(null)}
      />
      <FilePreviewDrawer
        embedded
        preview={{
          kind: 'image',
          filePath: imagePath,
          label: 'image.png',
          src: 'localfile:///image.png',
        }}
        isObscured={selected !== imagePath}
        onClose={() => setSelected(null)}
      />
      <UnsupportedFilePreview
        filePath={unsupportedPath}
        isObscured={selected !== unsupportedPath}
        onClose={() => setSelected(null)}
      />
    </CoworkDisplayPanel>
  );
}

beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  vi.clearAllMocks();
  shell.authorizePreviewFileEdit.mockResolvedValue({ success: true });
  shell.revokePreviewFileEdit.mockResolvedValue({ success: true });
  shell.writePreviewFile.mockResolvedValue({ success: true, version: 'v2' });
  shell.showItemInFolder.mockResolvedValue({ success: true });
  shell.openPath.mockResolvedValue({ success: true });
  shell.openPathWith.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electron', { configurable: true, value: { shell } });
});

afterEach(cleanup);

it('keeps the active file actions beside its path while retaining drafts across tabs and tree visibility', async () => {
  render(<PreviewHarness />);
  const toolbar = screen.getByRole('toolbar', { name: 'File information' });
  expect(within(toolbar).getByLabelText(textPath)).toBeTruthy();
  expect(within(toolbar).getByText('work')).toBeTruthy();
  expect(within(toolbar).getByText('notes.md')).toBeTruthy();
  expect(within(toolbar).getByTitle(textPath)).toBeTruthy();
  expect(within(toolbar).queryByRole('button', { name: 'Close' })).toBeNull();
  expect(document.querySelector('.file-preview-header')).toBeNull();
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Edit' }));
  const editor = await screen.findByRole('textbox', { name: 'File editor' });
  fireEvent.change(editor, { target: { value: '# Updated notes' } });
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Hide file tree' }));
  expect(within(toolbar).getByRole('button', { name: 'Save (Ctrl/Cmd+S)' })).toBeTruthy();

  fireEvent.click(screen.getByRole('tab', { name: 'image.png' }));
  expect(within(toolbar).queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(within(toolbar).queryByRole('button', { name: 'Save (Ctrl/Cmd+S)' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'notes.md' }));
  expect((screen.getByRole('textbox', { name: 'File editor' }) as HTMLTextAreaElement).value).toBe(
    '# Updated notes',
  );
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Show in folder' }));
  await waitFor(() => expect(shell.showItemInFolder).toHaveBeenCalledWith(textPath));
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Save (Ctrl/Cmd+S)' }));
  await waitFor(() =>
    expect(shell.writePreviewFile).toHaveBeenCalledWith({
      content: '# Updated notes',
      editToken: 'text-grant',
      expectedVersion: 'v1',
    }),
  );
  await waitFor(() =>
    expect(within(toolbar).queryByRole('button', { name: 'Save (Ctrl/Cmd+S)' })).toBeNull(),
  );
});

it('preserves the unsaved confirmation when closing the tab and restores the workspace badge', async () => {
  render(<PreviewHarness />);
  const toolbar = screen.getByRole('toolbar', { name: 'File information' });
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'File editor' }), {
    target: { value: '# Draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Close: notes.md' }));
  const dialog = await screen.findByRole('dialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });
  expect(within(toolbar).getByLabelText(textPath)).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'File editor' }) as HTMLTextAreaElement).value).toBe(
    '# Draft',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Close: notes.md' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(within(toolbar).getByLabelText('E:/work')).toBeTruthy());
  expect(within(toolbar).getByText('E:')).toBeTruthy();
  expect(within(toolbar).queryByRole('button', { name: 'Close' })).toBeNull();
  expect(shell.writePreviewFile).toHaveBeenCalledWith({
    content: '# Draft',
    editToken: 'text-grant',
    expectedVersion: 'v1',
  });
});

it('restores file actions and the authorized dirty draft after visiting a browser tab', async () => {
  render(<PreviewHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'File editor' }), {
    target: { value: '# Retained draft' },
  });
  const revocationsBeforeSwitch = shell.revokePreviewFileEdit.mock.calls.length;
  fireEvent.click(screen.getByRole('tab', { name: 'New tab' }));
  expect(screen.queryByRole('toolbar', { name: 'File information' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save (Ctrl/Cmd+S)' })).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: 'notes.md' }));
  const toolbar = screen.getByRole('toolbar', { name: 'File information' });
  expect(within(toolbar).getByRole('button', { name: 'Save (Ctrl/Cmd+S)' })).toBeTruthy();
  expect(within(toolbar).getByLabelText(textPath)).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'File editor' }) as HTMLTextAreaElement).value).toBe(
    '# Retained draft',
  );
  expect(shell.authorizePreviewFileEdit).toHaveBeenCalledTimes(1);
  expect(shell.revokePreviewFileEdit).toHaveBeenCalledTimes(revocationsBeforeSwitch);
});

it('uses the shared row for image reset and native actions for the selected unsupported file', async () => {
  render(<PreviewHarness />);
  const toolbar = screen.getByRole('toolbar', { name: 'File information' });
  fireEvent.click(screen.getByRole('tab', { name: 'image.png' }));
  const image = screen.getByRole('img');
  fireEvent.wheel(image.parentElement!, { deltaY: -300 });
  expect(image.style.transform).not.toContain('scale(1)');
  fireEvent.click(
    within(toolbar).getByRole('button', { name: i18nService.t('coworkImagePreviewReset') }),
  );
  expect(image.style.transform).toContain('scale(1)');

  fireEvent.click(screen.getByRole('tab', { name: 'archive.zip' }));
  expect(
    within(toolbar).queryByRole('button', { name: i18nService.t('coworkImagePreviewReset') }),
  ).toBeNull();
  fireEvent.click(
    within(toolbar).getByRole('button', {
      name: i18nService.t('coworkUnsupportedFileOpenDefault'),
    }),
  );
  await waitFor(() => expect(shell.openPath).toHaveBeenCalledWith(unsupportedPath));
  await waitFor(() =>
    expect(
      (
        within(toolbar).getByRole('button', {
          name: i18nService.t('coworkUnsupportedFileOpenWith'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    within(toolbar).getByRole('button', { name: i18nService.t('coworkUnsupportedFileOpenWith') }),
  );
  await waitFor(() => expect(shell.openPathWith).toHaveBeenCalledWith(unsupportedPath));
  expect(within(toolbar).queryByRole('button', { name: 'Close' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close: archive.zip' }));
  expect(within(toolbar).getByText('E:')).toBeTruthy();
});
