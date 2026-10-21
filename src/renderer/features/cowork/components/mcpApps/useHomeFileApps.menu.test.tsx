// @vitest-environment jsdom
import { EnginePhase } from '@shared/openclaw/engineStatus';
import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import CoworkPromptInput from '../composer/CoworkPromptInput';
import DisplayPanelLauncher from '../display/DisplayPanelLauncher';
import WorkspaceFileIcon from '../shared/WorkspaceFileIcon';
import { WorkspaceFileIconContext } from '../shared/WorkspaceFileIconContext';
import { useHomeFileApps } from './useHomeFileApps';

interface TestHost {
  isCurrent: () => boolean;
}
interface TestContext {
  isCurrent: () => boolean;
}

const f = vi.hoisted(() => ({
  connected: true,
  prepare: vi.fn<(host: TestHost) => Promise<TestContext>>(),
  discover: vi.fn<() => Promise<McpAppDiscovery>>(),
  launch: vi.fn(),
  invalidate: vi.fn(),
  dispose: vi.fn(),
  stopConnection: vi.fn(),
  stopEngine: vi.fn(),
  onProgress: vi.fn(),
  onConfigSyncDone: vi.fn(),
  onExtensionsChanged: vi.fn(),
  hosts: [] as TestHost[],
  connectionListeners: new Set<() => void>(),
}));

