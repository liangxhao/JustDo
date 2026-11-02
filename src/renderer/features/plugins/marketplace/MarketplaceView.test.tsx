// @vitest-environment jsdom
import {
  MarketplaceErrorCode,
  type MarketplaceInstallResponse,
  MarketplaceInstallState,
  type MarketplacePlugin,
  PluginKind,
} from '@shared/plugins/marketplace';
import { PluginOperationStage } from '@shared/plugins/pluginOperation';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import PluginOperationFeedback from '@/features/plugins/shared/PluginOperationFeedback';
import { getPluginOperationOwner } from '@/features/plugins/shared/pluginOperationService';

import { InstalledMarketplaceAction } from './MarketplaceActions';
import MarketplaceToolbar from './MarketplaceToolbar';
import MarketplaceView, { MarketplaceResults } from './MarketplaceView';
import { type InstalledMarketplacePlugin, usePluginMarketplace } from './usePluginMarketplace';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'pluginOperationFailedAt' ? 'Step not completed: {stage}' : key),
    getLanguage: () => 'en',
  },
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
          supportedKinds: [PluginKind.EXTENSION, PluginKind.SKILL, PluginKind.MCP],
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
    install: vi.fn(async (): Promise<MarketplaceInstallResponse> => ({
      success: true,
      pluginId: 'writer',
      restartRequired: false,
    })),
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function Harness({
  installed = EMPTY,
  query = '',
  onInstalled,
  readOnly = false,
  offline = false,
  inventoryReady = true,
  kind = PluginKind.SKILL,
}: {
  installed?: InstalledMarketplacePlugin[];
  query?: string;
  onInstalled?: () => Promise<void>;
  readOnly?: boolean;
  offline?: boolean;
  inventoryReady?: boolean;
  kind?: typeof PluginKind.EXTENSION | typeof PluginKind.SKILL | typeof PluginKind.MCP;
}) {
  const c = usePluginMarketplace({
    kind,
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

test('keeps market loading in the bottom progress stack until results arrive', async () => {
  let finish!: () => void;
  api.search.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () =>
          resolve({ success: true, result: { items: [writer], nextCursor: undefined } });
      }),
  );
  const view = render(<Harness />);
  await waitFor(() => expect(api.search).toHaveBeenCalledOnce());
  const loading = screen.getByText('marketplaceLoading');
  expect(loading.closest('article, section')).toBeNull();
  expect(loading.closest('.fixed')?.classList.contains('bottom-4')).toBe(true);
  expect(view.container.contains(loading)).toBe(false);

  await act(async () => finish());
  expect(screen.getByText(writer.name)).toBeTruthy();
  expect(screen.queryByText('marketplaceLoading')).toBeNull();
});

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

test('does not repeat identity and update queries for an unchanged inventory projection', async () => {
  const view = render(<Harness installed={INSTALLED} />);
  await waitFor(() => expect(api.checkUpdates).toHaveBeenCalledOnce());
  const identityReads = api.resolveInstalled.mock.calls.length;
  view.rerender(<Harness installed={INSTALLED.map(item => ({ ...item }))} />);
  await act(async () => undefined);
  expect(api.resolveInstalled).toHaveBeenCalledTimes(identityReads);
  expect(api.checkUpdates).toHaveBeenCalledOnce();
});

test('keeps installation failure details in the result queue without displaying them on the card', async () => {
  api.install.mockResolvedValueOnce({
    success: false,
    error: 'Marketplace installation failed',
    failedStage: PluginOperationStage.VALIDATING,
  });
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() =>
    expect(getPluginOperationOwner().failureSnapshot()).toEqual([
      expect.objectContaining({
        label: 'Market writer',
        message: 'marketplaceValidationReasonUnavailable',
        details: 'Marketplace installation failed',
        failedStage: PluginOperationStage.VALIDATING,
        state: 'failed',
      }),
    ]),
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/Step not completed/)).toBeNull();
  expect(screen.queryByText(/Marketplace installation failed/)).toBeNull();
  expect(screen.getByRole('button', { name: 'marketplaceInstall' }).hasAttribute('disabled')).toBe(
    false,
  );
});

