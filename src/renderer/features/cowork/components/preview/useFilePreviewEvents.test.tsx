/** @vitest-environment jsdom */
import type { FilePreviewReadResult } from '@shared/preview/filePreview';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { WORKSPACE_FILES_DISPLAY_TAB_ID } from '../display/displayTabIds';
import { useSessionDisplayState } from '../display/useSessionDisplayState';
import type { OpenMcpAppFile } from '../mcpApps/fileApps';
import { IMAGE_PREVIEW_EVENT } from './imageFilePreview';
import { useFilePreviewEvents } from './useFilePreviewEvents';

const fileDisplayTabId = (path: string) => `file:${path.replace(/\\/g, '/')}`;
const imageSource = 'data:image/png;base64,AA==';

function usePreviewHarness(openAppFile?: OpenMcpAppFile) {
  const currentSessionIdRef = useRef<string | null>('session-a');
  const navigationScope = useRef({});
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
    openAppFile,
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
    captureNavigationScope: () => {
      const scope = navigationScope.current;
      return () => scope === navigationScope.current;
    },
    switchSession: (sessionId = 'session-b') => {
      if (currentSessionIdRef.current !== sessionId) navigationScope.current = {};
      currentSessionIdRef.current = sessionId;
    },
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

test('a discovered file app handles a spreadsheet before the text preview reads it', async () => {
  const readPreviewFile = vi.fn();
  const openAppFile = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('electron', { shell: { readPreviewFile } });
  const { result } = renderHook(() => usePreviewHarness(openAppFile));
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('cowork:preview-file', { detail: { filePath: 'E:/预算.xlsx' } }),
    ),
  );
  expect(openAppFile).toHaveBeenCalledWith({
    filePath: 'E:/预算.xlsx',
    isCurrent: expect.any(Function),
  });
  expect(readPreviewFile).not.toHaveBeenCalled();
  expect(result.current.unsupportedFilePreviews).toEqual([]);
});

test('unavailable file apps preserve the ordinary unsupported-file preview', async () => {
  const readPreviewFile = vi.fn().mockResolvedValue({ success: false, unsupportedType: true });
  vi.stubGlobal('electron', { shell: { readPreviewFile } });
  const { result } = renderHook(() => usePreviewHarness(async () => false));
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('cowork:preview-file', { detail: { filePath: 'E:/预算.xlsx' } }),
    ),
  );
  expect(readPreviewFile).toHaveBeenCalledOnce();
  expect(result.current.unsupportedFilePreviews).toEqual(['E:/预算.xlsx']);
});

test('switching session while the app opens cannot fall back into the new session', async () => {
  let finish!: (opened: boolean) => void;
  const openAppFile = vi.fn(
    (_request: Parameters<OpenMcpAppFile>[0]) =>
      new Promise<boolean>(resolve => {
        finish = resolve;
      }),
  );
  const readPreviewFile = vi.fn();
  vi.stubGlobal('electron', { shell: { readPreviewFile } });
  const { result } = renderHook(() => usePreviewHarness(openAppFile));
  act(() => {
    window.dispatchEvent(
      new CustomEvent('cowork:preview-file', { detail: { filePath: 'E:/预算.xlsx' } }),
    );
    result.current.switchSession();
  });
  expect(openAppFile.mock.calls[0][0].isCurrent()).toBe(false);
  await act(async () => finish(false));
  expect(readPreviewFile).not.toHaveBeenCalled();
});

test.each(['unsupported', 'too-large', 'existing-unsupported'])(
  'opens the original %s file with the system tool when requested by Summary',
  async kind => {
    const filePath = 'E:/output/report.docx';
    const readPreviewFile = vi
      .fn()
      .mockResolvedValue(
        kind === 'too-large'
          ? { success: false, tooLarge: true }
          : { success: false, unsupportedType: true },
      );
    const openPath = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('electron', { shell: { readPreviewFile, openPath } });
    const { result } = renderHook(usePreviewHarness);
    if (kind === 'existing-unsupported') {
      await act(async () => {
        window.dispatchEvent(new CustomEvent('cowork:preview-file', { detail: { filePath } }));
      });
      expect(result.current.unsupportedFilePreviews).toEqual([filePath]);
    }
    const previousTab = result.current.preferredDisplayTabId;
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cowork:preview-file', {
          detail: { filePath, workingDirectory: 'E:/output', openUnsupportedInSystem: true },
        }),
      );
    });
    expect(openPath).toHaveBeenCalledWith(filePath, 'E:/output');
    expect(result.current.filePreviews).toEqual([]);
    expect(result.current.preferredDisplayTabId).toBe(previousTab);
    if (kind !== 'existing-unsupported') expect(result.current.unsupportedFilePreviews).toEqual([]);
  },
);

