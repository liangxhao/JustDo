// @vitest-environment jsdom
import {
  MarketplaceInstallState,
  type MarketplacePlugin,
  PluginKind,
} from '@shared/plugins/marketplace';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { InstalledMarketplaceAction, MarketplaceFeedback } from './MarketplaceActions';
import MarketplaceToolbar from './MarketplaceToolbar';
import { MarketplaceResults } from './MarketplaceView';
import { type InstalledMarketplacePlugin, usePluginMarketplace } from './usePluginMarketplace';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));
const writer: MarketplacePlugin = {
  id: 'catalog-writer',
  runtimeId: 'writer',
  kind: PluginKind.SKILL,
  name: 'Market writer',
  description: 'Write notes',
  sourceId: 'enterprise',
  version: '2.0',
  installState: MarketplaceInstallState.UPDATE_AVAILABLE,
};
const local: InstalledMarketplacePlugin = {
  id: 'writer',
  version: '1.0',
  installPath: '/skills/writer',
  updateEligible: true,
};
const EMPTY: InstalledMarketplacePlugin[] = [];
const INSTALLED = [local];
const identity = { runtimeId: 'writer', sourceId: 'enterprise', pluginId: 'catalog-writer' };
function setup() {
  const api = {
    listSources: vi.fn(async () => ({
      success: true,
      sources: [
        {
          id: 'enterprise',
          name: 'Enterprise',
          supportedKinds: [PluginKind.SKILL],
          supportsUpdates: true,
          supportsDetail: false,
          supportsCategories: false,
        },
      ],
    })),
    resolveInstalled: vi.fn(async () => ({ success: true, installations: [identity] })),
    search: vi.fn(async () => ({
      success: true,
      result: { items: [writer], nextCursor: undefined as string | undefined },
    })),
    checkUpdates: vi.fn(async () => ({ success: true, result: { updates: [writer] } })),
    install: vi.fn(async () => ({ success: true, pluginId: 'writer', restartRequired: false })),
    detail: vi.fn(async () => ({ success: true, detail: writer })),
    listCategories: vi.fn(async () => ({
      success: true,
      result: { categories: [{ id: 'writing', name: 'Writing' }] },
    })),
  };
  Object.defineProperty(window, 'electron', { configurable: true, value: { marketplace: api } });
  return api;
}
let api: ReturnType<typeof setup>;
beforeEach(() => {
  api = setup();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Harness({
  installed = EMPTY,
  query = '',
  onInstalled,
  readOnly = false,
  offline = false,
  inventoryReady = true,
}: {
  installed?: InstalledMarketplacePlugin[];
  query?: string;
  onInstalled?: () => Promise<void>;
  readOnly?: boolean;
  offline?: boolean;
  inventoryReady?: boolean;
}) {
  const c = usePluginMarketplace({
    kind: PluginKind.SKILL,
    installed,
    searchQuery: query,
    onInstalled,
    readOnly,
    runtimeUnavailable: offline,
    inventoryReady,
  });
  const card = (id: string) => (
    <article key={id} data-testid={`local-${id}`}>
      <span>Local {id}</span>
      <InstalledMarketplaceAction controller={c} id={id} />
      <button
        role="switch"
        aria-checked="false"
        aria-label={`enable ${id}`}
        disabled={c.operationFor(id)?.busy}
      >
        switch
      </button>
      <MarketplaceFeedback controller={c} id={id} />
    </article>
  );
  return (
    <>
      <MarketplaceToolbar controller={c} />
      {installed
        .filter(item => c.matchesInstalled(item.id, item.id.includes(query)))
        .map(item => card(item.id))}
      <MarketplaceResults controller={c} icon={<span>icon</span>} renderInstalled={card} />
    </>
  );
}

test('searches the market and includes installed matches found only in market metadata once', async () => {
  render(<Harness installed={INSTALLED} query="notes" />);
  expect(await screen.findByTestId('local-writer')).toBeTruthy();
  expect(screen.queryByText('Market writer')).toBeNull();
  expect(api.search).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    sourceId: 'enterprise',
    query: 'notes',
    limit: 60,
  });
  expect(screen.getAllByRole('switch')).toHaveLength(1);
  expect(screen.queryByRole('combobox')).toBeNull();
});

test('updates directly from the installed card even when recommendations are empty', async () => {
  api.search.mockResolvedValue({ success: true, result: { items: [], nextCursor: undefined } });
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() =>
    expect(api.install).toHaveBeenCalledWith({
      sourceId: 'enterprise',
      pluginId: 'catalog-writer',
      kind: PluginKind.SKILL,
      version: '2.0',
      operation: 'update',
    }),
  );
  expect(await screen.findByText('marketplaceUpdateSucceeded')).toBeTruthy();
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
});