test('shows the full concrete installation reason in the result dialog while keeping it off cards', async () => {
  const reason = 'Package validation failed:\nThe manifest openclaw.plugin.json is missing.';
  api.install.mockResolvedValueOnce({
    success: false,
    error: reason,
    failedStage: PluginOperationStage.VALIDATING,
  });
  render(
    <>
      <Harness />
      <PluginOperationFeedback />
    </>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(
    within(dialog).getByText(
      /Package validation failed:\s+The manifest openclaw\.plugin\.json is missing\./,
    ),
  ).toBeTruthy();
  expect(within(dialog).getByText('pluginOperationStageLabel.validating')).toBeTruthy();
  expect(within(screen.getByRole('article')).queryByText(/manifest/)).toBeNull();
  expect(screen.queryByText('Marketplace installation failed')).toBeNull();
});

test.each([
  PluginOperationStage.FETCHING_METADATA,
  PluginOperationStage.DOWNLOADING,
  PluginOperationStage.EXTRACTING,
])(
  'explains controlled provider preparation failures at %s and retains the Main detail',
  async failedStage => {
    const diagnostic = 'Marketplace provider failed to prepare installation';
    api.install.mockResolvedValueOnce({
      success: false,
      errorCode: MarketplaceErrorCode.PROVIDER_FAILURE,
      error: diagnostic,
      failedStage,
    });
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));

    await waitFor(() =>
      expect(getPluginOperationOwner().failureSnapshot()).toEqual([
        expect.objectContaining({
          message: `marketplacePreparationFailure.${failedStage}`,
          details: diagnostic,
          failedStage,
        }),
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  },
);

test.each([
  {
    errorCode: MarketplaceErrorCode.INTERNAL,
    error: 'Native extension activation rejected: accessCode is required',
    failedStage: PluginOperationStage.ENABLING,
  },
  {
    errorCode: MarketplaceErrorCode.PROVIDER_FAILURE,
    error: 'Native package validation rejected',
    failedStage: PluginOperationStage.EXTRACTING,
  },
  {
    errorCode: MarketplaceErrorCode.INTERNAL,
    error: 'Marketplace provider failed to prepare installation',
    failedStage: PluginOperationStage.DOWNLOADING,
  },
  {
    errorCode: MarketplaceErrorCode.PROVIDER_FAILURE,
    error: 'Marketplace provider failed to prepare installation',
    failedStage: PluginOperationStage.VALIDATING,
  },
])('preserves other native or provider diagnostics: $errorCode / $failedStage', async response => {
  api.install.mockResolvedValueOnce({ success: false, ...response });
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toHaveLength(1));

  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({ message: response.error, failedStage: response.failedStage }),
  ]);
  expect(getPluginOperationOwner().failureSnapshot()[0].details).toBeUndefined();
});

test('retains a market failure after switching away before the request settles', async () => {
  let finish!: (response: MarketplaceInstallResponse) => void;
  api.install.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const view = render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  view.unmount();
  await act(async () =>
    finish({
      success: false,
      error: 'Installation rejected',
      failedStage: PluginOperationStage.VALIDATING,
    }),
  );
  expect(getPluginOperationOwner().snapshot()).toEqual([]);
  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({ message: 'Installation rejected', failedStage: 'validating' }),
  ]);
});

test('explains a controlled committed activation failure without guessing a configuration cause', async () => {
  api.install.mockResolvedValueOnce({
    success: false,
    installationCommitted: true,
    pluginId: 'writer',
    error: 'Marketplace installation failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
    failedStage: PluginOperationStage.ENABLING,
  });
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toHaveLength(1));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('marketplaceActivationIncomplete')).toBeNull();
  expect(screen.queryByText(/Marketplace installation failed/)).toBeNull();
  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({
      state: 'committed',
      message: 'marketplaceActivationIncomplete',
      details: 'Marketplace installation failed',
      failedStage: PluginOperationStage.ENABLING,
    }),
  ]);
});

