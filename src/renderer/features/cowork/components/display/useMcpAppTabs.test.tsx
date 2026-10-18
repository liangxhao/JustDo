/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';

import {
  closeWorkspaceAppControls,
  type McpAppWorkspaceEntry,
  type McpAppWorkspaceFileEntry,
  openWorkspaceApp,
  openWorkspaceAppControls,
  openWorkspaceAppFile,
  openWorkspaceAppLaunch,
} from '../mcpApps/workspaceApps';
import { useMcpAppTabs } from './useMcpAppTabs';

vi.mock('@/libs/openclaw-chat/components/mcp-app/view', () => ({ McpAppView: class {} }));
vi.mock('@/libs/openclaw-chat/pipeline/native-mcp-app', () => ({
  isNativeMcpAppPreview: () => true,
}));
afterEach(cleanup);

test('file tabs keep the filename, focus the current view and replace invalidated views', () => {
  let current = true;
  const select = vi.fn(),
    open = vi.fn();
  const entry = {
    id: 'file-view:session:budget',
    sessionId: 'session',
    filePath: 'E:/预算.xlsx',
    label: '预算.xlsx',
    preview: { title: 'Univer', viewId: 'old' },
    context: { isCurrent: () => current } as McpAppViewContext,
  } as McpAppWorkspaceEntry;
  const { result } = renderHook(() => useMcpAppTabs('session', select, open));
  act(() => openWorkspaceApp(entry));
  expect(result.current.tabs[0].label).toBe('预算.xlsx');
  expect(result.current.focusFile('E:/预算.xlsx')).toBe(true);
  current = false;
  expect(result.current.focusFile('E:/预算.xlsx')).toBe(false);
  const next = {
    ...entry,
    preview: { ...entry.preview, viewId: 'new' },
    context: { isCurrent: () => true } as McpAppViewContext,
  };
  act(() => openWorkspaceApp(next));
  expect(result.current.tabs).toHaveLength(1);
  expect(result.current.panels(entry.id)[0].props.entry).toBe(next);
});

test('a file open in another session is never focused', () => {
  const { result } = renderHook(() => useMcpAppTabs('other', vi.fn(), vi.fn()));
  act(() =>
    openWorkspaceApp({
      id: 'file-view:source:budget',
      sessionId: 'source',
      filePath: 'E:/预算.xlsx',
      preview: {} as McpAppWorkspaceEntry['preview'],
      context: { isCurrent: () => true } as McpAppViewContext,
    }),
  );
  expect(result.current.tabs).toEqual([]);
  expect(result.current.focusFile('E:/预算.xlsx')).toBe(false);
});

test('a file App closed by its own UI is not focused as an existing editor', () => {
  const select = vi.fn();
  const entry = {
    id: 'file-view:session:budget',
    sessionId: 'session',
    filePath: 'E:/预算.xlsx',
    preview: { title: 'Univer', viewId: 'view' },
    context: { isCurrent: () => true } as McpAppViewContext,
  } as McpAppWorkspaceEntry;
  const { result } = renderHook(() => useMcpAppTabs('session', select, vi.fn()));
  act(() => openWorkspaceApp(entry));
  result.current.panels(entry.id)[0].props.register({
    context: entry.context,
    closed: true,
    error: '',
  });
  select.mockClear();

  expect(result.current.focusFile(entry.filePath!)).toBe(false);
  expect(select).not.toHaveBeenCalled();
});

function pendingFile() {
  let finish!: (value: Pick<McpAppWorkspaceEntry, 'preview' | 'context'>) => void;
  let fail!: (error: Error) => void;
  const load = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<Pick<McpAppWorkspaceEntry, 'preview' | 'context'>>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const entry: McpAppWorkspaceFileEntry = {
    id: 'file-view:session:budget',
    sessionId: 'session',
    filePath: 'E:/预算.xlsx',
    label: '预算.xlsx',
    load,
  };
  const ready = () => ({
    preview: { title: 'Univer', viewId: 'file-ready' } as McpAppWorkspaceEntry['preview'],
    context: { isCurrent: () => true } as McpAppViewContext,
  });
  return {
    entry,
    load,
    ready,
    finish: () => finish(ready()),
    fail: () => fail(new Error('Native launch failed')),
  };
}

