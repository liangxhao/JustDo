/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';

import { renderCoworkHomeWorkspace } from '../chat/CoworkHomeWorkspace';
import {
  closeWorkspaceAppControls,
  type McpAppWorkspaceEntry,
  type McpAppWorkspaceFileEntry,
  openWorkspaceApp,
  openWorkspaceAppControls,
  openWorkspaceAppFile,
  openWorkspaceAppLaunch,
} from '../mcpApps/workspaceApps';
import CoworkDisplayPanel from './CoworkDisplayPanel';
import { useMcpAppTabs } from './useMcpAppTabs';

vi.mock('@/libs/openclaw-chat/components/mcp-app/view', () => {
  class TestAppView extends HTMLElement {
    resume = vi.fn();
    prepareContext = vi.fn().mockResolvedValue(undefined);
  }
  customElements.define('test-mcp-app-view', TestAppView);
  return { McpAppView: TestAppView };
});
vi.mock('@/libs/openclaw-chat/pipeline/native-mcp-app', () => ({
  isNativeMcpAppPreview: () => true,
}));
vi.mock('./CoworkDisplayPanel', () => ({
  default: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
}));
vi.mock('../composer/CoworkPromptInput', () => ({ default: () => <div /> }));
vi.mock('../status/CoworkPet', () => ({ CoworkPet: () => null }));
afterEach(cleanup);

test('home and conversation layouts retain the same App DOM even when the next scope has no tabs', async () => {
  const entry = {
    id: 'home-editor',
    sessionId: '__home__',
    preview: { title: 'draw.io', viewId: 'home-view' },
    context: { isCurrent: () => true, apps: { subscribe: () => () => {} } },
  } as unknown as McpAppWorkspaceEntry;
  function Fixture({ home }: { home: boolean }) {
    const tabs = useMcpAppTabs(home ? '__home__' : 'other', vi.fn(), vi.fn());
    if (home)
      return renderCoworkHomeWorkspace({
        config: { workingDirectory: 'E:/workspace' },
        homeConversationHeader: <header />,
        maximumBrowserTabs: 20,
        promptInputRef: { current: null },
        terminalTabs: [],
        filePreviews: [],
        unsupportedFilePreviews: [],
        browserTabs: [],
        homeDisplayTabs: tabs.tabs,
        recordingReviewTabs: { tabs: [], panels: () => [] },
        mcpAppTabs: tabs,
        activeDisplayTabId: entry.id,
        hasRetainedRuntimePanels: tabs.hasRetainedPanels,
        retainedRuntimePanels: [],
      } as unknown as Parameters<typeof renderCoworkHomeWorkspace>[0]);
    return (
      <div>
        <div>
          <main />
          {tabs.hasRetainedPanels && (
            <CoworkDisplayPanel
              key="cowork-display-panel"
              {...({} as React.ComponentProps<typeof CoworkDisplayPanel>)}
            >
              <div key="mcp-app-panels" className="contents">
                {tabs.panels(null)}
              </div>
            </CoworkDisplayPanel>
          )}
        </div>
      </div>
    );
  }
  const fixture = render(<Fixture home />);
  await act(async () => openWorkspaceApp(entry));
  const view = document.querySelector('test-mcp-app-view');
  expect(view).not.toBeNull();
  fixture.rerender(<Fixture home={false} />);
  expect(document.querySelector('test-mcp-app-view')).toBe(view);
  expect(view?.isConnected).toBe(true);
  fixture.rerender(<Fixture home />);
  await act(async () => {});
  expect(document.querySelector('test-mcp-app-view')).toBe(view);
});

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