test('explicitly reports a missing failure reason when the installer returns no error text', async () => {
  api.install.mockResolvedValueOnce({ success: false, failedStage: PluginOperationStage.VALIDATING });
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toHaveLength(1));
  expect(getPluginOperationOwner().failureSnapshot()[0]).toMatchObject({
    message: 'marketplaceValidationReasonUnavailable',
    failedStage: PluginOperationStage.VALIDATING,
  });
});

test.each([
  {
    error: 'Marketplace installation failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
    failedStage: PluginOperationStage.ENABLING,
  },
  {
    error: 'Marketplace installation failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
    failedStage: PluginOperationStage.CONFIRMING,
    installationCommitted: true,
  },
  {
    error: 'Native plugin activation rejected: required accessCode is missing',
    errorCode: MarketplaceErrorCode.INTERNAL,
    failedStage: PluginOperationStage.ENABLING,
    installationCommitted: true,
  },
  {
    error: 'Marketplace installation failed',
    errorCode: MarketplaceErrorCode.PROVIDER_FAILURE,
    failedStage: PluginOperationStage.ENABLING,
    installationCommitted: true,
  },
] as const)(
  'preserves activation diagnostics outside the exact controlled receipt: $failedStage / $error',
  async response => {
    api.install.mockResolvedValueOnce({ success: false, ...response });
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
    await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toHaveLength(1));

    const generic = response.error === 'Marketplace installation failed';
    expect(getPluginOperationOwner().failureSnapshot()).toEqual([
      expect.objectContaining({
        message: generic ? 'marketplaceFailureReasonUnavailable' : response.error,
        failedStage: response.failedStage,
      }),
    ]);
    expect(getPluginOperationOwner().failureSnapshot()[0].details).toBe(
      generic ? response.error : undefined,
    );
  },
);

test('retains a native refresh warning when a successful install settles after its view unmounts', async () => {
  let finish!: (response: MarketplaceInstallResponse) => void;
  api.install.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const view = render(<Harness onInstalled={vi.fn(async () => undefined)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  view.unmount();
  await act(async () => finish({ success: true, pluginId: 'writer', refreshWarning: true }));
  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({ state: 'refresh_failed', failedStage: 'refreshing_inventory' }),
  ]);
});

test('a final successful inventory read resolves a native post-install refresh warning', async () => {
  api.install.mockResolvedValueOnce({ success: true, pluginId: 'writer', refreshWarning: true });
  const refresh = vi.fn(async () => undefined);
  render(<Harness onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await waitFor(() => expect(getPluginOperationOwner().snapshot()).toEqual([]));
  expect(getPluginOperationOwner().failureSnapshot()).toEqual([]);
});

test('keeps committed installation protection after dismissing its failure result', async () => {
  api.install.mockResolvedValueOnce({
    success: false,
    installationCommitted: true,
    failedStage: PluginOperationStage.ENABLING,
    error: 'Activation refused',
  });
  const refresh = vi.fn().mockRejectedValue(new Error('offline'));
  render(<Harness onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toHaveLength(1));
  const owner = getPluginOperationOwner();
  expect(owner.failureSnapshot()[0]).toMatchObject({
    message: 'Activation refused',
    failedStage: PluginOperationStage.ENABLING,
    state: 'committed',
    details: 'marketplaceRefreshAfterInstallFailed',
  });
  act(() => owner.dismissFailure(owner.failureSnapshot()[0].requestId));
  expect(screen.getByText(/Activation refused/).closest('article')).toBeNull();
  expect(screen.getByText('marketplaceRefreshAfterInstallFailed')).toBeTruthy();
  const pending = screen.getByRole('button', { name: 'marketplaceStatusPending' });
  expect(pending.hasAttribute('disabled')).toBe(true);
  fireEvent.click(pending);
  expect(api.install).toHaveBeenCalledOnce();
});

test('an explicitly unconfirmed installation offers status refresh without replaying the install', async () => {
  api.install.mockResolvedValueOnce({
    success: false,
    installSourceInUse: true,
    failedStage: PluginOperationStage.INSTALLING,
    error: 'Installation result is unavailable',
  });
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toHaveLength(1));
  expect(getPluginOperationOwner().failureSnapshot()[0].state).toBe('unconfirmed');
  const pending = screen.getByRole('button', { name: 'marketplaceStatusPending' });
  expect(pending.hasAttribute('disabled')).toBe(true);
  fireEvent.click(pending);
  expect(api.install).toHaveBeenCalledOnce();
  expect(
    screen.getByRole('button', { name: 'marketplaceRefreshStatus' }).closest('article'),
  ).toBeNull();
});

