// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SessionReviewPanel from './SessionReviewPanel';

const load = vi.fn();
const file = vi.fn();
const copy = vi.fn();
const t = (key: string) => i18nService.t(key);
const result = (path: string) => ({
  success: true,
  diff: {
    sessionKey: 'native',
    files: [
      { path, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
    ],
    additions: 1,
    deletions: 1,
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', cowork: { review: { load, file } } },
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: copy.mockResolvedValue(undefined) },
  });
});
afterEach(cleanup);

test('reuses a loaded review when reopening the panel and refreshes only on request', async () => {
  load.mockResolvedValue(result('stable.ts'));
  const view = render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  fireEvent.click(await screen.findByText('stable.ts', { selector: '.review-file-heading *' }));
  view.rerender(<SessionReviewPanel sessionId="one" visible={false} onOpenFile={vi.fn()} />);
  view.rerender(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByText('new')).toBeTruthy();
  expect(screen.getByText(t('reviewSnapshot'))).toBeTruthy();
  load.mockResolvedValue(result('fresh.ts'));
  fireEvent.click(screen.getByText(t('reviewRefresh')));
  await screen.findByText('fresh.ts', { selector: '.review-file-heading *' });
  expect(load).toHaveBeenCalledTimes(2);
});

test('joins the pending read across tab switches and Strict Mode effect replay', async () => {
  let settle!: (value: unknown) => void;
  load.mockImplementation(
    () =>
      new Promise(resolve => {
        settle = resolve;
      }),
  );
  const panel = (visible: boolean) => (
    <StrictMode>
      <SessionReviewPanel sessionId="one" visible={visible} onOpenFile={vi.fn()} />
    </StrictMode>
  );
  const view = render(panel(true));
  view.rerender(panel(false));
  view.rerender(panel(true));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => settle(result('joined.ts')));
  expect(screen.getByText('joined.ts', { selector: '.review-file-heading *' })).toBeTruthy();
});

test('retries a failed read when reopening the panel', async () => {
  load
    .mockResolvedValueOnce({ success: false, reason: 'unavailable' })
    .mockResolvedValue(result('retry.ts'));
  const view = render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  await screen.findByRole('alert');
  view.rerender(<SessionReviewPanel sessionId="one" visible={false} onOpenFile={vi.fn()} />);
  view.rerender(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  await screen.findByText('retry.ts', { selector: '.review-file-heading *' });
  expect(load).toHaveBeenCalledTimes(2);
});
test('keeps the screen mounted and explains restart when the window has an older preload', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', cowork: {} },
  });
  render(
    <StrictMode>
      <div>Chat remains available</div>
      <SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />
    </StrictMode>,
  );
  expect(await screen.findByText(t('reviewError_bridge'))).toBeTruthy();
  expect(screen.getByText('Chat remains available')).toBeTruthy();
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(t('reviewRefresh')));
  expect(screen.getByText(t('reviewError_bridge'))).toBeTruthy();
});

test('handles a synchronous bridge failure without unmounting the screen', async () => {
  load.mockImplementation(() => {
    throw new Error('bridge failure');
  });
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  expect(await screen.findByText(t('reviewError_unavailable'))).toBeTruthy();
  load.mockResolvedValue(result('recovered.ts'));
  fireEvent.click(screen.getByText(t('reviewRefresh')));
  expect(
    await screen.findByText('recovered.ts', { selector: '.review-file-heading *' }),
  ).toBeTruthy();
});

test('drops delayed results after changing scope and hides the previous scope immediately', async () => {
  let settle!: (value: unknown) => void;
  load
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          settle = resolve;
        }),
    )
    .mockResolvedValueOnce(result('current.ts'));
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'uncommitted' } });
  expect(
    await screen.findByText('current.ts', { selector: '.review-file-heading *' }),
  ).toBeTruthy();
  await act(async () => settle(result('obsolete.ts')));
  expect(screen.queryByText('obsolete.ts', { selector: '.review-file-heading *' })).toBeNull();
  expect(load.mock.calls[1][0]).toEqual({ sessionId: 'one', scope: 'uncommitted' });
});
test('keeps the last snapshot on refresh failure and distinguishes unavailable from empty', async () => {
  load
    .mockResolvedValueOnce(result('kept.ts'))
    .mockResolvedValueOnce({ success: false, reason: 'unavailable' });
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  await screen.findByText('kept.ts', { selector: '.review-file-heading *' });
  fireEvent.click(screen.getByText(t('reviewRefresh')));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    `${t('reviewError_unavailable')} ${t('reviewStale')}`,
  );
  expect(screen.getByText('kept.ts', { selector: '.review-file-heading *' })).toBeTruthy();
  expect(screen.queryByText(t('reviewEmpty'))).toBeNull();
});

