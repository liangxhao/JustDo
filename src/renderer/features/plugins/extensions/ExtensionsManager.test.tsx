// @vitest-environment jsdom

import type {
  ExtensionImportResult,
  ExtensionSetEnabledResult,
  InstalledOpenClawExtension,
  OpenClawPluginCapabilityReview,
} from '@shared/plugins/extensions';
import { getExtensionManagement } from '@shared/plugins/management';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OPEN_TEAM_RECORDS } from '@/features/cowork/components/display/agentTeamHistory';

import ExtensionsManager from './ExtensionsManager';

vi.mock('@/features/plugins/marketplace/MarketplaceView', () => ({
  default: ({ onInstalled }: { onInstalled: () => Promise<void> }) => (
    <button onClick={() => void onInstalled()}>finishMarketplaceInstall</button>
  ),
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'extensionDeleteSuccess' ? 'Extension "{name}" deleted' : key),
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
            onImportProgress: vi.fn(() => vi.fn()),
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
    let changed!: () => void;
    const stop = vi.fn();
    const onChanged = vi.fn((listener: () => void) => {
      changed = listener;
      return stop;
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { extensions: { list, onChanged, onImportProgress: vi.fn(() => vi.fn()) } },
    });
    const view = render(<ExtensionsManager />);
    await screen.findByRole('switch', { name: 'extensionEnable' });
    expect(onChanged).toHaveBeenCalledOnce();

    await act(async () => {
      changed();
      changed();
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
    changed();
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
    let changed!: () => void;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list,
          updateConfiguration: vi.fn().mockResolvedValue({ success: true }),
          onChanged: vi.fn((listener: () => void) => {
            changed = listener;
            return vi.fn();
          }),
          onImportProgress: vi.fn(() => vi.fn()),
        },
      },
    });
    render(<ExtensionsManager requestedExtensionId={extension.id} />);
    const input = (await screen.findByLabelText('Sample credential')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'synthetic-ui-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => changed());

    await act(async () => {
      oldRead.resolve({ success: true, extensions: [configured(false)] });
      await oldRead.promise;
    });

    await waitFor(() => expect(input.placeholder).toBe('extensionConfigurationStored'));
    expect(input.value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('extensionConfigurationSaved');
    expect(list).toHaveBeenCalledTimes(3);
  });

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
          onImportProgress: vi.fn(() => () => undefined),
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
    expect(deleteExtension).toHaveBeenCalledWith({ extensionId: extension.id });
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
            onImportProgress: vi.fn(() => vi.fn()),
          },
        },
      });
      render(<ExtensionsManager />);
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
      expect(deleteExtension).toHaveBeenCalledExactlyOnceWith({ extensionId: extension.id });

      await act(async () => {
        installed = !success;
        reply.resolve({ success, error: success ? undefined : 'Delete refused' });
      });

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'extensionDeleting' })).toBeNull(),
      );
      expect(screen.queryByRole('status')).toBeNull();
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
    'opens Agent Team records from its card with enabled=%s without toggling the plugin',
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
            onImportProgress: vi.fn(() => vi.fn()),
          },
        },
      });
      window.addEventListener(OPEN_TEAM_RECORDS, received);
      try {
        render(<ExtensionsManager />);
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
            extensions: [{ ...extension, id: 'agent-team', name: 'Agent Team' }],
          })),
          onChanged: vi.fn(() => vi.fn()),
          onImportProgress: vi.fn(() => vi.fn()),
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
          onImportProgress: vi.fn(() => vi.fn()),
        },
      },
    });

    render(<ExtensionsManager />);

    const toggle = await screen.findByRole('switch', { name: 'extensionEnable' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith({
        extensionId: extension.id,
        enabled: true,
      }),
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
          onImportProgress: vi.fn(() => vi.fn()),
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
            onImportProgress: vi.fn(() => vi.fn()),
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
          onImportProgress: vi.fn(() => vi.fn()),
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
    ['video-openai', 'extensionManagedVideoModels'],
  ])('explains where managed %s is controlled in the card and details', async (id, label) => {
    const managedExtension: InstalledOpenClawExtension = {
      ...extension,
      id,
      name: id,
      enabled: true,
      managed: true,
      origin: 'bundled',
      ...getExtensionManagement({ managed: true }),
    };
    const setEnabled = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({ success: true, extensions: [managedExtension] })),
          setEnabled,
          onChanged: vi.fn(() => vi.fn()),
          onImportProgress: vi.fn(() => vi.fn()),
        },
      },
    });

    render(<ExtensionsManager searchQuery={id} />);

    expect(await screen.findByRole('img', { name: `pluginStatusEnabled · ${label}` })).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `subtaskShowInfo: ${id}` }));
    expect(screen.getByText(label)).toBeTruthy();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  test('keeps the disabled video adapter locked and explains Settings ownership', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        extensions: {
          list: vi.fn(async () => ({
            success: true,
            extensions: [
              {
                ...extension,
                id: 'video-openai',
                enabled: false,
                managed: true,
                origin: 'bundled',
                ...getExtensionManagement({ managed: true }),
              },
            ],
          })),
          onChanged: vi.fn(() => vi.fn()),
          onImportProgress: vi.fn(() => vi.fn()),
        },
      },
    });

    render(<ExtensionsManager searchQuery="video-openai" />);

    expect(
      await screen.findByRole('img', {
        name: 'pluginStatusDisabled · extensionManagedVideoModels',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: Sample Extension' }));
    expect(screen.getByText('extensionManagedVideoModels')).toBeTruthy();
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
        { path: 'apiKey', label: 'TypeSafe API credential', sensitive: true, configured: false },
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
          onImportProgress: vi.fn(() => vi.fn()),
        },
      },
    });
    render(<ExtensionsManager requestedExtensionId="typesafe" />);
    const input = (await screen.findByLabelText('TypeSafe API credential')) as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'synthetic-ui-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(updateConfiguration).toHaveBeenCalledWith({
        extensionId: 'typesafe',
        values: { apiKey: 'synthetic-ui-key' },
      }),
    );
    await waitFor(() => expect(input.value).toBe(''));
    expect(setEnabled).not.toHaveBeenCalled();
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
      ],
      ...getExtensionManagement({
        managed: true,
        installPath: extension.installPath,
        configurationFieldCount: 1,
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
          onImportProgress: vi.fn(() => vi.fn()),
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
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
    expect(updateConfiguration).not.toHaveBeenCalled();
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
          onImportProgress: vi.fn(() => vi.fn()),
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
      expect(updateConfiguration).toHaveBeenCalledWith({
        extensionId: extension.id,
        values: { 'env.vars.EXAMPLE_ALIAS': 'synthetic-ui-secret' },
      }),
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
          onImportProgress: vi.fn(() => vi.fn()),
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
      expect(updateConfiguration).toHaveBeenCalledWith({
        extensionId: extension.id,
        values: { 'env.vars.EXAMPLE_ALIAS': 'synthetic-alias-key' },
      }),
    );
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
          onImportProgress: vi.fn(() => vi.fn()),
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
          onImportProgress: vi.fn(() => vi.fn()),
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
    );
  });
});