test.each([false, true])(
  'explains a saved installation with a failed later step while retaining its list entry (update: %s)',
  async updating => {
    api.install.mockResolvedValueOnce({
      success: false,
      installationCommitted: true,
      pluginId: 'writer',
      error: 'Required configuration is missing',
      failedStage: PluginOperationStage.ENABLING,
    });
    let view: ReturnType<typeof render>;
    const refresh = vi.fn(async () => {
      view.rerender(
        <>
          <Harness installed={INSTALLED} onInstalled={refresh} />
          <PluginOperationFeedback />
        </>,
      );
    });
    view = render(
      <>
        <Harness installed={updating ? INSTALLED : EMPTY} onInstalled={refresh} />
        <PluginOperationFeedback />
      </>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: updating ? 'marketplaceUpdate' : 'marketplaceInstall',
      }),
    );
    await screen.findByTestId('local-writer');
    const dialog = await screen.findByRole('alertdialog', {
      name: `pluginOperationFailureTitle.${updating ? 'update' : 'install'}.committed`,
    });
    expect(within(dialog).getByText('pluginOperationInstallationOutcome.committed')).toBeTruthy();
    expect(within(dialog).getByText('Required configuration is missing')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'pluginOperationFailureDismiss' }));
    const installed = await screen.findByRole('button', { name: 'marketplaceInstalled' });
    expect(installed.hasAttribute('disabled')).toBe(true);
    fireEvent.click(installed);
    expect(api.install).toHaveBeenCalledOnce();
  },
);

test.each([false, true])('preserves an unknown outcome when manual refresh fails (content saved: %s)', async committed => {
  api.install.mockResolvedValueOnce({
    success: false,
    operationUnconfirmed: true,
    ...(committed ? { installationCommitted: true } : {}),
    error: 'Installation receipt is unavailable',
  });
  const refresh = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('offline'));
  render(
    <>
      <Harness installed={INSTALLED} onInstalled={refresh} />
      <PluginOperationFeedback />
    </>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  const first = await screen.findByRole('alertdialog', {
    name: committed ? 'pluginOperationFailureTitle.update.committed' : 'pluginOperationFailureTitle.unconfirmed',
  });
  expect(within(first).getByText(committed
    ? 'pluginOperationInstallationOutcome.committed'
    : 'pluginOperationInstallationOutcome.unconfirmed')).toBeTruthy();
  fireEvent.click(within(first).getByRole('button', { name: 'pluginOperationFailureDismiss' }));
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceRefreshStatus' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  const dialog = await screen.findByRole('alertdialog', {
    name: 'pluginOperationFailureTitle.unconfirmed',
  });
  expect(within(dialog).getByText('marketplaceRefreshAfterInstallFailed')).toBeTruthy();
  expect(screen.queryByText('pluginOperationFailureNext.refresh_failed')).toBeNull();
  expect(screen.queryByText('pluginOperationInstallationOutcome.committed')).toBeNull();
  expect(screen.getByTestId('local-writer')).toBeTruthy();
  expect(api.install).toHaveBeenCalledOnce();
});

