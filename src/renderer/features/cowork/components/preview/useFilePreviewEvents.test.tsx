/** @vitest-environment jsdom */
import type { FilePreviewReadResult } from '@shared/preview/filePreview';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { WORKSPACE_FILES_DISPLAY_TAB_ID } from '../display/displayTabIds';
import { useSessionDisplayState } from '../display/useSessionDisplayState';
import { IMAGE_PREVIEW_EVENT } from './imageFilePreview';
import { useFilePreviewEvents } from './useFilePreviewEvents';

const fileDisplayTabId = (path: string) => `file:${path.replace(/\\/g, '/')}`;
const imageSource = 'data:image/png;base64,AA==';

function usePreviewHarness() {
  const currentSessionIdRef = useRef<string | null>('session-a');
  const filePreviewRequestIdRef = useRef(0);
  const { state, setters } = useSessionDisplayState('session-a', 520);
  const { filePreviews, unsupportedFilePreviews } = state;
  const {
    setFilePreviews,
    setUnsupportedFilePreviews,
    setPreferredDisplayTabId,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
  } = setters;
  const filePreviewsRef = useRef(filePreviews);
  const unsupportedFilePreviewsRef = useRef(unsupportedFilePreviews);
  filePreviewsRef.current = filePreviews;
  unsupportedFilePreviewsRef.current = unsupportedFilePreviews;
  useFilePreviewEvents({
    currentSessionIdRef,
    filePreviewRequestIdRef,
    filePreviewsRef,
    unsupportedFilePreviewsRef,
    fileDisplayTabId,
    setFilePreviews,
    setUnsupportedFilePreviews,
    setPreferredDisplayTabId,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
  });
  return {
    ...state,
    openFiles: () => {
      setters.setIsWorkspaceFilesTabOpen(true);
      setIsWorkspaceFilesOpen(true);
      setPreferredDisplayTabId(WORKSPACE_FILES_DISPLAY_TAB_ID);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each(['text', 'image', 'unsupported', 'existing'])(
  'replaces the open-file tab when a %s preview opens from the workspace tree',
  async kind => {
    const filePath = kind === 'image' ? 'E:/notes.png' : 'E:/notes.md';
    const readPreviewFile = vi
      .fn()
      .mockResolvedValue(
        kind === 'unsupported'
          ? { success: false, unsupportedType: true }
          : { success: true, filePath, content: 'notes', editToken: 'grant', version: '1' },
      );
    vi.stubGlobal('electron', { shell: { readPreviewFile } });
    const { result } = renderHook(usePreviewHarness);
    const selectFile = () =>
      window.dispatchEvent(
        new CustomEvent('cowork:preview-file', {
          detail: { filePath, keepWorkspaceFilesOpen: true },
        }),
      );
    if (kind === 'existing')
      await act(async () => {
        selectFile();
      });
    act(() => result.current.openFiles());
    expect(result.current.isWorkspaceFilesTabOpen).toBe(true);
    expect(result.current.preferredDisplayTabId).toBe(WORKSPACE_FILES_DISPLAY_TAB_ID);
    await act(async () => {
      selectFile();
    });
    expect(result.current.isWorkspaceFilesTabOpen).toBe(false);
    expect(result.current.isWorkspaceFilesOpen).toBe(true);
    expect(result.current.preferredDisplayTabId).toBe(fileDisplayTabId(filePath));
    if (kind !== 'unsupported') expect(result.current.filePreviews).toHaveLength(1);
    if (kind === 'existing') expect(readPreviewFile).toHaveBeenCalledTimes(1);
  },
);

test('keeps the open-file tab selected after the chosen file cannot be read', async () => {
  vi.stubGlobal('electron', {
    shell: { readPreviewFile: vi.fn().mockResolvedValue({ success: false, notFound: true }) },
  });
  const { result } = renderHook(usePreviewHarness);
  act(() => result.current.openFiles());
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('cowork:preview-file', {
        detail: { filePath: 'E:/missing.md', keepWorkspaceFilesOpen: true },
      }),
    );
  });
  expect(result.current.isWorkspaceFilesTabOpen).toBe(true);
  expect(result.current.preferredDisplayTabId).toBe(WORKSPACE_FILES_DISPLAY_TAB_ID);
  expect(result.current.filePreviews).toHaveLength(0);
});

test('reuses the image preview tab when a recording screenshot is opened repeatedly', () => {
  const { result } = renderHook(usePreviewHarness);
  const openScreenshot = () =>
    window.dispatchEvent(
      new CustomEvent(IMAGE_PREVIEW_EVENT, {
        detail: { src: imageSource, alt: 'Step screenshot 1' },
      }),
    );
  act(() => {
    openScreenshot();
  });
  const tabId = result.current.preferredDisplayTabId;
  act(() => {
    openScreenshot();
    openScreenshot();
  });
  expect(result.current.filePreviews).toHaveLength(1);
  expect(result.current.filePreviews[0]).toMatchObject({ kind: 'image', src: imageSource });
  expect(result.current.preferredDisplayTabId).toBe(tabId);
  expect(result.current.isDisplayPanelOpen).toBe(true);
});

test.each(['file', 'thumbnail', 'existing-image'])(
  'keeps the %s selected when a slower text read completes',
  async entry => {
    let finishRead!: (result: FilePreviewReadResult) => void;
    const readPreviewFile = vi.fn(
      () =>
        new Promise<FilePreviewReadResult>(resolve => {
          finishRead = resolve;
        }),
    );
    const revokePreviewFileEdit = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electron', { shell: { readPreviewFile, revokePreviewFileEdit } });
    const { result } = renderHook(usePreviewHarness);
    const imageEvent = () =>
      entry === 'file'
        ? new CustomEvent('cowork:preview-file', { detail: { filePath: 'E:/output/image.png' } })
        : new CustomEvent(IMAGE_PREVIEW_EVENT, { detail: { src: imageSource, alt: 'image' } });
    if (entry === 'existing-image')
      act(() => {
        window.dispatchEvent(imageEvent());
      });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('cowork:preview-file', { detail: { filePath: 'E:/output/notes.txt' } }),
      );
    });
    act(() => {
      window.dispatchEvent(imageEvent());
    });
    const selectedImageTab = result.current.preferredDisplayTabId;
    expect(result.current.filePreviews).toHaveLength(1);
    expect(result.current.filePreviews[0].kind).toBe('image');
    expect(result.current.isDisplayPanelOpen).toBe(true);

    await act(async () => {
      finishRead({
        success: true,
        filePath: 'E:/output/notes.txt',
        content: 'notes',
        editToken: 'old-grant',
        version: '1',
      });
    });

    expect(result.current.preferredDisplayTabId).toBe(selectedImageTab);
    expect(result.current.filePreviews).toHaveLength(1);
    expect(revokePreviewFileEdit).toHaveBeenCalledWith('old-grant');
  },
);

test('does not surface errors from a text request superseded by an image', async () => {
  let rejectRead!: (error: Error) => void;
  const readPreviewFile = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  vi.stubGlobal('electron', { shell: { readPreviewFile } });
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  renderHook(usePreviewHarness);
  act(() => {
    window.dispatchEvent(
      new CustomEvent('cowork:preview-file', { detail: { filePath: 'E:/notes.txt' } }),
    );
  });
  act(() => {
    window.dispatchEvent(new CustomEvent(IMAGE_PREVIEW_EVENT, { detail: { src: imageSource } }));
  });
  dispatch.mockClear();
  await act(async () => {
    rejectRead(new Error('read failed'));
  });
  expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'app:showToast' }));
});