test('preserves expanded patch lines while refreshing and after refresh failure', async () => {
  const response = result('long.ts');
  response.diff.files[0].patch =
    '@@ -0,0 +1,300 @@\n' + Array.from({ length: 300 }, (_, index) => `+line${index}`).join('\n');
  let settle!: (value: unknown) => void;
  load.mockResolvedValueOnce(response).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        settle = resolve;
      }),
  );
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  fireEvent.click(await screen.findByText('long.ts', { selector: '.review-file-heading *' }));
  expect(screen.queryByText('line299')).toBeNull();
  fireEvent.click(screen.getByText(t('reviewMoreLines')));
  expect(screen.getByText('line299')).toBeTruthy();
  fireEvent.click(screen.getByText(t('reviewRefresh')));
  expect(screen.getByText('line299')).toBeTruthy();
  await act(async () => settle({ success: false, reason: 'unavailable' }));
  expect(screen.getByText('line299')).toBeTruthy();
});
test('does not load while hidden and marks completed runs without replacing the diff', async () => {
  load.mockResolvedValue(result('stable.ts'));
  const view = render(
    <SessionReviewPanel sessionId="one" visible={false} running onOpenFile={vi.fn()} />,
  );
  expect(load).not.toHaveBeenCalled();
  view.rerender(<SessionReviewPanel sessionId="one" visible running onOpenFile={vi.fn()} />);
  await screen.findByText('stable.ts', { selector: '.review-file-heading *' });
  view.rerender(
    <SessionReviewPanel sessionId="one" visible running={false} onOpenFile={vi.fn()} />,
  );
  expect(screen.getByText(t('reviewUpdated'))).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
});
test('copies exact Chinese paths and patches and never opens remote files', async () => {
  load.mockResolvedValue(result('中文 文件.ts'));
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  fireEvent.click(await screen.findByText('中文 文件.ts', { selector: '.review-file-heading *' }));
  fireEvent.click(screen.getByText(t('reviewCopyPath')));
  await waitFor(() => expect(copy).toHaveBeenCalledWith('中文 文件.ts'));
  fireEvent.click(screen.getByText(t('reviewCopyPatch')));
  expect(copy).toHaveBeenCalledWith('@@ -1 +1 @@\n-old\n+new');
  expect((screen.getByText(t('reviewAction_editor')) as HTMLButtonElement).disabled).toBe(true);
  expect(file).not.toHaveBeenCalled();
});
test.each(['not_git', 'unknown_commit', 'workspace_stopped', 'unknown_session'])(
  'renders the native %s reason',
  async reason => {
    load.mockResolvedValue({
      success: true,
      diff: {
        sessionKey: 'native',
        files: [],
        additions: 0,
        deletions: 0,
        unavailableReason: reason,
      },
    });
    render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
    expect(await screen.findByText(t(`reviewUnavailable_${reason}`))).toBeTruthy();
    expect(screen.queryByText(t('reviewEmpty'))).toBeNull();
  },
);
test('does not let a previous session response overwrite the active session', async () => {
  let settle!: (value: unknown) => void;
  load
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          settle = resolve;
        }),
    )
    .mockResolvedValueOnce(result('new-session.ts'));
  const view = render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  view.rerender(<SessionReviewPanel sessionId="two" visible onOpenFile={vi.fn()} />);
  await screen.findByText('new-session.ts', { selector: '.review-file-heading *' });
  await act(async () => settle(result('old-session.ts')));
  expect(screen.queryByText('old-session.ts', { selector: '.review-file-heading *' })).toBeNull();
});