test('keeps a previous local entry without declaring a failed update saved', async () => {
  api.install.mockResolvedValueOnce({
    success: false,
    error: 'New package validation failed',
    failedStage: PluginOperationStage.VALIDATING,
  });
  render(
    <>
      <Harness installed={INSTALLED} />
      <PluginOperationFeedback />
    </>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  const dialog = await screen.findByRole('alertdialog', {
    name: 'pluginOperationFailureTitle.update',
  });
  expect(within(dialog).getByText('New package validation failed')).toBeTruthy();
  expect(screen.getByTestId('local-writer')).toBeTruthy();
  expect(screen.queryByText('pluginOperationInstallationOutcome.committed')).toBeNull();
  expect(getPluginOperationOwner().failureSnapshot()[0].state).toBe('failed');
});

test('retains installed recommendations with a disabled install action and separate local controls', async () => {
  render(<Harness installed={INSTALLED} />);
  const installed = await screen.findByRole('button', { name: 'marketplaceInstalled' });
  expect(installed.hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Market writer')).toBeTruthy();
  expect(screen.getAllByTestId('local-writer')).toHaveLength(1);
  expect(screen.getAllByRole('switch')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'marketplaceUpdate' }).hasAttribute('disabled')).toBe(
    false,
  );
  fireEvent.click(installed);
  expect(api.install).not.toHaveBeenCalled();
});

test('restores installed recommendations after clearing a deduplicated search', async () => {
  const view = render(<Harness installed={INSTALLED} query="notes" />);
  await screen.findByTestId('local-writer');
  expect(screen.queryByText('Market writer')).toBeNull();
  view.rerender(<Harness installed={INSTALLED} />);
  await screen.findByText('Market writer');
  expect(screen.getAllByTestId('local-writer')).toHaveLength(1);
  expect(
    screen.getByRole('button', { name: 'marketplaceInstalled' }).hasAttribute('disabled'),
  ).toBe(true);
});

test('updates directly from the installed card even when recommendations are empty', async () => {
  api.search.mockResolvedValue({ success: true, result: { items: [], nextCursor: undefined } });
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() =>
    expect(api.install).toHaveBeenCalledWith(
      {
        sourceId: 'enterprise',
        pluginId: 'catalog-writer',
        kind: PluginKind.SKILL,
        version: '2.0',
        operation: 'update',
      },
      { requestId: expect.any(String) },
    ),
  );
  await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false));
  expect((await screen.findByText('marketplaceUpdateSucceeded')).closest('article')).toBeNull();
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
    expect(api.install).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0' }), {
      requestId: expect.any(String),
    }),
  );
});

test('shows install for an absent item even if the catalog claims it has updates', async () => {
  render(<Harness />);
  const install = await screen.findByRole('button', { name: 'marketplaceInstall' });
  fireEvent.click(install);
  await waitFor(() =>
    expect(api.install).toHaveBeenCalledWith(expect.objectContaining({ operation: 'install' }), {
      requestId: expect.any(String),
    }),
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

test.each(['', 'notes'])(
  'retains a newly installed recommendation and deduplicates a newly installed search result: %s',
  async query => {
    let view: ReturnType<typeof render>;
    const refresh = vi.fn(async () => {
      view.rerender(<Harness installed={INSTALLED} onInstalled={refresh} query={query} />);
    });
    view = render(<Harness onInstalled={refresh} query={query} />);
    fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
    await waitFor(() => expect(screen.getAllByTestId('local-writer')).toHaveLength(1));
    if (query)
      expect(screen.queryByRole('button', { name: 'subtaskShowInfo: Market writer' })).toBeNull();
    else {
      expect(screen.getByRole('button', { name: 'subtaskShowInfo: Market writer' })).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'marketplaceInstalled' }).hasAttribute('disabled'),
      ).toBe(true);
    }
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false));
    expect((await screen.findByText('marketplaceInstallSucceeded')).closest('article')).toBeNull();
  },
);

