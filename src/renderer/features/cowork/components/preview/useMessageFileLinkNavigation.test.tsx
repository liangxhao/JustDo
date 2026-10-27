/** @vitest-environment jsdom */
import {
  MessageFileLinkPreparationError,
  MessageFileLinkSourceKind,
  type PrepareMessageFileLinkResult,
} from '@shared/preview/messageFileLink';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { OpenLocalHtmlOptions } from '../display/tabs/useCoworkBrowserPanels';
import type { OpenFilePreviewOptions } from './useFilePreviewEvents';
import { useMessageFileLinkNavigation } from './useMessageFileLinkNavigation';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const relativeTarget = {
  sourceKind: MessageFileLinkSourceKind.MarkdownUri,
  target: './output/report.pdf',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const prepare = vi
    .fn<(request: unknown) => Promise<PrepareMessageFileLinkResult>>()
    .mockResolvedValue({ success: true, filePath: 'E:/project/output/report.pdf' });
  vi.stubGlobal('electron', { shell: { prepareMessageFileLink: prepare } });
  const filePreviewRequestIdRef = { current: 0 };
  const openFilePreview = vi
    .fn<(detail: OpenFilePreviewOptions) => Promise<void>>()
    .mockImplementation(async () => {
      filePreviewRequestIdRef.current += 1;
    });
  const openLocalHtml = vi
    .fn<(detail: OpenLocalHtmlOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const options = {
    workspaceSessionId: 'session-a' as string | undefined,
    projectRoot: 'E:/project',
    filePreviewRequestIdRef,
    openFilePreview,
    openLocalHtml,
  };
  const hook = renderHook(props => useMessageFileLinkNavigation(props), { initialProps: options });
  return { ...hook, options, prepare, openFilePreview, openLocalHtml, filePreviewRequestIdRef };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('prepares with the project at click time and routes only the canonical file', async () => {
  const harness = setup();
  const retainedCallback = harness.result.current;
  harness.rerender({
    ...harness.options,
    workspaceSessionId: 'session-b',
    projectRoot: 'E:/other',
  });
  await act(async () => retainedCallback(relativeTarget));
  expect(harness.prepare).toHaveBeenCalledWith({
    ...relativeTarget,
    workspaceSessionId: 'session-b',
    expectedProjectRoot: 'E:/other',
  });
  expect(harness.openFilePreview).toHaveBeenCalledWith({
    filePath: 'E:/project/output/report.pdf',
    keepWorkspaceFilesOpen: true,
    isCurrent: expect.any(Function),
  });
  expect(harness.openFilePreview.mock.calls[0][0].isCurrent!()).toBe(true);
  expect(harness.openLocalHtml).not.toHaveBeenCalled();
});

test.each(['project', 'session', 'unmount', 'new preview', 'return to project'])(
  'discards preparation after %s changes',
  async change => {
    const harness = setup();
    const pending = deferred<PrepareMessageFileLinkResult>();
    harness.prepare.mockReturnValueOnce(pending.promise);
    act(() => harness.result.current(relativeTarget));
    if (change === 'project' || change === 'return to project') {
      harness.rerender({ ...harness.options, projectRoot: 'E:/other' });
      if (change === 'return to project') harness.rerender(harness.options);
    } else if (change === 'session') {
      harness.rerender({ ...harness.options, workspaceSessionId: 'session-b' });
    } else if (change === 'unmount') {
      harness.unmount();
    } else {
      harness.filePreviewRequestIdRef.current += 1;
    }
    await act(async () => pending.resolve({ success: true, filePath: 'E:/old/report.pdf' }));
    expect(harness.openFilePreview).not.toHaveBeenCalled();
    expect(harness.openLocalHtml).not.toHaveBeenCalled();
  },
);

test('a newer message click supersedes a slower preparation', async () => {
  const harness = setup();
  const pending = deferred<PrepareMessageFileLinkResult>();
  harness.prepare.mockReturnValueOnce(pending.promise);
  act(() => harness.result.current(relativeTarget));
  await act(async () => harness.result.current({ ...relativeTarget, target: './new.pdf' }));
  await act(async () => pending.resolve({ success: true, filePath: 'E:/old.pdf' }));
  expect(harness.openFilePreview).toHaveBeenCalledOnce();
  expect(harness.openFilePreview.mock.calls[0][0].filePath).not.toBe('E:/old.pdf');
});

test('passes a continuing guard to HTML and invalidates it on later file navigation', async () => {
  const harness = setup();
  harness.prepare.mockResolvedValue({
    success: true,
    filePath: 'E:/project/report.html',
    navigationSuffix: '#part',
  });
  await act(async () => harness.result.current({ ...relativeTarget, target: './report.html' }));
  const detail = harness.openLocalHtml.mock.calls[0][0];
  expect(detail).toMatchObject({
    filePath: 'E:/project/report.html',
    navigationSuffix: '#part',
    workingDirectory: 'E:/project',
    currentSessionOnly: true,
  });
  expect(detail.isCurrent!()).toBe(true);
  harness.filePreviewRequestIdRef.current += 1;
  expect(detail.isCurrent!()).toBe(false);
  expect(harness.openFilePreview).not.toHaveBeenCalled();
});

test('an unbound relative target receives no invented project and reports failure', async () => {
  const harness = setup();
  harness.prepare.mockResolvedValue({
    success: false,
    error: MessageFileLinkPreparationError.MissingSource,
  });
  harness.rerender({ ...harness.options, workspaceSessionId: undefined, projectRoot: '' });
  const toasts: string[] = [];
  const onToast = (event: Event) => {
    toasts.push((event as CustomEvent<string>).detail);
  };
  window.addEventListener('app:showToast', onToast);
  try {
    await act(async () => harness.result.current(relativeTarget));
    expect(harness.prepare).toHaveBeenCalledWith(relativeTarget);
    expect(toasts).toEqual(['messageFileLinkNoProject']);
    expect(harness.openFilePreview).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('app:showToast', onToast);
  }
});

test('preserves the old HTML slash-root adapter without admitting generic slash paths', async () => {
  const harness = setup();
  await act(async () =>
    harness.result.current(
      {
        sourceKind: MessageFileLinkSourceKind.NativePath,
        target: '/tmp/report.html',
        navigationSuffix: '?mode=read#part',
      },
      { legacyHtml: true },
    ),
  );
  expect(harness.prepare).not.toHaveBeenCalled();
  expect(harness.openLocalHtml.mock.calls[0][0].filePath).toBe('/tmp/report.html');
  await act(async () =>
    harness.result.current({
      sourceKind: MessageFileLinkSourceKind.NativePath,
      target: '/tmp/report.pdf',
    }),
  );
  expect(harness.prepare).toHaveBeenCalledOnce();
});