test('reserves and focuses a file tab immediately, deduplicates clicks and never steals focus when ready', async () => {
  const select = vi.fn(),
    open = vi.fn();
  const file = pendingFile();
  const { result } = renderHook(() => useMcpAppTabs('session', select, open));
  act(() => openWorkspaceAppFile(file.entry));
  expect(result.current.tabs.map(tab => tab.label)).toEqual(['预算.xlsx']);
  expect(select).toHaveBeenCalledExactlyOnceWith(file.entry.id);
  act(() => expect(result.current.focusFile(file.entry.filePath)).toBe(true));
  expect(file.load).toHaveBeenCalledOnce();
  expect(result.current.tabs).toHaveLength(1);
  select.mockClear();
  open.mockClear();
  await act(async () => file.finish());
  expect(select).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(result.current.panels(file.entry.id)[0].props.entry.preview.viewId).toBe('file-ready');
});

test('closing a loading file tab aborts the local wait and never resurrects a late view', async () => {
  const file = pendingFile();
  const { result } = renderHook(() => useMcpAppTabs('session', vi.fn(), vi.fn()));
  act(() => openWorkspaceAppFile(file.entry));
  const signal = file.load.mock.calls[0][0];
  await act(async () => {
    await result.current.tabs[0].onClose?.();
  });
  expect(signal.aborted).toBe(true);
  await act(async () => file.finish());
  expect(result.current.tabs).toEqual([]);
});

test('a close captured during loading still closes that tab when its view has just become ready', async () => {
  const file = pendingFile();
  const { result } = renderHook(() => useMcpAppTabs('session', vi.fn(), vi.fn()));
  act(() => openWorkspaceAppFile(file.entry));
  const close = result.current.tabs[0].onClose;
  await act(async () => file.finish());
  await act(async () => {
    await close?.();
  });
  expect(result.current.tabs).toEqual([]);
});

test('switching away and back discards pending file results from the old session scope', async () => {
  const file = pendingFile();
  const { result, rerender } = renderHook(
    ({ session }) => useMcpAppTabs(session, vi.fn(), vi.fn()),
    { initialProps: { session: 'session' } },
  );
  act(() => openWorkspaceAppFile(file.entry));
  rerender({ session: 'other' });
  expect(file.load.mock.calls[0][0].aborted).toBe(true);
  rerender({ session: 'session' });
  await act(async () => file.finish());
  expect(result.current.tabs).toEqual([]);
});