test('briefly shows confirmed success in progress feedback while keeping recommendations locked', async () => {
  let view: ReturnType<typeof render>;
  const refresh = vi.fn(async () => {
    view.rerender(<Harness installed={INSTALLED} onInstalled={refresh} />);
  });
  view = render(<Harness onInstalled={refresh} />);
  const install = await screen.findByRole('button', { name: 'marketplaceInstall' });
  vi.useFakeTimers();
  await act(async () => fireEvent.click(install));
  expect(screen.getByText('marketplaceInstallSucceeded').closest('article')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.queryByText('marketplaceInstallSucceeded')).toBeNull();
  const installed = screen.getByRole('button', { name: 'marketplaceInstalled' });
  expect(installed.hasAttribute('disabled')).toBe(true);
  fireEvent.click(installed);
  expect(api.install).toHaveBeenCalledTimes(1);
});

test('offers state refresh rather than reinstall after a committed installation refresh failure', async () => {
  const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  render(<Harness onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  const refreshButton = await screen.findByRole('button', { name: 'marketplaceRefreshStatus' });
  expect(refreshButton.closest('article')).toBeNull();
  expect(screen.getByText('marketplaceRefreshAfterInstallFailed').closest('article')).toBeNull();
  fireEvent.click(refreshButton);
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(api.install).toHaveBeenCalledTimes(1);
});

test.each([PluginKind.EXTENSION, PluginKind.SKILL, PluginKind.MCP])(
  'keeps restart-required feedback outside %s cards without claiming immediate activation',
  async kind => {
    api.install.mockResolvedValue({ success: true, pluginId: 'writer', restartRequired: true });
    api.search.mockResolvedValue({
      success: true,
      result: { items: [{ ...writer, kind }], nextCursor: undefined },
    });
    render(<Harness kind={kind} />);
    fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
    expect((await screen.findByText('marketplaceRestartRequired')).closest('article')).toBeNull();
    expect(within(screen.getByRole('article')).queryByRole('status')).toBeNull();
    expect(screen.queryByText('marketplaceInstallSucceeded')).toBeNull();
  },
);

test('keeps status refresh available after changing to a query with no cards', async () => {
  api.install.mockResolvedValueOnce({
    success: false,
    operationUnconfirmed: true,
    error: 'Installation result is unavailable',
  });
  const refresh = vi.fn(async () => undefined);
  const view = render(<Harness onInstalled={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await screen.findByRole('button', { name: 'marketplaceRefreshStatus' });
  api.search.mockResolvedValue({ success: true, result: { items: [], nextCursor: undefined } });
  view.rerender(<Harness query="no matches" onInstalled={refresh} />);
  await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  expect(screen.getByText('Market writer')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceRefreshStatus' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(api.install).toHaveBeenCalledOnce();
});

test('keeps standalone marketplace status feedback outside cards before inventory confirms installation', async () => {
  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>icon</span>} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  const refreshButton = await screen.findByRole('button', { name: 'marketplaceRefreshStatus' });
  expect(refreshButton.closest('article')).toBeNull();
  expect(within(screen.getByRole('article')).queryByRole('status')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'marketplaceStatusPending' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(refreshButton);
  expect(api.install).toHaveBeenCalledOnce();
});

test('leaves the failed card retryable and does not lose local controls', async () => {
  api.install.mockResolvedValueOnce({
    success: false,
    error: 'Download failed',
    failedStage: PluginOperationStage.DOWNLOADING,
  });
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toHaveLength(1));
  expect(screen.queryByText(/Download failed/)).toBeNull();
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() => expect(api.install).toHaveBeenCalledTimes(2));
});

test('retains a pending guard when the install bridge rejects without an outcome response', async () => {
  api.install.mockRejectedValueOnce(new Error('IPC connection closed'));
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));
  await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toHaveLength(1));
  expect(getPluginOperationOwner().failureSnapshot()[0].state).toBe('unconfirmed');
  const pending = screen.getByRole('button', { name: 'marketplaceStatusPending' });
  expect(pending.hasAttribute('disabled')).toBe(true);
  fireEvent.click(pending);
  expect(api.install).toHaveBeenCalledOnce();
});