test('uses the bulk candidate version rather than stale search metadata', async () => {
  api.search.mockResolvedValue({
    success: true,
    result: { items: [{ ...writer, version: '1.1' }], nextCursor: undefined },
  });
  render(<Harness installed={INSTALLED} query="notes" />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() =>
    expect(api.install).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0' })),
  );
});

test('shows install for an absent item even if the catalog claims it has updates', async () => {
  render(<Harness />);
  const install = await screen.findByRole('button', { name: 'marketplaceInstall' });
  fireEvent.click(install);
  await waitFor(() =>
    expect(api.install).toHaveBeenCalledWith(expect.objectContaining({ operation: 'install' })),
  );
});

test('does not update or overwrite a same-name local import without registry identity', async () => {
  api.resolveInstalled.mockResolvedValue({ success: true, installations: [] });
  render(<Harness installed={INSTALLED} />);
  const conflict = await screen.findByRole('button', { name: 'marketplaceLocalConflict' });
  expect(conflict.hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'marketplaceUpdate' })).toBeNull();
  fireEvent.click(conflict);
  expect(api.install).not.toHaveBeenCalled();
  expect(api.checkUpdates).not.toHaveBeenCalled();
});

test('does not offer updates for system-managed inventory even with a registry record', async () => {
  render(<Harness installed={[{ ...local, updateEligible: false }]} />);
  await waitFor(() => expect(api.search).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: 'marketplaceUpdate' })).toBeNull();
  expect(api.checkUpdates).not.toHaveBeenCalled();
});

test('serializes duplicate clicks and blocks enable changes during an update', async () => {
  let finish!: (value: { success: boolean; pluginId: string; restartRequired: boolean }) => void;
  api.install.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  render(<Harness installed={INSTALLED} />);
  const button = await screen.findByRole('button', { name: 'marketplaceUpdate' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.install).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);
  await act(async () => finish({ success: true, pluginId: 'writer', restartRequired: false }));
  await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false));
});

test('keeps a new installation in the original result position and reuses local controls', async () => {
  let view: ReturnType<typeof render>;
  const refresh = vi.fn(async () => {
    view.rerender(<Harness installed={INSTALLED} onInstalled={refresh} />);
  });
  view = render(<Harness onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() => expect(screen.getAllByTestId('local-writer')).toHaveLength(1));
  expect(screen.queryByText('Market writer')).toBeNull();
  expect(screen.getAllByRole('switch')).toHaveLength(1);
});

test('offers state refresh rather than reinstall after a committed installation refresh failure', async () => {
  const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  render(<Harness onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceRefreshStatus' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(api.install).toHaveBeenCalledTimes(1);
});

test('shows restart-required feedback without claiming immediate activation', async () => {
  api.install.mockResolvedValue({ success: true, pluginId: 'writer', restartRequired: true });
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  expect(await screen.findByText('marketplaceRestartRequired')).toBeTruthy();
  expect(screen.queryByText('marketplaceInstallSucceeded')).toBeNull();
});

test('leaves the failed card retryable and does not lose local controls', async () => {
  api.install.mockRejectedValueOnce(new Error('Download failed'));
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  expect(await screen.findByText('Download failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() => expect(api.install).toHaveBeenCalledTimes(2));
});

test('installed and update filters retain background checks but hide market-only items', async () => {
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceFilter.installed' }));
  expect(await screen.findByRole('button', { name: 'marketplaceUpdate' })).toBeTruthy();
  expect(screen.queryByText('marketplaceDiscoverTitle')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /marketplaceFilter.updates/ }));
  expect(screen.getByTestId('local-writer')).toBeTruthy();
});

test('reports update check failures distinctly and allows a manual retry', async () => {
  api.checkUpdates.mockRejectedValueOnce(new Error('offline'));
  render(<Harness installed={INSTALLED} />);
  expect(await screen.findByText('marketplaceCheckFailed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceRetry' }));
  await waitFor(() => expect(api.checkUpdates).toHaveBeenCalledTimes(2));
});

test('keeps local controls available when no market is configured', async () => {
  api.listSources.mockResolvedValue({ success: true, sources: [] });
  render(<Harness installed={INSTALLED} />);
  expect(await screen.findByText('marketplaceNotConfigured')).toBeTruthy();
  expect(screen.getByRole('switch')).toBeTruthy();
  expect(api.search).not.toHaveBeenCalled();
});

