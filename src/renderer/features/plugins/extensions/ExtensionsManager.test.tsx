// @vitest-environment jsdom

import { defaultAgentTeamSettings } from '@shared/cowork/agent-team/agentTeamSettings';
import type {
  ExtensionChangedEvent,
  ExtensionImportResult,
  ExtensionSetEnabledResult,
  InstalledOpenClawExtension,
  OpenClawPluginCapabilityReview,
} from '@shared/plugins/extensions';
import { getExtensionManagement } from '@shared/plugins/management';
import { PluginOperationStage } from '@shared/plugins/pluginOperation';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OPEN_TEAM_RECORDS } from '@/features/cowork/components/display/summary/agentTeamHistory';
import PluginOperationFeedback from '@/features/plugins/shared/PluginOperationFeedback';
import { getPluginOperationOwner } from '@/features/plugins/shared/pluginOperationService';

import ExtensionsManager from './ExtensionsManager';

vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({
  getEngineReadinessSnapshot: () => ({ ready: true }),
  subscribeEngineReadiness: () => vi.fn(),
}));

vi.mock('@/features/plugins/marketplace/MarketplaceView', () => ({
  MarketplaceResults: ({
    controller,
  }: {
    controller: { refreshInventory: () => Promise<void> };
  }) => (
    <button onClick={() => void controller.refreshInventory()}>finishMarketplaceInstall</button>
  ),
}));

vi.mock('@/features/plugins/marketplace/usePluginMarketplace', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/features/plugins/marketplace/usePluginMarketplace')>();
  return {
    ...actual,
    usePluginMarketplace: (options: { onInstalled?: () => Promise<void> }) => ({
      filter: 'all',
      source: null,
      query: '',
      updateById: new Map(),
      recentlyUpdated: new Set(),
      operations: {},
      matchesInstalled: (_id: string, matches: boolean) => matches,
      operationFor: () => undefined,
      setFilter: () => undefined,
      refreshInventory: options.onInstalled,
    }),
  };
});

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key === 'extensionDeleteSuccess'
      ? 'Extension "{name}" deleted'
      : key === 'pluginImportPartialSummary' ? '{successCount} succeeded and {failureCount} failed.' : key,
    getLanguage: () => 'en',
  },
}));

const extension: InstalledOpenClawExtension = {
  id: 'sample-extension',
  name: 'Sample Extension',
  description: 'Sample description',
  installPath: 'C:\\extensions\\sample-extension',
  enabled: false,
  canToggle: true,
  removable: true,
  missingRequirements: [],
  configurationFields: [],
};

const capabilityReview: OpenClawPluginCapabilityReview = {
  reviewToken: 'review-token',
  declared: {
    channels: [],
    providers: [],
    tools: ['sample.read'],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  grants: {
    hooks: {
      allowPromptInjection: { effective: false },
      allowConversationAccess: { effective: false },
    },
  },
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

test.each([1, 2])('reports the real reason and counts for %s rejected imports', async count => {
  const paths = ['C:/imports/first', 'C:/imports/second'].slice(0, count);
  const importPath = vi.fn().mockResolvedValue({
    success: false, error: 'Invalid native package', failedStage: 'validating',
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: {
        list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
        importPath, onChanged: () => () => undefined,
      },
      dialog: { selectFolders: vi.fn().mockResolvedValue({
        success: true, paths,
      }) },
    },
  });
  render(<ExtensionsManager />);
  fireEvent.click(await screen.findByRole('button', { name: 'importExtension' }));
  fireEvent.click(screen.getByRole('button', { name: /selectExtensionFolders/ }));
  await waitFor(() => expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({
      label: count === 1 ? 'first' : 'importExtension',
      message: count === 1 ? 'Invalid native package' : '0 succeeded and 2 failed.',
      items: paths.map(sourcePath => expect.objectContaining({
        label: sourcePath.split('/').pop(), failedStage: 'validating',
      })),
    }),
  ]));
  expect(importPath).toHaveBeenCalledTimes(count);
  cleanup();
});

test('retains an extension failure after leaving the category and preserves the failed phase', async () => {
  const reply = deferred<ExtensionSetEnabledResult>();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: {
        list: vi.fn().mockResolvedValue({ success: true, extensions: [extension] }),
        setEnabled: vi.fn(() => reply.promise),
        onChanged: () => () => undefined,
      },
    },
  });
  const view = render(<ExtensionsManager />);
  fireEvent.click(await screen.findByRole('switch', { name: 'extensionEnable' }));
  view.unmount();

  await act(async () =>
    reply.resolve({
      success: false,
      error: 'Native apply failed',
      failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
    }),
  );

  expect(getPluginOperationOwner().snapshot()).toEqual([]);
  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({
      message: 'Native apply failed',
      failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
    }),
  ]);
});

test.each(['cancel', 'unmount'] as const)(
  'keeps earlier import failures when capability review ends by %s',
  async end => {
    const importPath = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: 'Invalid first package',
        failedStage: PluginOperationStage.VALIDATING,
      })
      .mockResolvedValueOnce({ success: false, capabilityReview });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
          importPath,
          onChanged: () => () => undefined,
        },
        dialog: {
          selectFolders: vi.fn().mockResolvedValue({
            success: true,
            paths: ['C:/imports/invalid', 'C:/imports/reviewed'],
          }),
        },
      },
    });
    const view = render(<ExtensionsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'importExtension' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /selectExtensionFolders selectExtensionFoldersDescription/,
      }),
    );
    await screen.findByText('extensionCapabilityReviewTitle');
    if (end === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    else view.unmount();

    const failures = getPluginOperationOwner().failureSnapshot();
    expect(failures).toHaveLength(1);
    expect(failures[0].items).toEqual([
      expect.objectContaining({
        label: 'invalid',
        message: 'Invalid first package',
        failedStage: PluginOperationStage.VALIDATING,
      }),
    ]);
    expect(importPath).toHaveBeenCalledTimes(2);
    cleanup();
  },
);