test.each([
  { updating: false, updatesOnly: false },
  { updating: true, updatesOnly: false },
  { updating: true, updatesOnly: true },
])(
  'refreshes a committed failure without replaying installation ($updating, updates filter: $updatesOnly)',
  async ({ updating, updatesOnly }) => {
    api.install.mockResolvedValue({
      success: false,
      pluginId: 'writer',
      restartRequired: false,
      installationCommitted: true,
      error: 'Runtime activation failed after publishing',
    });
    const refresh = vi.fn(async () => undefined);
    render(<Harness installed={updating ? INSTALLED : EMPTY} onInstalled={refresh} />);
    if (updatesOnly)
      fireEvent.click(screen.getByRole('button', { name: /marketplaceFilter.updates/ }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: updating ? 'marketplaceUpdate' : 'marketplaceInstall',
      }),
    );
    expect(
      (await screen.findByText('Runtime activation failed after publishing')).closest('article'),
    ).toBeNull();
    expect(screen.getByText('Runtime activation failed after publishing')).toBeTruthy();
    expect(getPluginOperationOwner().failureSnapshot()).toEqual([
      expect.objectContaining({
        message: 'Runtime activation failed after publishing',
        state: 'committed',
      }),
    ]);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.queryByText('marketplaceUpdateSucceeded')).toBeNull();
    expect(screen.queryByText('marketplaceInstallSucceeded')).toBeNull();
    expect(screen.getByText('Runtime activation failed after publishing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'marketplaceRefreshStatus' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Runtime activation failed after publishing')).toBeTruthy();
    if (updatesOnly) {
      vi.useFakeTimers();
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      vi.useRealTimers();
      expect(screen.getByTestId('local-writer')).toBeTruthy();
      expect(screen.getByText('Runtime activation failed after publishing')).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'marketplaceUpdate' })).toBeNull();
    if (!updating) {
      const settled = screen.getByRole('button', { name: 'marketplaceStatusPending' });
      expect(settled.hasAttribute('disabled')).toBe(true);
      fireEvent.click(settled);
    }
    expect(api.install).toHaveBeenCalledTimes(1);
  },
);

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
  await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false));
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
      { requestId: expect.any(String) },
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
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false);
  expect(screen.getByText('marketplaceUpdateSucceeded').closest('article')).toBeNull();
});

test('briefly retains updated cards without success text in the updates filter', async () => {
  render(<Harness installed={INSTALLED} />);
  fireEvent.click(screen.getByRole('button', { name: /marketplaceFilter.updates/ }));
  const update = await screen.findByRole('button', { name: 'marketplaceUpdate' });
  vi.useFakeTimers();
  await act(async () => fireEvent.click(update));
  expect(screen.getByText('marketplaceUpdateSucceeded').closest('article')).toBeNull();

  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByTestId('local-writer')).toBeTruthy();
  expect(screen.getByText('marketplaceUpdateSucceeded').closest('article')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(screen.queryByText('marketplaceUpdateSucceeded')).toBeNull();
  expect(screen.queryByTestId('local-writer')).toBeNull();
  expect(screen.getByText('marketplaceNoKnownUpdates')).toBeTruthy();
  expect(api.install).toHaveBeenCalledTimes(1);
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
    (await screen.findByRole('button', { name: 'marketplaceStatusPending' })).hasAttribute(
      'disabled',
    ),
  ).toBe(true);
  expect(api.install).toHaveBeenCalledTimes(1);
});

test('does not retire a committed update against a remounted view that has not loaded its inventory', async () => {
  const first = render(<Harness installed={INSTALLED} />);
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false));
  expect(screen.getByText('marketplaceUpdateSucceeded').closest('article')).toBeNull();
  first.unmount();
  const next = render(<Harness inventoryReady={false} />);
  const pending = await screen.findByRole('button', { name: 'marketplaceStatusPending' });
  expect(screen.queryByText('marketplaceUpdateSucceeded')).toBeNull();
  expect(pending.hasAttribute('disabled')).toBe(true);
  next.rerender(<Harness installed={INSTALLED} inventoryReady />);
  expect(await screen.findByTestId('local-writer')).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'marketplaceUpdate' })).toBeNull(),
  );
  expect(api.install).toHaveBeenCalledTimes(1);
});