test('keeps local results visible when market search fails and retries it', async () => {
  api.search.mockRejectedValueOnce(new Error('offline'));
  render(<Harness installed={INSTALLED} />);
  expect(await screen.findByText('marketplaceLoadFailed')).toBeTruthy();
  expect(screen.getByRole('switch')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceRetry' }));
  await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
});

test('does not let an older query response replace the latest search', async () => {
  let finish!: (response: Awaited<ReturnType<typeof api.search>>) => void;
  api.search.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const view = render(<Harness query="old" />);
  await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1));
  view.rerender(<Harness query="new" />);
  expect(await screen.findByText('Market writer')).toBeTruthy();
  await act(async () =>
    finish({
      success: true,
      result: { items: [{ ...writer, name: 'Old result' }], nextCursor: undefined },
    }),
  );
  expect(screen.queryByText('Old result')).toBeNull();
});

test('keeps pagination accessible when every item on the first page is already installed', async () => {
  api.search.mockResolvedValueOnce({
    success: true,
    result: { items: [writer], nextCursor: 'next' },
  });
  api.search.mockResolvedValueOnce({
    success: true,
    result: {
      items: [{ ...writer, id: 'another', runtimeId: 'another', name: 'Another plugin' }],
      nextCursor: undefined,
    },
  });
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceLoadMore' }));
  expect(await screen.findByText('Another plugin')).toBeTruthy();
});

test('clears recommendation categories when searching and omits unsupported details', async () => {
  api.listSources.mockResolvedValue({
    success: true,
    sources: [
      {
        id: 'enterprise',
        name: 'Enterprise',
        supportedKinds: [PluginKind.SKILL],
        supportsCategories: true,
        supportsUpdates: false,
        supportsDetail: false,
      },
    ],
  });
  const view = render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'Writing' }));
  await waitFor(() =>
    expect(api.search).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'writing' })),
  );
  view.rerender(<Harness query="notes" />);
  await waitFor(() =>
    expect(api.search).toHaveBeenLastCalledWith({
      kind: PluginKind.SKILL,
      sourceId: 'enterprise',
      query: 'notes',
      limit: 60,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: Market writer' }));
  expect(api.detail).not.toHaveBeenCalled();
});

test.each([{ readOnly: true }, { offline: true }])(
  'disables mutations when blocked: %o',
  async props => {
    render(<Harness {...props} />);
    const button = await screen.findByRole('button', { name: 'marketplaceInstall' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(api.install).not.toHaveBeenCalled();
  },
);

test('a newly installed item remains available when switching to the installed filter', async () => {
  let view: ReturnType<typeof render>;
  const refresh = vi.fn(async () => {
    view.rerender(<Harness installed={INSTALLED} onInstalled={refresh} />);
  });
  view = render(<Harness onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await screen.findByTestId('local-writer');
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceFilter.installed' }));
  expect(screen.getAllByTestId('local-writer')).toHaveLength(1);
});

test('a late installation completion does not hide local results of a newer query', async () => {
  let finish!: (value: { success: boolean; pluginId: string; restartRequired: boolean }) => void;
  api.install.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  let view: ReturnType<typeof render>;
  const refresh = vi.fn(async () => {
    view.rerender(<Harness query="writer" installed={INSTALLED} onInstalled={refresh} />);
  });
  view = render(<Harness onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  api.search.mockResolvedValue({ success: true, result: { items: [], nextCursor: undefined } });
  view.rerender(<Harness query="writer" onInstalled={refresh} />);
  await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
  await act(async () => finish({ success: true, pluginId: 'writer', restartRequired: false }));
  expect(await screen.findByTestId('local-writer')).toBeTruthy();
});

test('a completed update does not suppress a subsequently discovered newer version', async () => {
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  await screen.findByText('marketplaceUpdateSucceeded');
  api.checkUpdates.mockResolvedValue({
    success: true,
    result: { updates: [{ ...writer, version: '3.0' }] },
  });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'marketplaceCheckUpdates' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceCheckUpdates' }));
  const update = await screen.findByRole('button', { name: 'marketplaceUpdate' });
  expect(update.hasAttribute('disabled')).toBe(false);
  fireEvent.click(update);
  await waitFor(() =>
    expect(api.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: '3.0', operation: 'update' }),
    ),
  );
});

test('opens optional native details without making installation depend on them', async () => {
  api.listSources.mockResolvedValue({
    success: true,
    sources: [
      {
        id: 'enterprise',
        name: 'Enterprise',
        supportedKinds: [PluginKind.SKILL],
        supportsUpdates: false,
        supportsCategories: false,
        supportsDetail: true,
      },
    ],
  });
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'subtaskShowInfo: Market writer' }));
  await waitFor(() =>
    expect(api.detail).toHaveBeenCalledWith({
      sourceId: 'enterprise',
      kind: PluginKind.SKILL,
      pluginId: 'catalog-writer',
    }),
  );
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'marketplaceInstall' })).toHaveLength(2),
  );
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  expect(screen.getAllByRole('button', { name: 'marketplaceInstall' })).toHaveLength(1);
});