vi.mock('@/libs/openclaw-chat/gateway/mcp-app/mcp-workspace-session', () => ({
  McpWorkspaceSession: class {
    constructor(
      _scope: unknown,
      private readonly host: TestHost,
    ) {
      f.hosts.push(host);
    }

    get connected() {
      return f.connected;
    }

    apps = { discover: f.discover, launch: f.launch, invalidate: f.invalidate };
    prepare = () => f.prepare(this.host);
    discover = async (signal?: AbortSignal) => {
      const binding = await f.prepare(this.host);
      signal?.throwIfAborted();
      const value = await f.discover();
      signal?.throwIfAborted();
      return { value, isCurrent: binding.isCurrent };
    };
    dispose = f.dispose;
    subscribeConnection = (listener: () => void) => {
      f.connectionListeners.add(listener);
      return () => {
        f.connectionListeners.delete(listener);
        f.stopConnection();
      };
    };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const catalog: McpAppDiscovery = {
  servers: [
    {
      serverName: 'drawio',
      label: 'draw.io',
      entrypoints: [
        {
          toolName: 'open_editor',
          title: 'Editor',
          resourceUri: 'ui://drawio/editor',
          entrypoint: { type: 'global' },
        },
        {
          toolName: 'open_file',
          title: 'Editor',
          resourceUri: 'ui://drawio/editor',
          icons: [{ src: 'data:image/png;base64,aWNvbg==' }],
          entrypoint: { type: 'file', extensions: ['.drawio'] },
        },
      ],
    },
  ],
};

function Fixture({ home = true }: { home?: boolean }) {
  const apps = useHomeFileApps({
    enabled: home,
    cwd: 'E:/workspace',
    agentId: 'main',
    permissionMode: 'auto',
    addDraft: async () => false,
  });
  return (
    <Provider store={store}>
      {home ? (
        <>
          <CoworkPromptInput size="large" onSubmit={vi.fn()} />
          <DisplayPanelLauncher
            appItems={apps.menu.items}
            onCreateBrowser={vi.fn()}
            onCreateTerminal={vi.fn()}
          />
          <WorkspaceFileIconContext.Provider value={apps.menu.fileCatalog}>
            <WorkspaceFileIcon fileName="flow.drawio" />
          </WorkspaceFileIconContext.Provider>
        </>
      ) : (
        <p>Ordinary conversation</p>
      )}
    </Provider>
  );
}

beforeEach(() => {
  f.connected = true;
  f.prepare.mockImplementation(async host => ({ isCurrent: host.isCurrent }));
  f.discover.mockResolvedValue(catalog);
  f.onProgress.mockReturnValue(f.stopEngine);
  f.onConfigSyncDone.mockReturnValue(() => {});
  f.onExtensionsChanged.mockReturnValue(() => {});
  vi.stubGlobal('electron', {
    openclaw: {
      engine: {
        getStatus: vi.fn().mockResolvedValue({
          success: true,
          status: { phase: EnginePhase.Running },
        }),
        onProgress: f.onProgress,
      },
    },
    extensions: {
      list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
      onChanged: f.onExtensionsChanged,
    },
    mcp: { onConfigSyncDone: f.onConfigSyncDone },
    browser: { listHistory: vi.fn().mockResolvedValue({ success: true, entries: [] }) },
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
    localSpeechModels: { onChanged: () => () => {} },
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  f.hosts.length = 0;
  f.connectionListeners.clear();
});

test('prefetches Apps and inserts delayed entries directly into the sidebar homepage', async () => {
  const preparation = deferred<TestContext>();
  const discovery = deferred<McpAppDiscovery>();
  f.prepare.mockReturnValueOnce(preparation.promise);
  f.discover.mockReturnValueOnce(discovery.promise);
  const fixture = render(<Fixture />);
  await waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  expect(f.onProgress).toHaveBeenCalledOnce();
  expect(f.connectionListeners.size).toBe(1);
  expect(f.discover).not.toHaveBeenCalled();

  const loading = screen.getByRole('button', { name: i18nService.t('mcpAppsDiscovering') });
  expect((loading as HTMLButtonElement).disabled).toBe(true);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.discover).not.toHaveBeenCalled();
  await act(async () => preparation.resolve({ isCurrent: f.hosts[0].isCurrent }));
  expect(f.discover).toHaveBeenCalledOnce();
  fixture.rerender(<Fixture />);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.discover).toHaveBeenCalledOnce();

  await act(async () => discovery.resolve(catalog));

  expect(screen.getByRole('button', { name: 'draw.io' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: i18nService.t('mcpAppsDiscovering') })).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
  fixture.unmount();
  expect(f.stopEngine).toHaveBeenCalledOnce();
  expect(f.stopConnection).toHaveBeenCalledOnce();
  expect(f.connectionListeners.size).toBe(0);
});

test('warms the home catalog while an existing conversation is open and shows it immediately on the first home visit', async () => {
  const fixture = render(<Fixture home={false} />);
  await waitFor(() => expect(f.discover).toHaveBeenCalledOnce());
  expect(screen.getByText('Ordinary conversation')).toBeTruthy();
  expect(f.launch).not.toHaveBeenCalled();

  fixture.rerender(<Fixture />);

  expect(screen.getByRole('button', { name: 'draw.io' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: i18nService.t('mcpAppsDiscovering') })).toBeNull();
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.discover).toHaveBeenCalledOnce();
  expect(f.launch).not.toHaveBeenCalled();
});

test('a first home visit joins the background read instead of starting another native preparation', async () => {
  const discovery = deferred<McpAppDiscovery>();
  f.discover.mockReturnValueOnce(discovery.promise);
  const fixture = render(<Fixture home={false} />);
  await waitFor(() => expect(f.discover).toHaveBeenCalledOnce());

  fixture.rerender(<Fixture />);

  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.discover).toHaveBeenCalledOnce();
  await act(async () => discovery.resolve(catalog));
  expect(screen.getByRole('button', { name: 'draw.io' })).toBeTruthy();
  expect(f.launch).not.toHaveBeenCalled();
});

test('configuration completion invalidates a background cache before displaying it again', async () => {
  const fixture = render(<Fixture home={false} />);
  await waitFor(() => expect(f.discover).toHaveBeenCalledOnce());
  const changed = { servers: [{ ...catalog.servers[0], label: 'Updated editor' }] };
  f.discover.mockResolvedValueOnce(changed);

  await act(async () => f.onConfigSyncDone.mock.calls[0][0]());

  expect(f.discover).toHaveBeenCalledTimes(2);
  fixture.rerender(<Fixture />);
  expect(screen.getByRole('button', { name: 'Updated editor' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'draw.io' })).toBeNull();
  expect(f.discover).toHaveBeenCalledTimes(2);
  expect(f.launch).not.toHaveBeenCalled();
});

test('updates home file icons from plugin discovery without launching an App', async () => {
  const { container } = render(<Fixture />);
  await waitFor(() =>
    expect(container.querySelector('[data-file-icon-kind="file"] img')).not.toBeNull(),
  );
  const pending = deferred<McpAppDiscovery>();
  f.discover.mockReturnValueOnce(pending.promise);
  act(() => {
    for (const [notify] of f.onExtensionsChanged.mock.calls)
      notify({ extensionId: 'drawio', enabled: false });
  });
  expect(container.querySelector('[data-file-icon-kind="file"] img')).toBeNull();
  await act(async () => pending.resolve({ servers: [] }));
  expect(container.querySelector('[data-file-icon-kind="file"] img')).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
});

test('returning home keeps its valid catalog without repeating preparation or discovery', async () => {
  const fixture = render(<Fixture />);
  await waitFor(() => expect(f.discover).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: 'draw.io' })).toBeTruthy();

  fixture.rerender(<Fixture home={false} />);
  expect(screen.queryByRole('button', { name: 'draw.io' })).toBeNull();
  expect(f.invalidate).toHaveBeenCalledWith(true);
  fixture.rerender(<Fixture />);

  expect(screen.getByRole('button', { name: 'draw.io' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: i18nService.t('mcpAppsDiscovering') })).toBeNull();
  expect(f.hosts).toHaveLength(1);
  expect(f.dispose).not.toHaveBeenCalled();
  const preparationCount = f.prepare.mock.calls.length;
  const discoveryCount = f.discover.mock.calls.length;
  expect(f.prepare).toHaveBeenCalledTimes(preparationCount);
  expect(f.discover).toHaveBeenCalledTimes(discoveryCount);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.discover).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'draw.io' })).toBeTruthy();
  expect(f.launch).not.toHaveBeenCalled();
});

test('a failed prefetch shows a retry on the sidebar homepage and can recover without launching an App', async () => {
  const firstDiscovery = deferred<McpAppDiscovery>();
  f.discover.mockReturnValueOnce(firstDiscovery.promise);
  render(<Fixture />);
  await waitFor(() => expect(f.discover).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: i18nService.t('mcpAppsDiscovering') })).toBeTruthy();

  await act(async () => firstDiscovery.reject(new Error('Gateway catalog unavailable')));

  const retry = screen.getByRole('button', { name: i18nService.t('mcpAppsRetryDiscovery') });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText(i18nService.t('mcpAppsDiscoveryFailed'))).toBeTruthy();
  const retryDiscovery = deferred<McpAppDiscovery>();
  f.discover.mockReturnValueOnce(retryDiscovery.promise);
  fireEvent.click(retry);
  await waitFor(() => expect(f.discover).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: i18nService.t('mcpAppsDiscovering') })).toBeTruthy();
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.discover).toHaveBeenCalledTimes(2);

  await act(async () => retryDiscovery.resolve(catalog));

  expect(screen.getByRole('button', { name: 'draw.io' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: i18nService.t('mcpAppsRetryDiscovery') })).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
});