test('shows absent patches explicitly for binary, truncated and renamed files', async () => {
  const response = result('image.png');
  response.diff.files = [
    {
      path: 'image.png',
      status: 'added',
      binary: true,
      untracked: true,
      additions: 0,
      deletions: 0,
    },
    { path: 'large.txt', status: 'modified', truncated: true, additions: 0, deletions: 0 },
    { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', additions: 0, deletions: 0 },
  ] as never;
  load.mockResolvedValue(response);
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  fireEvent.click(await screen.findByText('image.png', { selector: '.review-file-heading *' }));
  expect(screen.getByText(t('reviewBinary'))).toBeTruthy();
  expect(screen.getByTitle(t('reviewUntracked')).textContent).toBe('U');
  fireEvent.click(screen.getByText('large.txt', { selector: '.review-file-heading *' }));
  expect(screen.getByText(t('reviewTruncated'))).toBeTruthy();
  fireEvent.click(screen.getByTitle('old.ts → new.ts'));
  expect(screen.getAllByText(t('reviewNoPatch'))).toHaveLength(2);
});

test('focuses only the longest matching path and preserves later filtering on refresh', async () => {
  const response = result('file.ts');
  response.diff.files.push({ ...response.diff.files[0], path: 'src/file.ts' });
  load.mockResolvedValue(response);
  render(
    <SessionReviewPanel
      sessionId="one"
      visible
      focusPath={'C:\\repo\\src\\file.ts'}
      focusVersion={1}
      onOpenFile={vi.fn()}
    />,
  );
  await screen.findByTitle('src/file.ts');
  expect(screen.getByTitle('file.ts').closest('button')?.getAttribute('aria-expanded')).toBe(
    'false',
  );
  expect(screen.getByTitle('src/file.ts').closest('button')?.getAttribute('aria-expanded')).toBe(
    'true',
  );
  fireEvent.change(screen.getByLabelText(t('reviewFilter')), { target: { value: 'src/' } });
  fireEvent.click(screen.getByText(t('reviewRefresh')));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByLabelText(t('reviewFilter'))).toHaveProperty('value', 'src/'),
  );
  expect(screen.queryByTitle('file.ts')).toBeNull();
});

test('does not reopen preview when a pending file action completes after hiding and reopening review', async () => {
  const response = { ...result('file.ts'), diff: { ...result('file.ts').diff, root: 'C:/repo' } };
  load.mockResolvedValue(response);
  let settle!: (value: unknown) => void;
  file.mockImplementation(
    () =>
      new Promise(resolve => {
        settle = resolve;
      }),
  );
  const onOpenFile = vi.fn();
  const view = render(<SessionReviewPanel sessionId="one" visible onOpenFile={onOpenFile} />);
  fireEvent.click(await screen.findByText('file.ts', { selector: '.review-file-heading *' }));
  fireEvent.click(screen.getByLabelText(t('reviewFileActions')));
  fireEvent.click(screen.getByText(t('reviewAction_preview')));
  view.rerender(<SessionReviewPanel sessionId="one" visible={false} onOpenFile={onOpenFile} />);
  view.rerender(<SessionReviewPanel sessionId="one" visible onOpenFile={onOpenFile} />);
  await act(async () =>
    settle({ success: true, filePath: 'C:/repo/file.ts', relativePath: 'file.ts' }),
  );
  expect(onOpenFile).not.toHaveBeenCalled();
});

test('does not scroll back to an old focus on refresh but honors a repeated jump', async () => {
  const scrollIntoView = vi.fn();
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  try {
    load.mockImplementation(async () => result('file.ts'));
    const view = render(
      <SessionReviewPanel
        sessionId="one"
        visible
        focusPath="file.ts"
        focusVersion={1}
        onOpenFile={vi.fn()}
      />,
    );
    await screen.findByText('file.ts', { selector: '.review-file-heading *' });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(t('reviewRefresh')));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(t('reviewFilter')), { target: { value: 'hidden' } });
    view.rerender(
      <SessionReviewPanel
        sessionId="one"
        visible
        focusPath="file.ts"
        focusVersion={2}
        onOpenFile={vi.fn()}
      />,
    );
    await screen.findByText('file.ts', { selector: '.review-file-heading *' });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScroll;
  }
});

test('reveals and scrolls to a new focus beyond the initial file page', async () => {
  const scrolled: string[] = [];
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.textContent ?? '');
  };
  try {
    const response = result('first.ts');
    response.diff.files.push(
      ...Array.from({ length: 101 }, (_, index) => ({
        ...response.diff.files[0],
        path: `file-${index}.ts`,
      })),
    );
    load.mockResolvedValue(response);
    const view = render(
      <SessionReviewPanel
        sessionId="one"
        visible
        focusPath="first.ts"
        focusVersion={1}
        onOpenFile={vi.fn()}
      />,
    );
    await screen.findByText('first.ts', { selector: '.review-file-heading *' });
    expect(screen.queryByText('file-100.ts', { selector: '.review-file-heading *' })).toBeNull();
    view.rerender(
      <SessionReviewPanel
        sessionId="one"
        visible
        focusPath="file-100.ts"
        focusVersion={2}
        onOpenFile={vi.fn()}
      />,
    );
    await screen.findByText('file-100.ts', { selector: '.review-file-heading *' });
    expect(scrolled).toHaveLength(2);
    expect(scrolled[1]).toContain('file-100.ts');
    expect(
      screen
        .getByText('file-100.ts', { selector: '.review-file-heading *' })
        .closest('button')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScroll;
  }
});