test('keeps a supported Summary file in the normal preview and never opens the system tool', async () => {
  const filePath = 'E:/output/report.md';
  const readPreviewFile = vi.fn().mockResolvedValue({
    success: true,
    filePath,
    content: 'report',
    editToken: 'grant',
    version: '1',
  });
  const openPath = vi.fn();
  vi.stubGlobal('electron', { shell: { readPreviewFile, openPath } });
  const { result } = renderHook(usePreviewHarness);
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('cowork:preview-file', {
        detail: { filePath, openUnsupportedInSystem: true },
      }),
    );
  });
  expect(result.current.filePreviews).toHaveLength(1);
  expect(result.current.preferredDisplayTabId).toBe(fileDisplayTabId(filePath));
  expect(openPath).not.toHaveBeenCalled();
});

test('does not open an unsupported Summary file after switching sessions during preview inspection', async () => {
  let finishRead!: (result: FilePreviewReadResult) => void;
  const readPreviewFile = vi.fn(
    () =>
      new Promise<FilePreviewReadResult>(resolve => {
        finishRead = resolve;
      }),
  );
  const openPath = vi.fn();
  vi.stubGlobal('electron', { shell: { readPreviewFile, openPath } });
  const { result } = renderHook(usePreviewHarness);
  act(() => {
    window.dispatchEvent(
      new CustomEvent('cowork:preview-file', {
        detail: { filePath: 'E:/output/report.docx', openUnsupportedInSystem: true },
      }),
    );
    result.current.switchSession();
  });
  await act(async () => {
    finishRead({ success: false, unsupportedType: true });
  });
  expect(openPath).not.toHaveBeenCalled();
  expect(result.current.filePreviews).toEqual([]);
});

test.each(['unsupported', 'supported', 'error'])(
  'ignores a late %s Summary file result after switching away and back to the same session',
  async kind => {
    let finishRead!: (result: FilePreviewReadResult) => void;
    let rejectRead!: (error: Error) => void;
    const readPreviewFile = vi.fn(
      () =>
        new Promise<FilePreviewReadResult>((resolve, reject) => {
          finishRead = resolve;
          rejectRead = reject;
        }),
    );
    const openPath = vi.fn();
    const revokePreviewFileEdit = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electron', { shell: { readPreviewFile, openPath, revokePreviewFileEdit } });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const { result } = renderHook(usePreviewHarness);
    act(() => {
      window.dispatchEvent(
        new CustomEvent('cowork:preview-file', {
          detail: {
            filePath: 'E:/output/report.md',
            openUnsupportedInSystem: true,
            isCurrent: result.current.captureNavigationScope(),
          },
        }),
      );
      result.current.switchSession();
      result.current.switchSession('session-a');
    });
    dispatch.mockClear();
    await act(async () => {
      if (kind === 'error') rejectRead(new Error('read failed'));
      else
        finishRead(
          kind === 'unsupported'
            ? { success: false, unsupportedType: true }
            : {
                success: true,
                filePath: 'E:/output/report.md',
                content: 'report',
                editToken: 'old-grant',
                version: '1',
              },
        );
    });
    expect(openPath).not.toHaveBeenCalled();
    expect(result.current.filePreviews).toEqual([]);
    expect(result.current.unsupportedFilePreviews).toEqual([]);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'app:showToast' }));
    if (kind === 'supported') expect(revokePreviewFileEdit).toHaveBeenCalledWith('old-grant');
  },
);

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

test.each(['html', 'image', 'existing', 'unsupported'])(
  'preserves the visible file tree by default when opening an %s file',
  async kind => {
    const filePath = kind === 'image' ? 'E:/page.png' : 'E:/page.html';
    const readPreviewFile = vi
      .fn()
      .mockResolvedValue(
        kind === 'unsupported'
          ? { success: false, unsupportedType: true }
          : { success: true, filePath, content: '<h1>Page</h1>', editToken: 'grant', version: '1' },
      );
    vi.stubGlobal('electron', { shell: { readPreviewFile } });
    const { result } = renderHook(usePreviewHarness);
    const openFile = () =>
      window.dispatchEvent(new CustomEvent('cowork:preview-file', { detail: { filePath } }));
    if (kind === 'existing')
      await act(async () => {
        openFile();
      });
    act(() => result.current.openFiles());
    await act(async () => {
      openFile();
    });
    expect(result.current.isWorkspaceFilesOpen).toBe(true);
    expect(result.current.preferredDisplayTabId).toBe(fileDisplayTabId(filePath));
  },
);

test('still honors an explicit request to hide the file tree', async () => {
  const filePath = 'E:/page.html';
  const readPreviewFile = vi.fn().mockResolvedValue({
    success: true,
    filePath,
    content: '<h1>Page</h1>',
    editToken: 'grant',
    version: '1',
  });
  vi.stubGlobal('electron', { shell: { readPreviewFile } });
  const { result } = renderHook(usePreviewHarness);
  act(() => result.current.openFiles());
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('cowork:preview-file', {
        detail: { filePath, keepWorkspaceFilesOpen: false },
      }),
    );
  });
  expect(result.current.isWorkspaceFilesOpen).toBe(false);
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