test('keeps accumulated errors when the next review response arrives after unmount', async () => {
  const review = deferred<ExtensionImportResult>();
  const importPath = vi
    .fn()
    .mockResolvedValueOnce({
      success: false,
      error: 'First package rejected',
      failedStage: PluginOperationStage.VALIDATING,
    })
    .mockReturnValueOnce(review.promise);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: {
        list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
        importPath,
        onChanged: () => () => undefined,
      },
      dialog: {
        selectFolders: vi
          .fn()
          .mockResolvedValue({ success: true, paths: ['C:/imports/first', 'C:/imports/second'] }),
      },
    },
  });
  const view = render(<ExtensionsManager />);
  fireEvent.click(await screen.findByRole('button', { name: 'importExtension' }));
  fireEvent.click(
    screen.getByRole('button', {
      name: /selectExtensionFolders selectExtensionFoldersDescription/,
    }),
  );
  await waitFor(() => expect(importPath).toHaveBeenCalledTimes(2));
  view.unmount();
  await act(async () => review.resolve({ success: false, capabilityReview }));

  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({
      items: [expect.objectContaining({ message: 'First package rejected' })],
    }),
  ]);
});

describe('ExtensionsManager extension toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  test.each([true, false])(
    'keeps the refreshed marketplace inventory when the initial read finishes late (success: %s)',
    async success => {
      const oldRead = deferred<{
        success: boolean;
        extensions: InstalledOpenClawExtension[];
        error?: string;
      }>();
      const list = vi
        .fn()
        .mockReturnValueOnce(oldRead.promise)
        .mockResolvedValue({ success: true, extensions: [extension] });
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          extensions: {
            list,
            onChanged: vi.fn(() => vi.fn()),
          },
        },
      });
      render(<ExtensionsManager />);
      fireEvent.click(screen.getByRole('button', { name: 'finishMarketplaceInstall' }));
      await screen.findByText(extension.name);

      await act(async () => {
        oldRead.resolve({ success, extensions: [], error: 'Stale list refused' });
        await oldRead.promise;
      });

      expect(screen.getByText(extension.name)).toBeTruthy();
      expect(screen.queryByText('Stale list refused')).toBeNull();
      expect(list).toHaveBeenCalledTimes(2);
    },
  );

  test('refreshes external extension changes and ignores the superseded read after a newer change', async () => {
    const oldRead = deferred<{ success: boolean; extensions: InstalledOpenClawExtension[] }>();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: true, extensions: [extension] })
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue({ success: true, extensions: [{ ...extension, enabled: true }] });
    let changed!: (event: ExtensionChangedEvent) => void;
    const stop = vi.fn();
    const onChanged = vi.fn((listener: typeof changed) => {
      changed = listener;
      return stop;
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { extensions: { list, onChanged } },
    });
    const view = render(<ExtensionsManager />);
    await screen.findByRole('switch', { name: 'extensionEnable' });
    expect(onChanged).toHaveBeenCalledOnce();

    await act(async () => {
      changed({ extensionId: extension.id, enabled: true });
      changed({ extensionId: extension.id, enabled: true });
    });
    await screen.findByRole('switch', { name: 'extensionDisable' });
    await act(async () => {
      oldRead.resolve({ success: true, extensions: [extension] });
      await oldRead.promise;
    });

    expect(screen.getByRole('switch', { name: 'extensionDisable' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'extensionEnable' })).toBeNull();
    view.unmount();
    expect(stop).toHaveBeenCalledOnce();
    changed({ extensionId: extension.id, enabled: true });
    expect(list).toHaveBeenCalledTimes(3);
  });

  test('joins a newer event refresh when saving configuration so details use the latest inventory', async () => {
    const configured = (value: boolean): InstalledOpenClawExtension => ({
      ...extension,
      configurationFields: [
        { path: 'apiKey', label: 'Sample credential', sensitive: true, configured: value },
      ],
    });
    const oldRead = deferred<{ success: boolean; extensions: InstalledOpenClawExtension[] }>();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: true, extensions: [configured(false)] })
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue({ success: true, extensions: [configured(true)] });
    let changed!: (event: ExtensionChangedEvent) => void;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list,
          updateConfiguration: vi.fn().mockResolvedValue({ success: true }),
          onChanged: vi.fn((listener: typeof changed) => {
            changed = listener;
            return vi.fn();
          }),
        },
      },
    });
    render(<ExtensionsManager requestedExtensionId={extension.id} />);
    const input = (await screen.findByLabelText('Sample credential')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'synthetic-ui-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => changed({ extensionId: extension.id, enabled: false }));

    await act(async () => {
      oldRead.resolve({ success: true, extensions: [configured(false)] });
      await oldRead.promise;
    });

    await waitFor(() => expect(input.placeholder).toBe('extensionConfigurationStored'));
    expect(input.value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('extensionConfigurationSaved');
    expect(list).toHaveBeenCalledTimes(3);
  });

  test.each(['stt-local-cli', 'tts-local-cli'])(
    'shows a model settings gear on the disabled %s card without enabling it',
    async id => {
      const setEnabled = vi.fn();
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          extensions: {
            list: vi.fn(async () => ({
              success: true,
              extensions: [{ ...extension, id, name: id }],
            })),
            setEnabled,
            onChanged: vi.fn(() => vi.fn()),
          },
          localSpeechModels: {
            list: vi.fn(async () => ({ supported: true, models: [] })),
            onChanged: vi.fn(() => vi.fn()),
          },
        },
      });
      render(<ExtensionsManager />);
      fireEvent.click(
        await screen.findByRole('button', { name: `${id} · speechExtensionModelSettings` }),
      );
      expect(
        screen.getByRole('dialog', { name: `${id} · speechExtensionModelSettings` }),
      ).toBeTruthy();
      expect(setEnabled).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: id, level: 2 })).toBeNull();
    },
  );

  test.each([false, true])(
    'reconciles open extension details after an external change (removed: %s)',
    async removed => {
      const list = vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          extensions: [{ ...extension, error: 'Previous failure' }],
        })
        .mockResolvedValue({
          success: true,
          extensions: removed ? [] : [{ ...extension, error: 'Current runtime failure' }],
        });
      let changed!: (event: ExtensionChangedEvent) => void;
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          extensions: {
            list,
            onChanged: vi.fn((listener: typeof changed) => {
              changed = listener;
              return vi.fn();
            }),
          },
        },
      });
      render(<ExtensionsManager />);
      fireEvent.click(
        await screen.findByRole('button', { name: 'subtaskShowInfo: Sample Extension' }),
      );
      expect(screen.getByText('Previous failure')).toBeTruthy();

      await act(async () => changed({ extensionId: extension.id, enabled: false }));

      await waitFor(() => expect(screen.queryByText('Previous failure')).toBeNull());
      if (removed) expect(screen.queryByRole('button', { name: 'extensionDelete' })).toBeNull();
      else expect(screen.getByText('Current runtime failure')).toBeTruthy();
    },
  );

  test.each([
    { success: true, sameId: false },
    { success: false, sameId: false },
    { success: true, sameId: true },
    { success: false, sameId: true },
  ])(
    'isolates a late configuration result from reopened details ($success, same ID: $sameId)',
    async ({ success, sameId }) => {
      const configured = (id: string, name: string): InstalledOpenClawExtension => ({
        ...extension,
        id,
        name,
        configurationFields: [
          { path: 'apiKey', label: `${name} credential`, sensitive: true, configured: false },
        ],
      });
      const first = configured('first-plugin', 'First plugin');
      const second = configured('second-plugin', 'Second plugin');
      let inventory = [first, second];
      const pending = deferred<{ success: boolean; pending?: boolean; error?: string }>();
      const updateConfiguration = vi.fn().mockReturnValue(pending.promise);
      let changed!: (event: ExtensionChangedEvent) => void;
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          extensions: {
            list: vi.fn(async () => ({ success: true, extensions: inventory })),
            updateConfiguration,
            onChanged: vi.fn((listener: typeof changed) => {
              changed = listener;
              return vi.fn();
            }),
          },
        },
      });
      render(<ExtensionsManager />);
      fireEvent.click(await screen.findByRole('button', { name: 'subtaskShowInfo: First plugin' }));
      fireEvent.change(screen.getByLabelText('First plugin credential'), {
        target: { value: 'first-value' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'save' }));
      await waitFor(() => expect(updateConfiguration).toHaveBeenCalledOnce());
      inventory = [second];
      await act(async () => changed({ extensionId: first.id, enabled: false }));
      expect(screen.queryByLabelText('First plugin credential')).toBeNull();
      const target = sameId ? first : second;
      if (sameId) {
        inventory = [first, second];
        await act(async () => changed({ extensionId: first.id, enabled: true }));
      }
      fireEvent.click(screen.getByRole('button', { name: `subtaskShowInfo: ${target.name}` }));
      const draft = screen.getByLabelText(`${target.name} credential`) as HTMLInputElement;
      fireEvent.change(draft, { target: { value: 'new-detail-draft' } });

      await act(async () =>
        pending.resolve({ success, pending: true, error: 'Stale configuration error' }),
      );

      expect(draft.value).toBe('new-detail-draft');
      expect(screen.queryByText('extensionConfigurationSaved')).toBeNull();
      expect(screen.queryByText('Stale configuration error')).toBeNull();
      expect(updateConfiguration).toHaveBeenCalledExactlyOnceWith(
        { extensionId: first.id, values: { apiKey: 'first-value' } },
        { requestId: expect.any(String) },
      );
    },
  );

  test('confirms deletion without relabeling the removed extension unavailable', async () => {
    let installed = true;
    const deleteExtension = vi.fn(async () => {
      installed = false;
      return { success: true };
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({ success: true, extensions: installed ? [extension] : [] })),
          delete: deleteExtension,
          onChanged: vi.fn(() => () => undefined),
        },
      },
    });
    render(<ExtensionsManager />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'subtaskShowInfo: Sample Extension' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'extensionDelete' }));
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));

    await screen.findByText('Extension "Sample Extension" deleted');
    await waitFor(() => expect(screen.queryByText('Sample Extension')).toBeNull());
    expect(screen.queryByText('extensionDeleteFailed')).toBeNull();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
    expect(deleteExtension).toHaveBeenCalledWith(
      { extensionId: extension.id },
      { requestId: expect.any(String) },
    );
  });

  test.each([true, false])(
    'shows deletion progress until the operation ends (success: %s)',
    async success => {
      const reply = deferred<{ success: boolean; error?: string }>();
      let installed = true;
      const deleteExtension = vi.fn(() => reply.promise);
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          extensions: {
            list: vi.fn(async () => ({ success: true, extensions: installed ? [extension] : [] })),
            delete: deleteExtension,
            onChanged: vi.fn(() => vi.fn()),
          },
        },
      });
      render(
        <>
          <ExtensionsManager />
          <PluginOperationFeedback />
        </>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'subtaskShowInfo: Sample Extension' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'extensionDelete' }));
      fireEvent.click(screen.getByRole('button', { name: 'delete' }));

      const deleting = screen.getByRole('button', { name: 'extensionDeleting' });
      expect(deleting.getAttribute('aria-busy')).toBe('true');
      expect(deleting.hasAttribute('disabled')).toBe(true);
      expect(deleting.querySelector('.animate-spin')).toBeTruthy();
      expect(screen.getByRole('status').textContent).toBe('extensionDeleting');
      expect(screen.getByRole('button', { name: 'cancel' }).hasAttribute('disabled')).toBe(true);
      fireEvent.click(deleting);
      expect(deleteExtension).toHaveBeenCalledExactlyOnceWith(
        { extensionId: extension.id },
        { requestId: expect.any(String) },
      );

      await act(async () => {
        installed = !success;
        reply.resolve({ success, error: success ? undefined : 'Delete refused' });
      });

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'extensionDeleting' })).toBeNull(),
      );
      expect(screen.queryByText('extensionDeleting')).toBeNull();
      if (success) {
        expect(screen.getByText('Extension "Sample Extension" deleted')).toBeTruthy();
      } else {
        expect(screen.getByText('Delete refused')).toBeTruthy();
        const retry = screen.getByRole('button', { name: 'delete' });
        expect(retry.getAttribute('aria-busy')).toBeNull();
        expect(retry.hasAttribute('disabled')).toBe(false);
        expect(retry.querySelector('.animate-spin')).toBeNull();
      }
    },
  );

  test.each([false, true])(
    'exposes Agent Team records and settings only with enabled=%s',
    async enabled => {
      const setEnabled = vi.fn();
      const received = vi.fn();
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          extensions: {
            list: vi.fn(async () => ({
              success: true,
              extensions: [{ ...extension, id: 'agent-team', name: 'Agent Team', enabled }],
            })),
            setEnabled,
            onChanged: vi.fn(() => vi.fn()),
          },
        },
      });
      window.addEventListener(OPEN_TEAM_RECORDS, received);
      try {
        render(<ExtensionsManager />);
        await screen.findByText('Agent Team');
        if (!enabled) {
          expect(screen.queryByRole('button', { name: 'teamAllRecords' })).toBeNull();
          expect(screen.queryByRole('button', { name: 'agentTeamSettings' })).toBeNull();
          expect(received).not.toHaveBeenCalled();
          expect(setEnabled).not.toHaveBeenCalled();
          return;
        }
        expect(screen.getByRole('button', { name: 'agentTeamSettings' })).toBeTruthy();
        fireEvent.click(await screen.findByRole('button', { name: 'teamAllRecords' }));
        expect(received).toHaveBeenCalledTimes(1);
        expect(received.mock.calls[0][0].detail).toBe(document);
        expect(setEnabled).not.toHaveBeenCalled();
        expect(screen.queryByRole('heading', { name: 'Agent Team', level: 2 })).toBeNull();
      } finally {
        window.removeEventListener(OPEN_TEAM_RECORDS, received);
      }
    },
  );

  test('opens Agent Team records from details after closing the details dialog', async () => {
    const received = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [{ ...extension, id: 'agent-team', name: 'Agent Team', enabled: true }],
          })),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    window.addEventListener(OPEN_TEAM_RECORDS, received);
    try {
      render(<ExtensionsManager requestedExtensionId="agent-team" />);
      await screen.findByRole('heading', { name: 'Agent Team', level: 2 });
      const history = screen.getAllByRole('button', { name: 'teamAllRecords' });
      fireEvent.click(history.find(button => button.textContent === 'teamAllRecords')!);
      expect(received).toHaveBeenCalledTimes(1);
      expect(received.mock.calls[0][0].detail).toBe(document);
      expect(screen.queryByRole('heading', { name: 'Agent Team', level: 2 })).toBeNull();
    } finally {
      window.removeEventListener(OPEN_TEAM_RECORDS, received);
    }
  });

  test('hides disabled Agent Team actions in its details', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [{ ...extension, id: 'agent-team', name: 'Agent Team', enabled: false }],
          })),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    render(<ExtensionsManager requestedExtensionId="agent-team" />);
    await screen.findByRole('heading', { name: 'Agent Team', level: 2 });
    expect(screen.queryByRole('button', { name: 'teamAllRecords' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'agentTeamSettings' })).toBeNull();
  });

  test('closes Team settings immediately on disable and does not reopen them on enable', async () => {
    let changed!: (event: ExtensionChangedEvent) => void;
    const disabledRead = deferred<{ success: boolean; extensions: InstalledOpenClawExtension[] }>();
    const team = { ...extension, id: 'agent-team', name: 'Agent Team', enabled: true };
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: true, extensions: [team] })
      .mockReturnValueOnce(disabledRead.promise)
      .mockResolvedValue({ success: true, extensions: [team] });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list,
          onChanged: (listener: typeof changed) => {
            changed = listener;
            return vi.fn();
          },
        },
        agentTeamSettings: {
          read: vi.fn(async () => ({
            success: true,
            value: { version: 1, revision: 0, value: defaultAgentTeamSettings() },
          })),
        },
      },
    });
    render(<ExtensionsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'agentTeamSettings' }));
    await screen.findByRole('dialog');
    act(() => changed({ extensionId: team.id, enabled: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'teamAllRecords' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'agentTeamSettings' })).toBeNull();
    await act(async () => changed({ extensionId: team.id, enabled: true }));
    await act(async () =>
      disabledRead.resolve({ success: true, extensions: [{ ...team, enabled: false }] }),
    );
    expect(screen.getByRole('button', { name: 'teamAllRecords' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'agentTeamSettings' }));
    await screen.findByRole('dialog');
    await act(async () => {
      changed({ extensionId: team.id, enabled: false });
      changed({ extensionId: team.id, enabled: true });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('animates toward the requested state while the change is being applied', async () => {
    let enabled = false;
    const request = deferred<ExtensionSetEnabledResult>();
    const setEnabled = vi.fn(
      async ({
        enabled: nextEnabled,
      }: {
        enabled: boolean;
      }): Promise<ExtensionSetEnabledResult> => {
        const result = await request.promise;
        if (result.success) enabled = nextEnabled;
        return result;
      },
    );
    const list = vi.fn(async () => ({
      success: true,
      extensions: [{ ...extension, enabled }],
    }));

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list,
          setEnabled,
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    render(<ExtensionsManager />);

    const toggle = await screen.findByRole('switch', { name: 'extensionEnable' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith(
        {
          extensionId: extension.id,
          enabled: true,
        },
        { requestId: expect.any(String) },
      ),
    );
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-busy')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('extensionEnable · pluginStatusApplying');
    expect(toggle.querySelector('.animate-spin')).toBeTruthy();

    await act(async () => {
      request.resolve({ success: true });
      await request.promise;
    });

    await waitFor(() => expect(toggle.getAttribute('aria-busy')).toBeNull());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('extensionDisable');
    expect(toggle.querySelector('.animate-shimmer')).toBeNull();
    expect(toggle.querySelector('.animate-spin')).toBeNull();
  });

  test('shows policy locks without fake switches or unavailable delete actions', async () => {
    const systemExtension: InstalledOpenClawExtension = {
      ...extension,
      id: 'managed-extension',
      name: 'Managed Extension',
      installPath: undefined,
      managed: true,
      origin: 'local',
      canToggle: false,
      removable: false,
    };
    const bundledExtension: InstalledOpenClawExtension = {
      ...extension,
      id: 'bundled-extension',
      name: 'Bundled Extension',
      installPath: undefined,
      origin: 'bundled',
      canToggle: true,
      removable: false,
    };
    const openPath = vi.fn(async () => ({ success: true }));

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [extension, systemExtension, bundledExtension],
          })),
          setEnabled: vi.fn(async () => ({ success: true })),
          onChanged: vi.fn(() => vi.fn()),
        },
        shell: { openPath },
      },
    });

    render(<ExtensionsManager />);

    expect(await screen.findByText('extensionGroup.system.label')).toBeTruthy();
    expect(screen.getByText('extensionGroup.user.label')).toBeTruthy();
    expect(screen.queryByText('extensionInstalled')).toBeNull();
    expect(screen.getByRole('button', { name: 'importExtension' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'pluginGroupExpand' }));
    expect(
      screen.getByRole('img', { name: 'pluginStatusDisabled · extensionManagedApplication' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'extensionFolderUnavailable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'openFolder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'extensionDeleteUnavailable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'extensionDelete' })).toBeNull();

    const enabledSwitches = screen.getAllByRole('switch', { name: 'extensionEnable' });
    expect(enabledSwitches).toHaveLength(2);
    expect(enabledSwitches.every(control => !control.hasAttribute('disabled'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: Sample Extension' }));
    expect(screen.getByRole('button', { name: 'extensionDelete' }).textContent).toBe('');
    const openFolderButton = screen.getByRole('button', { name: 'openFolder' });
    expect(openFolderButton.textContent).toBe('');
    fireEvent.click(openFolderButton);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('C:\\extensions\\sample-extension'));
  });

  test.each([false, true])(
    'locks computer control without offering a toggle when enabled=%s',
    async enabled => {
      const computerExtension: InstalledOpenClawExtension = {
        ...extension,
        id: 'cua-computer',
        name: 'Computer',
        enabled,
        origin: 'bundled',
        managed: true,
        canToggle: false,
        removable: false,
        ...getExtensionManagement({ managed: true }),
      };
      const setEnabled = vi.fn();
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          extensions: {
            list: vi.fn(async () => ({ success: true, extensions: [computerExtension] })),
            setEnabled,
            onChanged: vi.fn(() => vi.fn()),
          },
        },
      });
      render(<ExtensionsManager searchQuery="Computer" />);
      const lock = await screen.findByRole('img', {
        name: `${enabled ? 'pluginStatusEnabled' : 'pluginStatusDisabled'} · extensionManagedComputer`,
      });
      expect(lock.className).toContain(enabled ? 'text-emerald-600' : 'text-amber-600');
      expect(screen.queryByRole('switch')).toBeNull();
      fireEvent.click(lock);
      expect(setEnabled).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'extensionDelete' })).toBeNull();
    },
  );

  test('opens a requested provider extension after the inventory loads', async () => {
    const onRequestedExtensionHandled = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({ success: true, extensions: [extension] })),
          setEnabled: vi.fn(async () => ({ success: true })),
          onChanged: vi.fn(() => vi.fn()),
        },
        shell: { openPath: vi.fn(async () => ({ success: true })) },
      },
    });

    render(
      <ExtensionsManager
        requestedExtensionId="sample-extension"
        onRequestedExtensionHandled={onRequestedExtensionHandled}
      />,
    );

    await waitFor(() => expect(onRequestedExtensionHandled).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'openFolder' })).toBeTruthy();
  });

  test.each([
    ['openai', 'extensionManagedModelAdapter'],
    ['code-mode-quickjs', 'extensionManagedCodeMode'],
    ['typesafe', 'extensionManagedDecisionModels'],
  ])('explains where managed %s is controlled in the card and details', async (id, label) => {
    const managedExtension: InstalledOpenClawExtension = {
      ...extension,
      id,
      name: id,
      enabled: true,
      managed: true,
      origin: 'bundled',
      ...getExtensionManagement({ managed: true, installPath: extension.installPath }),
    };
    const setEnabled = vi.fn();
    const openPath = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({ success: true, extensions: [managedExtension] })),
          setEnabled,
          onChanged: vi.fn(() => vi.fn()),
        },
        shell: { openPath },
      },
    });

    render(<ExtensionsManager searchQuery={id} />);

    expect(await screen.findByRole('img', { name: `pluginStatusEnabled · ${label}` })).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `subtaskShowInfo: ${id}` }));
    expect(screen.getByText(label)).toBeTruthy();
    const openFolder = screen.getByRole('button', { name: 'openFolder' });
    expect(openFolder.textContent).toBe('');
    fireEvent.click(openFolder);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(extension.installPath));
    expect(setEnabled).not.toHaveBeenCalled();
  });

  test('keeps the disabled shared OpenAI adapter locked and explains Settings ownership', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [
              {
                ...extension,
                id: 'openai',
                enabled: false,
                managed: true,
                origin: 'bundled',
                ...getExtensionManagement({ managed: true }),
              },
            ],
          })),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    render(<ExtensionsManager searchQuery="openai" />);

    expect(
      await screen.findByRole('img', {
        name: 'pluginStatusDisabled · extensionManagedModelAdapter',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: Sample Extension' }));
    expect(screen.getByText('extensionManagedModelAdapter')).toBeTruthy();
  });

  test('saves a bundled Jev key without enabling the extension or retaining it in the input', async () => {
    const typesafe: InstalledOpenClawExtension = {
      ...extension,
      id: 'typesafe',
      name: 'TypeSafe AI',
      origin: 'bundled',
      installPath: undefined,
      removable: false,
      configurationFields: [
        {
          path: 'apiKey',
          label: 'TypeSafe API credential',
          type: 'string',
          sensitive: true,
          configured: false,
          value: 'synthetic-projection-secret',
          defaultValue: 'synthetic-default-secret',
        },
        {
          path: 'baseUrl',
          label: 'Local origin',
          type: 'string',
          sensitive: false,
          configured: false,
          defaultValue: 'http://127.0.0.1:8009',
        },
        {
          path: 'serviceUrl',
          label: 'Service URL',
          type: 'string',
          sensitive: false,
          configured: true,
          value: 'https://intranet.example/v1',
        },
      ],
    };
    const updateConfiguration = vi.fn().mockResolvedValue({ success: true });
    const setEnabled = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({ success: true, extensions: [typesafe] })),
          updateConfiguration,
          setEnabled,
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    render(<ExtensionsManager requestedExtensionId="typesafe" />);
    const input = (await screen.findByLabelText('TypeSafe API credential')) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect((screen.getByLabelText('Local origin') as HTMLInputElement).value).toBe(
      'http://127.0.0.1:8009',
    );
    fireEvent.change(input, { target: { value: 'synthetic-ui-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(updateConfiguration).toHaveBeenCalledWith(
        {
          extensionId: 'typesafe',
          values: { apiKey: 'synthetic-ui-key' },
        },
        { requestId: expect.any(String) },
      ),
    );
    await waitFor(() => expect(input.value).toBe(''));
    expect(setEnabled).not.toHaveBeenCalled();
  });

  test('edits mixed configuration fields, reloads saved text and clears only an edited text override', async () => {
    let serviceUrl: string | undefined = 'https://intranet.example/v1';
    let concurrency = 2;
    let credentialConfigured = false;
    const configuredExtension = (): InstalledOpenClawExtension => ({
      ...extension,
      configurationFields: [
        {
          path: 'serviceUrl',
          label: 'Service URL',
          type: 'string',
          sensitive: false,
          configured: Boolean(serviceUrl),
          value: serviceUrl,
          minLength: 1,
          maxLength: 2048,
        },
        {
          path: 'apiKey',
          label: 'API credential',
          sensitive: true,
          configured: credentialConfigured,
        },
        {
          path: 'concurrency',
          label: 'Concurrency',
          type: 'integer',
          sensitive: false,
          configured: true,
          value: concurrency,
          defaultValue: 3,
          minimum: 1,
          maximum: 4,
        },
      ],
    });
    const updateConfiguration = vi.fn(async ({ values }: { values: Record<string, string> }) => {
      if (Object.prototype.hasOwnProperty.call(values, 'serviceUrl')) serviceUrl = values.serviceUrl || undefined;
      if (values.concurrency) concurrency = Number(values.concurrency);
      if (values.apiKey) credentialConfigured = true;
      return { success: true };
    });
    const setEnabled = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({ success: true, extensions: [configuredExtension()] })),
          updateConfiguration,
          setEnabled,
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    render(<ExtensionsManager requestedExtensionId={extension.id} />);
    let urlInput = (await screen.findByLabelText('Service URL')) as HTMLInputElement;
    const credentialInput = screen.getByLabelText('API credential') as HTMLInputElement;
    const numberInput = screen.getByLabelText('Concurrency') as HTMLInputElement;
    expect(urlInput.type).toBe('text');
    expect(urlInput.value).toBe(serviceUrl);
    // HTML length limits count UTF-16 units; schema limits count Unicode code points in Main.
    expect(urlInput.hasAttribute('minlength')).toBe(false);
    expect(urlInput.hasAttribute('maxlength')).toBe(false);
    expect(credentialInput.type).toBe('password');
    expect(credentialInput.value).toBe('');
    expect(numberInput.type).toBe('number');
    expect(numberInput.value).toBe('2');
    expect(numberInput.min).toBe('1');
    expect(numberInput.max).toBe('4');
    expect(numberInput.step).toBe('1');

    fireEvent.change(urlInput, { target: { value: 'http://model.internal:8080/v1' } });
    fireEvent.change(credentialInput, { target: { value: 'synthetic-ui-key' } });
    fireEvent.change(numberInput, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(updateConfiguration).toHaveBeenNthCalledWith(
      1,
      {
        extensionId: extension.id,
        values: {
          serviceUrl: 'http://model.internal:8080/v1',
          apiKey: 'synthetic-ui-key',
          concurrency: '4',
        },
      },
      { requestId: expect.any(String) },
    ));
    await waitFor(() => expect(credentialInput.value).toBe(''));
    expect(urlInput.value).toBe('http://model.internal:8080/v1');
    expect(numberInput.value).toBe('4');
    expect(screen.getByRole('status').textContent).toBe('extensionConfigurationSaved');
    expect(setEnabled).not.toHaveBeenCalled();

    fireEvent.change(urlInput, { target: { value: 'https://unsaved.internal/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: Sample Extension' }));
    urlInput = screen.getByLabelText('Service URL') as HTMLInputElement;
    expect(urlInput.value).toBe('http://model.internal:8080/v1');
    expect((screen.getByLabelText('API credential') as HTMLInputElement).value).toBe('');

    fireEvent.change(urlInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(updateConfiguration).toHaveBeenNthCalledWith(
      2,
      { extensionId: extension.id, values: { serviceUrl: '', concurrency: '4' } },
      { requestId: expect.any(String) },
    ));
    await screen.findByRole('status');
    expect(urlInput.value).toBe('');
    expect((screen.getByLabelText('API credential') as HTMLInputElement).placeholder).toBe(
      'extensionConfigurationStored',
    );
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: Sample Extension' }));
    expect((screen.getByLabelText('Service URL') as HTMLInputElement).value).toBe('');
  });

  test('does not offer configuration controls blocked by management policy', async () => {
    const managedExtension: InstalledOpenClawExtension = {
      ...extension,
      id: 'managed-configurable',
      name: 'Managed Configurable',
      managed: true,
      configurationFields: [
        {
          path: 'service.token',
          label: 'Token',
          sensitive: true,
          configured: false,
        },
        {
          path: 'serviceUrl',
          label: 'Service URL',
          type: 'string',
          sensitive: false,
          configured: true,
          value: 'https://managed.internal/v1',
        },
      ],
      ...getExtensionManagement({
        managed: true,
        installPath: extension.installPath,
        configurationFieldCount: 2,
      }),
    };
    const updateConfiguration = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({ success: true, extensions: [managedExtension] })),
          updateConfiguration,
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    render(<ExtensionsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'pluginGroupExpand' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'subtaskShowInfo: Managed Configurable' }),
    );

    expect(screen.getByText('extensionManagedApplication')).toBeTruthy();
    expect(screen.queryByLabelText('Token')).toBeNull();
    expect(screen.queryByLabelText('Service URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
    expect(updateConfiguration).not.toHaveBeenCalled();
  });

  test('refreshes card and open detail permissions after returning from decision model settings', async () => {
    let managed = true;
    const list = vi.fn(async () => ({
      success: true,
      extensions: [{
        ...extension,
        id: 'typesafe',
        name: 'TypeSafe AI',
        enabled: true,
        origin: 'bundled',
        managed,
        canToggle: !managed,
        configurationFields: [{
          path: 'serviceUrl',
          label: 'Service URL',
          type: 'string' as const,
          sensitive: false,
          configured: true,
          value: 'http://inference.corp/v1',
        }],
        ...getExtensionManagement({ managed, canToggle: !managed, configurationFieldCount: 1 }),
      }],
    }));
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list,
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    const props = { requestedExtensionId: 'typesafe', searchQuery: 'TypeSafe' };
    const view = render(<ExtensionsManager {...props} isActive />);
    const lockName = 'pluginStatusEnabled · extensionManagedDecisionModels';
    await screen.findByRole('img', { name: lockName });
    expect(screen.getByText('extensionManagedDecisionModels')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText('Service URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
    expect(list).toHaveBeenCalledOnce();

    view.rerender(<ExtensionsManager {...props} isActive={false} />);
    expect(list).toHaveBeenCalledOnce();
    managed = false;
    view.rerender(<ExtensionsManager {...props} isActive />);

    await screen.findByRole('switch', { name: 'extensionDisable' });
    expect((screen.getByLabelText('Service URL') as HTMLInputElement).value).toBe(
      'http://inference.corp/v1',
    );
    expect(screen.getByRole('button', { name: 'save' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: lockName })).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);

    view.rerender(<ExtensionsManager {...props} isActive={false} />);
    managed = true;
    view.rerender(<ExtensionsManager {...props} isActive />);

    await screen.findByRole('img', { name: lockName });
    expect(screen.getByText('extensionManagedDecisionModels')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText('Service URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
    expect(list).toHaveBeenCalledTimes(3);
    view.rerender(<ExtensionsManager {...props} isActive />);
    expect(list).toHaveBeenCalledTimes(3);
  });

  test('shows a warning tooltip and opens the credential editor from the warning', async () => {
    let configured = false;
    const updateConfiguration = vi.fn(async () => {
      configured = true;
      return { success: true };
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [
              {
                ...extension,
                missingRequirements: configured ? [] : ['EXAMPLE_KEY', 'EXAMPLE_ALIAS'],
                configurationFields: [
                  {
                    path: 'env.vars.EXAMPLE_KEY',
                    label: 'EXAMPLE_KEY',
                    requirement: 'EXAMPLE_KEY',
                    environmentVariables: ['EXAMPLE_KEY', 'EXAMPLE_ALIAS'],
                    configuredEnvironmentVariables: configured ? ['EXAMPLE_ALIAS'] : [],
                    sensitive: true,
                    configured,
                  },
                ],
              },
            ],
          })),
          updateConfiguration,
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    render(<ExtensionsManager />);
    const warning = await screen.findByRole('button', { name: 'extensionMissingConfiguration' });
    // The card suppresses pointer events; the tooltip anchor must explicitly restore them.
    expect(warning.parentElement?.classList.contains('pointer-events-auto')).toBe(true);
    fireEvent.mouseEnter(warning.parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveProperty(
      'textContent',
      'extensionMissingConfiguration',
    );
    fireEvent.mouseLeave(warning.parentElement!);
    fireEvent.click(warning);
    const input = screen.getByLabelText('EXAMPLE_KEY') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.placeholder).toBe('extensionConfigurationEnterSecret');
    expect(screen.getByText('extensionMissingConfiguration')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'unsaved-first-credential' } });
    fireEvent.change(
      screen.getByRole('combobox', { name: 'extensionConfigurationCredentialType' }),
      {
        target: { value: 'EXAMPLE_ALIAS' },
      },
    );
    expect(input.value).toBe('');
    expect(screen.getByLabelText('EXAMPLE_ALIAS')).toBe(input);
    fireEvent.change(input, { target: { value: 'synthetic-ui-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(updateConfiguration).toHaveBeenCalledWith(
        {
          extensionId: extension.id,
          values: { 'env.vars.EXAMPLE_ALIAS': 'synthetic-ui-secret' },
        },
        { requestId: expect.any(String) },
      ),
    );
    await waitFor(() => expect(input.value).toBe(''));
    expect(input.placeholder).toBe('extensionConfigurationStored');
    expect(input.required).toBe(false);
    expect(screen.queryByRole('button', { name: 'extensionMissingConfiguration' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('extensionConfigurationSaved');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: `subtaskShowInfo: ${extension.name}` }));
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('EXAMPLE_ALIAS');
    expect((screen.getByLabelText('EXAMPLE_ALIAS') as HTMLInputElement).placeholder).toBe(
      'extensionConfigurationStored',
    );
  });

  test('explains inherited credentials and permits selecting an editable alternative', async () => {
    const updateConfiguration = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [
              {
                ...extension,
                configurationFields: [
                  {
                    path: 'env.vars.EXAMPLE_KEY',
                    label: 'EXAMPLE_KEY',
                    sensitive: true,
                    configured: true,
                    environmentVariables: ['EXAMPLE_KEY', 'EXAMPLE_ALIAS'],
                    configuredEnvironmentVariables: ['EXAMPLE_KEY'],
                    inheritedEnvironmentVariables: ['EXAMPLE_KEY'],
                  },
                ],
              },
            ],
          })),
          updateConfiguration,
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    render(<ExtensionsManager requestedExtensionId={extension.id} />);
    const input = (await screen.findByLabelText('EXAMPLE_KEY')) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('extensionConfigurationInherited');
    expect(screen.getByText('extensionConfigurationInheritedHelp')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'EXAMPLE_ALIAS' } });
    expect(input.disabled).toBe(false);
    expect(screen.queryByText('extensionConfigurationInheritedHelp')).toBeNull();
    expect(screen.getByText('extensionConfigurationInheritedAlternatives')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'synthetic-alias-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(updateConfiguration).toHaveBeenCalledWith(
        {
          extensionId: extension.id,
          values: { 'env.vars.EXAMPLE_ALIAS': 'synthetic-alias-key' },
        },
        { requestId: expect.any(String) },
      ),
    );
  });

  test('shows native setup-required state even without environment requirements', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [{ ...extension, state: 'needs-setup' }],
          })),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    render(<ExtensionsManager />);
    const warning = await screen.findByRole('button', { name: 'extensionMissingConfiguration' });
    fireEvent.click(warning);
    expect(screen.getByText('extensionMissingConfiguration')).toBeTruthy();
  });

  test('exposes extension errors on keyboard focus and in the details dialog', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [{ ...extension, error: 'Plugin failed to load' }],
          })),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    render(<ExtensionsManager />);
    const warning = await screen.findByRole('button', { name: 'Plugin failed to load' });
    fireEvent.focus(warning);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Plugin failed to load');
    fireEvent.blur(warning);
    fireEvent.click(warning);
    expect(screen.getByRole('alert').textContent).toBe('Plugin failed to load');
  });

  test('continues a batch after the reviewed extension fails to install', async () => {
    const importPath = vi
      .fn<
        ({
          sourcePath,
        }: {
          sourcePath: string;
          reviewToken?: string;
        }) => Promise<ExtensionImportResult>
      >()
      .mockResolvedValueOnce({ success: false, capabilityReview })
      .mockResolvedValueOnce({ success: false, error: 'first failed' })
      .mockResolvedValueOnce({ success: true, extensionId: 'second-extension' });

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({ success: true, extensions: [] })),
          importPath,
          onChanged: vi.fn(() => vi.fn()),
        },
        dialog: {
          selectFolders: vi.fn(async () => ({
            success: true,
            paths: ['C:\\extensions\\first', 'C:\\extensions\\second'],
          })),
        },
      },
    });

    render(<ExtensionsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'importExtension' }));
    fireEvent.click(await screen.findByRole('button', { name: /selectExtensionFolders/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'extensionCapabilityAccept' }));

    await waitFor(() => expect(importPath).toHaveBeenCalledTimes(3));
    expect(importPath).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ sourcePath: 'C:\\extensions\\second' }),
      { requestId: expect.any(String) },
    );
  });
});

test('retains an earlier refresh warning when a later capability review is cancelled', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: {
        list: vi.fn().mockResolvedValue({ success: true, extensions: [] }),
        importPath: vi
          .fn()
          .mockResolvedValueOnce({
            success: true,
            extensionId: 'installed-first',
            refreshWarning: true,
          })
          .mockResolvedValueOnce({ success: false, capabilityReview }),
        onChanged: () => () => undefined,
      },
      dialog: {
        selectFolders: vi
          .fn()
          .mockResolvedValue({ success: true, paths: ['C:/imports/first', 'C:/imports/second'] }),
      },
    },
  });
  render(<ExtensionsManager />);
  fireEvent.click(await screen.findByRole('button', { name: 'importExtension' }));
  fireEvent.click(
    screen.getByRole('button', {
      name: /selectExtensionFolders selectExtensionFoldersDescription/,
    }),
  );
  await screen.findByText('extensionCapabilityReviewTitle');
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({
      state: 'refresh_failed',
      items: [expect.objectContaining({ label: 'installed-first', type: 'success' })],
    }),
  ]);
  cleanup();
});