test('opens a diff from the directory index without invoking a file action', async () => {
  load.mockResolvedValue(result('src/nested/change.ts'));
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  const navigationFile = await screen.findByRole('button', { name: 'src/nested/change.ts' });
  fireEvent.click(navigationFile);
  expect(navigationFile.getAttribute('aria-current')).toBe('location');
  expect(
    screen.getByTitle('src/nested/change.ts').closest('button')?.getAttribute('aria-expanded'),
  ).toBe('true');
  expect(screen.getByText('old')).toBeTruthy();
  expect(file).not.toHaveBeenCalled();
});

test('shows temporary copy feedback on the clicked button and reports clipboard failures separately', async () => {
  load.mockResolvedValue(result('file.ts'));
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  fireEvent.click(await screen.findByText('file.ts', { selector: '.review-file-heading *' }));
  fireEvent.click(screen.getByLabelText(t('reviewFileActions')));
  vi.useFakeTimers();
  try {
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: t('reviewCopyPath') })),
    );
    expect(copy).toHaveBeenCalledWith('file.ts');
    expect(screen.getByRole('button', { name: t('reviewCopied') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('reviewCopyPatch') })).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByText(t('reviewCopied'))).toBeNull();
    copy.mockRejectedValueOnce(new Error('clipboard denied'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: t('reviewCopyPath') })),
    );
    expect(screen.getByRole('alert').textContent).toBe(t('reviewError_copy'));
  } finally {
    vi.useRealTimers();
  }
});

test('ignores delayed clipboard feedback after changing the comparison scope', async () => {
  let settle!: () => void;
  copy.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        settle = resolve;
      }),
  );
  load.mockResolvedValue(result('file.ts'));
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  fireEvent.click(await screen.findByText('file.ts', { selector: '.review-file-heading *' }));
  fireEvent.click(screen.getByLabelText(t('reviewFileActions')));
  fireEvent.click(screen.getByRole('button', { name: t('reviewCopyPath') }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'uncommitted' } });
  await act(async () => settle());
  expect(screen.queryByText(t('reviewCopied'))).toBeNull();
});

test('tracks the first visible file while scrolling the diff', async () => {
  const response = result('first.ts');
  response.diff.files.push({ ...response.diff.files[0], path: 'second.ts' });
  load.mockResolvedValue(response);
  const { container } = render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  await screen.findByRole('button', { name: 'second.ts' });
  const articles = container.querySelectorAll('article');
  vi.spyOn(articles[0], 'getBoundingClientRect').mockReturnValue({ bottom: -10 } as DOMRect);
  vi.spyOn(articles[1], 'getBoundingClientRect').mockReturnValue({ bottom: 100 } as DOMRect);
  fireEvent.scroll(container.querySelector('.review-content')!);
  expect(screen.getByRole('button', { name: 'second.ts' }).getAttribute('aria-current')).toBe(
    'location',
  );
  expect(screen.getByRole('button', { name: 'first.ts' }).hasAttribute('aria-current')).toBe(false);
});

test('opens the workspace folder and keeps truncation details inside the explanation', async () => {
  const openPath = vi.fn().mockResolvedValue({ success: true });
  Object.assign(window.electron, { shell: { openPath } });
  const response = result('changed.ts');
  load.mockResolvedValue({
    ...response,
    diff: { ...response.diff, root: 'C:/workspace', truncated: true },
  });
  render(<SessionReviewPanel sessionId="one" visible onOpenFile={vi.fn()} />);
  const open = await screen.findByRole('button', { name: t('reviewOpenFolder') });
  expect(screen.queryByText('C:/workspace')).toBeNull();
  fireEvent.click(open);
  await waitFor(() => expect(openPath).toHaveBeenCalledWith('C:/workspace'));
  const notice = screen.getByText(t('reviewTruncated'));
  expect(notice.closest('.review-explanation')?.hasAttribute('hidden')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: t('reviewAbout') }));
  expect(notice.closest('.review-explanation')?.hasAttribute('hidden')).toBe(false);
  openPath.mockResolvedValue({ success: false });
  fireEvent.click(open);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('reviewError_file'));
});
