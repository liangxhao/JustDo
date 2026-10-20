// @vitest-environment jsdom
import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import type { GatewayClient } from '@/libs/openclaw-chat/gateway/client';
import { McpAppSession } from '@/libs/openclaw-chat/gateway/mcp-app-session';
import { i18nService } from '@/services/i18n';

import DisplayPanelLauncher from '../display/DisplayPanelLauncher';
import { type McpAppComposerMenu, McpAppsControls } from './McpAppsControls';
import {
  openWorkspaceApp,
  openWorkspaceAppControls,
  openWorkspaceAppFile,
  openWorkspaceAppLaunch,
} from './workspaceApps';

vi.mock('./NativeAppQuestions', () => ({ NativeAppQuestions: () => null }));
vi.mock('@/libs/openclaw-chat/pipeline/native-mcp-app', () => ({
  decodeMcpAppLaunch: (value: unknown) => (value === 'launched' ? { viewId: 'view' } : undefined),
}));
vi.mock('./workspaceApps', () => ({
  openWorkspaceApp: vi.fn(),
  openWorkspaceAppFile: vi.fn(),
  openWorkspaceAppLaunch: vi.fn(),
  openWorkspaceAppControls: vi.fn(entry =>
    entry.attach(document.querySelector('[data-testid="workspace-controls"]')),
  ),
  closeWorkspaceAppControls: vi.fn(entry => {
    entry.attach(null);
    entry.onClose();
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('electron', {
    browser: { listHistory: vi.fn().mockResolvedValue({ success: true, entries: [] }) },
  });
});

function LauncherFixture(props: ComponentProps<typeof McpAppsControls>) {
  const [menu, setMenu] = useState<McpAppComposerMenu | null>(null);
  return (
    <>
      <section data-testid="conversation">
        <McpAppsControls {...props} onMenuChange={setMenu} />
      </section>
      <aside id="cowork-display-panel">
        <DisplayPanelLauncher
          appItems={menu?.sessionId === props.sessionId ? menu.items : []}
          onCreateBrowser={vi.fn()}
          onCreateTerminal={vi.fn()}
        />
        <div data-testid="workspace-controls" />
      </aside>
    </>
  );
}

async function openApps() {
  await screen.findByRole('region', { name: 'Apps' });
}

test('discovers once authenticated history becomes ready without preparing a session', async () => {
  let ready = false;
  const request = vi.fn().mockResolvedValue({
    servers: [{ serverName: 'reports', label: 'Reports', entrypoints: [], mentionTool: 'search' }],
  });
  const client = { generation: 1, request } as unknown as GatewayClient;
  const apps = new McpAppSession(() =>
    ready
      ? {
          client,
          generation: 1,
          sessionId: 'native',
          sessionKey: 'agent:a:conversation',
          isCurrent: () => ready,
        }
      : undefined,
  );
  const prepare = vi.fn();
  i18nService.setLanguage('en', { persist: false });
  render(
    <LauncherFixture
      apps={apps}
      prepare={prepare}
      sessionId="session"
      canDraft={() => true}
      addDraft={vi.fn()}
      onOnboard={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Apps' })).toBeNull();
  act(() => {
    ready = true;
    apps.refreshBinding();
  });
  await openApps();
  await screen.findByRole('button', { name: 'Reports' });
  expect(screen.queryByRole('button', { name: 'Apps' })).toBeNull();
  expect(prepare).not.toHaveBeenCalled();
  act(() => apps.reportContext('view', 'Selected', { updateId: 'selection' }));
  expect(apps.getContexts()).toEqual([
    { viewId: 'view', title: 'Selected', updateId: 'selection' },
  ]);
  expect(screen.queryByText('Selected')).toBeNull();
  expect(within(screen.getByTestId('conversation')).queryByRole('status')).toBeNull();
  act(() => apps.reportContext('view', 'Univer', { updateId: 'next-selection' }));
  expect(screen.queryByText('Univer')).toBeNull();
  expect(apps.getContexts()[0].updateId).toBe('next-selection');
  expect(request).toHaveBeenCalledOnce();
});

function setup(
  discover: () => Promise<McpAppDiscovery>,
  request = vi.fn(),
  addDraft = vi.fn().mockResolvedValue(true),
) {
  i18nService.setLanguage('en', { persist: false });
  const apps = {
    getContexts: () => [],
    subscribe: () => () => {},
    discover,
    bind: () => ({ request }),
  } as unknown as McpAppSession;
  const context = { apps, isCurrent: () => true } as McpAppViewContext;
  render(
    <LauncherFixture
      apps={apps}
      prepare={async () => context}
      sessionId="session"
      canDraft={() => true}
      addDraft={addDraft}
      onOnboard={vi.fn()}
    />,
  );
  return { addDraft };
}

test('does not expose an empty or still unknown catalog', async () => {
  let complete!: (catalog: McpAppDiscovery) => void;
  const discover = vi.fn(
    () =>
      new Promise<McpAppDiscovery>(resolve => {
        complete = resolve;
      }),
  );
  setup(discover);
  await waitFor(() => expect(discover).toHaveBeenCalledOnce());
  expect(screen.queryByRole('region', { name: 'Apps' })).toBeNull();
  complete({ servers: [] });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Apps' })).toBeNull());
});

test('opens advanced app controls only in the workspace and restores focus on Escape', async () => {
  setup(async () => ({
    servers: [{ serverName: 'reports', label: 'Reports', entrypoints: [], mentionTool: 'search' }],
  }));
  await openApps();
  const trigger = screen.getByRole('button', { name: 'Reports' });
  trigger.focus();
  fireEvent.click(trigger);
  const search = screen.getByRole('button', { name: 'Search resources: Reports' });
  expect(openWorkspaceAppControls).toHaveBeenCalledOnce();
  expect(screen.getByTestId('workspace-controls').contains(search)).toBe(true);
  expect(screen.getByTestId('conversation').contains(search)).toBe(false);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(screen.queryByRole('button', { name: 'Search resources: Reports' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test('Escape restores the selected tab in the detached document after the launcher unmounts', async () => {
  i18nService.setLanguage('en', { persist: false });
  const frame = document.createElement('iframe');
  const unrelatedInput = document.createElement('input');
  document.body.append(unrelatedInput, frame);
  const workspaceDocument = frame.contentDocument!;
  const workspaceWindow = frame.contentWindow!;
  Object.defineProperty(workspaceWindow, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
  });
  workspaceDocument.body.innerHTML =
    '<aside id="cowork-display-panel"><button role="tab" aria-selected="true">Start page</button><div id="launcher"></div><div id="controls"></div></aside>';
  const tabs = within(workspaceDocument.body);
  const selectedTab = tabs.getByRole('tab', { name: 'Start page' });
  const apps = {
    subscribe: () => () => {},
    discover: async () => ({
      servers: [
        { serverName: 'reports', label: 'Reports', entrypoints: [], mentionTool: 'search' },
      ],
    }),
  } as unknown as McpAppSession;
  const onMenuChange = vi.fn();
  const context = { apps, isCurrent: () => true } as McpAppViewContext;
  try {
    render(
      <McpAppsControls
        apps={apps}
        prepare={async () => context}
        sessionId="session"
        canDraft={() => true}
        addDraft={vi.fn()}
        onOnboard={vi.fn()}
        onMenuChange={onMenuChange}
      />,
    );
    await waitFor(() => expect(onMenuChange.mock.lastCall?.[0].items).toHaveLength(1));
    const launcher = render(
      <DisplayPanelLauncher
        appItems={onMenuChange.mock.lastCall![0].items}
        onCreateBrowser={vi.fn()}
        onCreateTerminal={vi.fn()}
      />,
      { container: workspaceDocument.getElementById('launcher')! },
    );
    vi.mocked(openWorkspaceAppControls).mockImplementationOnce(entry => {
      launcher.unmount();
      entry.attach(workspaceDocument.getElementById('controls'));
    });
    unrelatedInput.focus();
    const mainFocus = vi.spyOn(unrelatedInput, 'focus');
    const trigger = tabs.getByRole('button', { name: 'Reports' });
    trigger.focus();
    fireEvent.click(trigger);
    const search = await tabs.findByRole('button', { name: 'Search resources: Reports' });
    expect(trigger.isConnected).toBe(false);
    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    await waitFor(() => expect(workspaceDocument.activeElement).toBe(selectedTab));
    expect(mainFocus).not.toHaveBeenCalled();
    expect(tabs.queryByRole('button', { name: 'Search resources: Reports' })).toBeNull();
  } finally {
    cleanup();
    frame.remove();
    unrelatedInput.remove();
  }
});

test('resource selection preserves its descriptor and reports a rejected draft', async () => {
  const resource = { type: 'resource_link', uri: 'file:///report.txt', name: 'Report' };
  const request = vi.fn().mockResolvedValue({ resources: [resource] });
  const addDraft = vi.fn().mockResolvedValue(false);
  setup(
    async () => ({
      servers: [
        { serverName: 'reports', label: 'Reports', entrypoints: [], mentionTool: 'search' },
      ],
    }),
    request,
    addDraft,
  );
  await openApps();
  fireEvent.click(screen.getByRole('button', { name: 'Reports' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Search resources: Reports' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'report' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search resources' }));
  fireEvent.click(
    await within(screen.getByTestId('workspace-controls')).findByRole('button', {
      name: /^Report/,
    }),
  );
  await waitFor(() => expect(addDraft).toHaveBeenCalledOnce());
  expect(JSON.parse(addDraft.mock.calls[0][0])).toEqual({ serverName: 'reports', resource });
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Added to draft')).toBeNull();
});

const manualCatalog: McpAppDiscovery = {
  servers: ['drawio', 'planner'].map(serverName => ({
    serverName,
    label: serverName,
    entrypoints: [
      {
        toolName: 'open_editor',
        title: serverName,
        resourceUri: `ui://${serverName}/editor`,
        entrypoint: { type: 'global' },
      },
    ],
  })),
};

test('lists apps on the sidebar homepage and launches the chosen editor once', async () => {
  const launch = vi.fn().mockResolvedValue('launched');
  const apps = {
    getContexts: () => [],
    subscribe: () => () => {},
    discover: async () => manualCatalog,
    launch,
  } as unknown as McpAppSession;
  const context = { apps, isCurrent: () => true } as McpAppViewContext;
  const prepare = vi.fn().mockResolvedValue(context);
  render(
    <LauncherFixture
      apps={apps}
      prepare={prepare}
      sessionId="session"
      canDraft={() => true}
      addDraft={vi.fn()}
      onOnboard={vi.fn()}
    />,
  );
  await openApps();
  const launcher = within(screen.getByRole('region', { name: 'Apps' }));
  expect(launcher.getAllByRole('button').map(item => item.getAttribute('aria-label'))).toEqual([
    'drawio',
    'planner',
  ]);
  expect(prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'drawio' }));
  await waitFor(() => expect(openWorkspaceAppLaunch).toHaveBeenCalledOnce());
  expect(prepare).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  await act(async () => {
    await vi.mocked(openWorkspaceAppLaunch).mock.lastCall![0].load(new AbortController().signal);
  });
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    {
      serverName: 'drawio',
      toolName: 'open_editor',
      entrypointType: 'global',
    },
    expect.any(AbortSignal),
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apps' })).toBeNull();
});

test.each(['univer', 'future-editor'])(
  'file handlers never turn %s manual opening into an inline picker',
  async serverName => {
    const launch = vi.fn().mockResolvedValue('launched');
    const apps = {
      discoveryRevision: 1,
      subscribe: () => () => {},
      discover: async () => ({
        servers: [
          {
            serverName,
            label: 'Editor',
            entrypoints: [
              {
                toolName: 'preview_file',
                title: 'Preview file',
                resourceUri: 'ui://editor',
                entrypoint: { type: 'file', extensions: ['.abc'] },
              },
              {
                toolName: 'open_editor',
                title: 'Open editor',
                resourceUri: 'ui://editor',
                entrypoint: { type: 'global' },
              },
            ],
          },
        ],
      }),
      launch,
    } as unknown as McpAppSession;
    const context = { apps, isCurrent: () => true } as McpAppViewContext;
    render(
      <LauncherFixture
        apps={apps}
        prepare={async () => context}
        sessionId="session"
        canDraft={() => true}
        addDraft={vi.fn()}
        onOnboard={vi.fn()}
      />,
    );
    await openApps();
    fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    expect(openWorkspaceAppControls).not.toHaveBeenCalled();
    expect(screen.queryByText('Preview file')).toBeNull();
    const entry = vi.mocked(openWorkspaceAppLaunch).mock.lastCall![0];
    expect(entry).toMatchObject({ label: 'Editor', sessionId: 'session', retryable: false });
    await act(async () => {
      await entry.load(new AbortController().signal);
    });
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      { serverName, toolName: 'open_editor', entrypointType: 'global' },
      expect.any(AbortSignal),
    );
  },
);

test('withdraws menu actions after native binding changes or controls unmount', async () => {
  const launch = vi.fn();
  const onMenuChange = vi.fn();
  const apps = {
    discoveryRevision: 1,
    getContexts: () => [],
    subscribe: () => () => {},
    discover: async () => manualCatalog,
    launch,
  };
  const prepare = vi.fn();
  const view = render(
    <McpAppsControls
      apps={apps as unknown as McpAppSession}
      prepare={prepare}
      sessionId="session"
      canDraft={() => true}
      addDraft={vi.fn()}
      onOnboard={vi.fn()}
      onMenuChange={onMenuChange}
    />,
  );
  await waitFor(() => expect(onMenuChange.mock.lastCall?.[0].items).toHaveLength(2));
  const select = onMenuChange.mock.lastCall![0].items[0].onSelect;
  apps.discoveryRevision++;
  select();
  expect(prepare).not.toHaveBeenCalled();
  view.unmount();
  expect(onMenuChange).toHaveBeenLastCalledWith({ sessionId: 'session', items: [] });
  select();
  expect(launch).not.toHaveBeenCalled();
});

test.each([false, true])(
  'reserves a file tab only in the current navigation scope without composer loading (stale=%s)',
  async stale => {
    let navigationCurrent = !stale;
    let canInteract = true;
    const onMenuChange = vi.fn();
    const launch = vi.fn().mockResolvedValue('launched');
    const apps = {
      discoveryRevision: 1,
      getContexts: () => [],
      subscribe: () => () => {},
      launch,
      discover: async () => ({
        servers: [
          {
            serverName: 'sheets',
            label: 'Sheets',
            entrypoints: [
              { toolName: 'preview_file', entrypoint: { type: 'file', extensions: ['.xlsx'] } },
            ],
          },
        ],
      }),
    };
    const context = { apps, isCurrent: () => true } as unknown as McpAppViewContext;
    context.resume = vi.fn(() => ({ ...context }));
    const prepare = vi.fn().mockResolvedValue(context);
    render(
      <McpAppsControls
        apps={apps as unknown as McpAppSession}
        prepare={prepare}
        sessionId="session"
        canDraft={() => canInteract}
        addDraft={vi.fn()}
        onOnboard={vi.fn()}
        onMenuChange={onMenuChange}
      />,
    );
    await waitFor(() => expect(onMenuChange.mock.lastCall?.[0].openFile).toBeTypeOf('function'));
    expect(onMenuChange.mock.lastCall![0].items).toHaveLength(0);
    const filePath = 'E:/项目/预算.xlsx';
    let opened: boolean | undefined;
    await act(async () => {
      opened = await onMenuChange.mock.lastCall![0].openFile({
        filePath,
        isCurrent: () => navigationCurrent,
      });
    });
    expect(opened).toBe(!stale);
    expect(prepare).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(openWorkspaceApp).not.toHaveBeenCalled();
    if (stale) expect(openWorkspaceAppFile).not.toHaveBeenCalled();
    else {
      expect(openWorkspaceAppFile).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session',
          filePath,
          label: '预算.xlsx',
          load: expect.any(Function),
        }),
      );
      // Once reserved, another file selection must not prevent this tab from
      // completing in the background, or move its result into another tab.
      navigationCurrent = false;
      const file = vi.mocked(openWorkspaceAppFile).mock.lastCall![0];
      const abort = new AbortController();
      const { context: fileContext } = await file.load(abort.signal);
      expect(launch).toHaveBeenCalledWith(
        { serverName: 'sheets', toolName: 'preview_file', entrypointType: 'file', filePath },
        abort.signal,
      );
      expect(screen.queryByRole('status')).toBeNull();
      const calls = launch.mock.calls.length;
      abort.abort();
      await expect(file.load(abort.signal)).rejects.toThrow();
      expect(launch).toHaveBeenCalledTimes(calls);
      apps.discoveryRevision++;
      await file.load(new AbortController().signal);
      expect(launch).toHaveBeenCalledTimes(2);
      const reopened = await fileContext.reopen!();
      expect(reopened.preview.viewId).toBe('view');
      expect(launch).toHaveBeenCalledTimes(3);
      const resumed = fileContext.resume!();
      expect(context.resume).toHaveBeenCalledOnce();
      expect(resumed?.reopen).toBeTypeOf('function');
      expect(launch).toHaveBeenCalledTimes(3);
      expect((await resumed!.reopen!()).preview.viewId).toBe('view');
      expect(launch).toHaveBeenCalledTimes(4);
      canInteract = false;
      await expect(resumed!.reopen!()).rejects.toThrow('no longer available');
      expect(launch).toHaveBeenCalledTimes(4);
    }
  },
);