test('allows retry when identity refresh interrupts a pending update check', async () => {
  api.checkUpdates.mockImplementationOnce(() => new Promise(() => undefined));
  const view = render(<Harness installed={INSTALLED} />);
  await screen.findByRole('button', { name: 'marketplaceChecking' });
  api.resolveInstalled.mockRejectedValueOnce(new Error('inventory unavailable'));
  view.rerender(<Harness installed={[{ ...local, version: '1.1' }]} />);
  await screen.findByText('marketplaceCheckFailed');
  const retry = screen.getByRole('button', { name: 'marketplaceCheckUpdates' });
  expect(retry.hasAttribute('disabled')).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect(api.checkUpdates).toHaveBeenCalledTimes(2));
  await screen.findByRole('button', { name: 'marketplaceUpdate' });
});

test('keeps an updated card visible throughout a slow inventory refresh', async () => {
  let finish!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  render(<Harness installed={INSTALLED} onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: /marketplaceFilter.updates/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 1900));
  });
  expect(screen.getByTestId('local-writer')).toBeTruthy();
  await act(async () => finish());
  expect(await screen.findByText('marketplaceUpdateSucceeded')).toBeTruthy();
});

test.each(['refresh-failure', 'restart-required'])(
  'keeps actionable update feedback visible: %s',
  async reason => {
    const refresh =
      reason === 'refresh-failure'
        ? vi.fn().mockRejectedValue(new Error('inventory offline'))
        : vi.fn().mockResolvedValue(undefined);
    api.install.mockResolvedValue({
      success: true,
      pluginId: 'writer',
      restartRequired: reason === 'restart-required',
    });
    render(<Harness installed={INSTALLED} onInstalled={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: /marketplaceFilter.updates/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
    const message =
      reason === 'refresh-failure'
        ? 'marketplaceRefreshAfterInstallFailed'
        : 'marketplaceRestartRequired';
    await screen.findByText(message);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1900));
    });
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText('marketplaceNoKnownUpdates')).toBeNull();
  },
);

test('shows source failures and retry even in the updates filter', async () => {
  api.listSources.mockRejectedValueOnce(new Error('offline'));
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(screen.getByRole('button', { name: /marketplaceFilter.updates/ }));
  await screen.findByText('marketplaceLoadFailed');
  expect(screen.queryByText('marketplaceNoKnownUpdates')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceRetry' }));
  await screen.findByRole('button', { name: 'marketplaceUpdate' });
});

test('keeps an in-flight install locked across unmount and remount and refreshes the current view', async () => {
  let finish!: (value: { success: boolean; pluginId: string; restartRequired: boolean }) => void;
  api.install.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const oldRefresh = vi.fn(async () => undefined);
  const currentRefresh = vi.fn(async () => undefined);
  const first = render(<Harness onInstalled={oldRefresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  first.unmount();
  render(<Harness onInstalled={currentRefresh} />);
  const busy = await screen.findByRole('button', { name: 'marketplaceInstalling' });
  fireEvent.click(busy);
  expect(api.install).toHaveBeenCalledTimes(1);
  await act(async () => finish({ success: true, pluginId: 'writer', restartRequired: true }));
  await waitFor(() => expect(currentRefresh).toHaveBeenCalledTimes(1));
  expect(oldRefresh).not.toHaveBeenCalled();
  expect(await screen.findByText('marketplaceRestartRequired')).toBeTruthy();
});

test('retains completed install feedback and reconciles when returning after completion', async () => {
  let finish!: (value: { success: boolean; pluginId: string; restartRequired: boolean }) => void;
  api.install.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const first = render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  first.unmount();
  await act(async () => finish({ success: true, pluginId: 'writer', restartRequired: true }));
  const refresh = vi.fn(async () => undefined);
  render(<Harness onInstalled={refresh} />);
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('marketplaceRestartRequired')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'marketplaceStatusPending' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.install).toHaveBeenCalledTimes(1);
});

test('does not retire a committed update against a remounted view that has not loaded its inventory', async () => {
  const first = render(<Harness installed={INSTALLED} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  expect(await screen.findByText('marketplaceUpdateSucceeded')).toBeTruthy();
  first.unmount();
  const next = render(<Harness inventoryReady={false} />);
  expect(await screen.findByText('marketplaceUpdateSucceeded')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'marketplaceStatusPending' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  next.rerender(<Harness installed={INSTALLED} inventoryReady />);
  expect(await screen.findByTestId('local-writer')).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'marketplaceUpdate' })).toBeNull(),
  );
  expect(api.install).toHaveBeenCalledTimes(1);
});