test('file loading and failure stay in the preview panel, with only explicit retries', async () => {
  const file = pendingFile();
  function Fixture() {
    const tabs = useMcpAppTabs(
      'session',
      () => {},
      () => {},
    );
    return <div data-testid="file-panel">{tabs.panels(file.entry.id)}</div>;
  }
  render(<Fixture />);
  act(() => openWorkspaceAppFile(file.entry));
  const panel = screen.getByTestId('file-panel');
  expect(panel.contains(screen.getByRole('status'))).toBe(true);
  await act(async () => file.fail());
  expect(panel.contains(screen.getByRole('alert'))).toBe(true);
  expect(screen.queryByRole('status')).toBeNull();
  expect(file.load).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button'));
  expect(file.load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(panel.contains(screen.getByRole('status'))).toBe(true);
});

test('unmounting cancels pending file waits', async () => {
  const file = pendingFile();
  const { unmount } = renderHook(() => useMcpAppTabs('session', vi.fn(), vi.fn()));
  act(() => openWorkspaceAppFile(file.entry));
  unmount();
  expect(file.load.mock.calls[0][0].aborted).toBe(true);
  await act(async () => file.finish());
});

test('manual App tabs reserve the sidebar immediately and deduplicate pending launches', async () => {
  const pending = pendingFile();
  const entry = { ...pending.entry, filePath: undefined, label: 'Future app', retryable: false };
  const select = vi.fn();
  const { result } = renderHook(() => useMcpAppTabs('session', select, vi.fn()));
  act(() => openWorkspaceAppLaunch(entry));
  act(() => openWorkspaceAppLaunch(entry));
  expect(result.current.tabs.map(tab => tab.label)).toEqual(['Future app']);
  expect(pending.load).toHaveBeenCalledOnce();
  const close = result.current.tabs[0].onClose;
  await act(async () => {
    await close?.();
  });
  expect(pending.load.mock.calls[0][0].aborted).toBe(true);
  await act(async () => pending.finish());
  expect(result.current.tabs).toEqual([]);
});

test('failed manual operations stay in their sidebar tab and never offer a blind retry', async () => {
  const pending = pendingFile();
  const entry = { ...pending.entry, filePath: undefined, label: 'Future app', retryable: false };
  function Fixture() {
    const tabs = useMcpAppTabs('session', vi.fn(), vi.fn());
    return <aside data-testid="sidebar">{tabs.panels(entry.id)}</aside>;
  }
  render(<Fixture />);
  act(() => openWorkspaceAppLaunch(entry));
  await act(async () => pending.fail());
  expect(screen.getByTestId('sidebar').contains(screen.getByRole('alert'))).toBe(true);
  expect(screen.queryByRole('button')).toBeNull();
  expect(pending.load).toHaveBeenCalledOnce();
});

test('selecting a failed manual entry focuses its unknown result without dispatching again', async () => {
  const pending = pendingFile();
  const entry = { ...pending.entry, filePath: undefined, label: 'Manual app', retryable: false };
  const select = vi.fn();
  renderHook(() => useMcpAppTabs('session', select, vi.fn()));
  act(() => openWorkspaceAppLaunch(entry));
  await act(async () => pending.fail());
  select.mockClear();

  act(() => openWorkspaceAppLaunch({ ...entry }));

  expect(select).toHaveBeenCalledExactlyOnceWith(entry.id);
  expect(pending.load).toHaveBeenCalledOnce();
});

test('an existing manual App with a failed interface is focused without relaunching its tool', async () => {
  const pending = pendingFile();
  const entry = { ...pending.entry, filePath: undefined, label: 'Manual app', retryable: false };
  const select = vi.fn();
  const { result } = renderHook(() => useMcpAppTabs('session', select, vi.fn()));
  act(() => openWorkspaceAppLaunch(entry));
  await act(async () => pending.finish());
  result.current.panels(entry.id)[0].props.register({
    context: pending.ready().context,
    error: 'Interface unavailable',
    closed: false,
  });
  select.mockClear();

  act(() => openWorkspaceAppLaunch({ ...entry }));

  expect(select).toHaveBeenCalledExactlyOnceWith(entry.id);
  expect(pending.load).toHaveBeenCalledOnce();
});

test('advanced controls attach only to the workspace and close by exact owner', () => {
  const attach = vi.fn(),
    onClose = vi.fn();
  const entry = {
    id: 'controls:session',
    sessionId: 'session',
    label: 'Tools',
    isCurrent: () => true,
    attach,
    onClose,
  };
  function Fixture() {
    const tabs = useMcpAppTabs('session', vi.fn(), vi.fn());
    return <aside data-testid="sidebar">{tabs.panels(entry.id)}</aside>;
  }
  const view = render(<Fixture />);
  act(() => openWorkspaceAppControls(entry));
  const target = attach.mock.calls[0][0];
  expect(screen.getByTestId('sidebar').contains(target)).toBe(true);
  const replacement = { ...entry, onClose: vi.fn() };
  act(() => openWorkspaceAppControls(replacement));
  expect(onClose).toHaveBeenCalledOnce();
  act(() => closeWorkspaceAppControls(entry));
  expect(replacement.onClose).not.toHaveBeenCalled();
  act(() => closeWorkspaceAppControls(replacement));
  expect(replacement.onClose).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenLastCalledWith(null);
  view.unmount();
});