test('a new homepage source for the same file preserves the adopted editor and its local edits', async () => {
  let tabs!: ReturnType<typeof useMcpAppTabs>;
  function Fixture({ sessionId }: { sessionId: string }) {
    tabs = useMcpAppTabs(sessionId, vi.fn(), vi.fn());
    return <div>{tabs.panels(null)}</div>;
  }
  const context = {
    isCurrent: () => true,
    apps: { subscribe: () => () => {} },
  } as unknown as McpAppViewContext;
  const file = (source: string): McpAppWorkspaceFileEntry => ({
    id: `mcp-app-file:__home__:${source}:E:/diagram.drawio`,
    sessionId: '__home__',
    filePath: 'E:/diagram.drawio',
    label: 'diagram.drawio',
    load: async () => ({
      preview: { title: 'draw.io', viewId: source } as McpAppWorkspaceEntry['preview'],
      context,
    }),
  });
  const fixture = render(<Fixture sessionId="__home__" />);
  await act(async () => openWorkspaceAppFile(file('first-source')));
  const original = document.querySelector('test-mcp-app-view')!;
  const edit = document.createElement('input');
  edit.value = 'unsaved diagram text';
  original.append(edit);
  act(() => tabs.promote('__home__', 'canonical-chat'));
  fixture.rerender(<Fixture sessionId="canonical-chat" />);
  fixture.rerender(<Fixture sessionId="__home__" />);

  await act(async () => openWorkspaceAppFile(file('next-source')));

  expect(document.querySelectorAll('test-mcp-app-view')).toHaveLength(2);
  expect(original.isConnected).toBe(true);
  expect(edit.value).toBe('unsaved diagram text');
  fixture.rerender(<Fixture sessionId="canonical-chat" />);
  expect(tabs.tabs[0].id).toBe(file('first-source').id);
  expect(original.querySelector('input')).toBe(edit);
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

test('repeated file opening keeps the live resumed view instead of relaunching its tool', async () => {
  const file = pendingFile();
  const { result } = renderHook(() => useMcpAppTabs('session', vi.fn(), vi.fn()));
  act(() => openWorkspaceAppFile(file.entry));
  await act(async () => file.finish());
  const panel = result.current.panels(file.entry.id)[0];
  panel.props.entry.context.isCurrent = () => false;
  panel.props.register({
    context: { isCurrent: () => true },
    error: '',
    closed: false,
  });
  const reload = vi.fn();

  act(() => openWorkspaceAppFile({ ...file.entry, load: reload }));

  expect(reload).not.toHaveBeenCalled();
  expect(result.current.panels(file.entry.id)[0].props.entry).toBe(panel.props.entry);
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

test('returning to an App tab resumes its view after binding notifications, only while active', async () => {
  const listeners = new Set<() => void>();
  const stop = vi.fn();
  const entry = {
    id: 'manual:session:drawio',
    sessionId: 'session',
    preview: { title: 'draw.io', viewId: 'original' },
    context: {
      isCurrent: () => true,
      apps: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            stop();
          };
        },
      },
    } as unknown as McpAppViewContext,
  } as McpAppWorkspaceEntry;
  function Fixture({ session, activeId }: { session: string; activeId: string | null }) {
    const tabs = useMcpAppTabs(session, vi.fn(), vi.fn());
    return <aside>{tabs.panels(activeId)}</aside>;
  }
  const fixture = render(<Fixture session="session" activeId={entry.id} />);
  await act(async () => openWorkspaceApp(entry));
  const view = document.querySelector('test-mcp-app-view') as HTMLElement & {
    resume: ReturnType<typeof vi.fn>;
  };
  expect(view.resume).toHaveBeenCalledOnce();
  fixture.rerender(<Fixture session="other" activeId={null} />);
  expect(listeners.size).toBe(0);
  fixture.rerender(<Fixture session="session" activeId={entry.id} />);
  await act(async () => {});
  expect(document.querySelector('test-mcp-app-view')).toBe(view);
  expect(view.resume).toHaveBeenCalledTimes(2);
  await act(async () => listeners.forEach(listener => listener()));
  expect(view.resume).toHaveBeenCalledTimes(3);
  act(() => {
    listeners.forEach(listener => listener());
    fixture.rerender(<Fixture session="other" activeId={null} />);
  });
  await act(async () => {});
  expect(view.resume).toHaveBeenCalledTimes(3);
  expect(stop).toHaveBeenCalledTimes(2);
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

test('promotes the App panel to the new conversation without replacing its element or local input', async () => {
  const entry = {
    id: 'home-drawing',
    sessionId: '__home__',
    preview: { title: 'draw.io', viewId: 'drawing' },
    context: { isCurrent: () => true, apps: { subscribe: () => () => {} } },
  } as unknown as McpAppWorkspaceEntry;
  let controller!: ReturnType<typeof useMcpAppTabs>;
  function Fixture({ sessionId }: { sessionId: string }) {
    controller = useMcpAppTabs(sessionId, vi.fn(), vi.fn());
    return <div>{controller.panels(entry.id)}</div>;
  }
  const rendered = render(<Fixture sessionId="__home__" />);
  await act(async () => openWorkspaceApp(entry));
  const element = document.querySelector('test-mcp-app-view')!;
  element.append(document.createTextNode('unsaved node text'));
  await act(async () => expect(await controller.prepareContext()).toBe(true));
  act(() => controller.promote('__home__', 'conversation'));
  rendered.rerender(<Fixture sessionId="conversation" />);
  expect(document.querySelector('test-mcp-app-view')).toBe(element);
  expect(element.textContent).toBe('unsaved node text');
  expect(controller.tabs.map(tab => tab.id)).toEqual([entry.id]);
});
