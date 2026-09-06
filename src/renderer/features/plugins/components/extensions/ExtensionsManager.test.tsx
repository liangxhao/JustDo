// @vitest-environment jsdom

import type {
  ExtensionImportResult,
  ExtensionSetEnabledResult,
  InstalledOpenClawExtension,
  OpenClawPluginCapabilityReview,
} from '@shared/openclaw/extensions';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import ExtensionsManager from './ExtensionsManager';

vi.mock('@/features/plugins/components/marketplace/MarketplaceView', () => ({
  default: () => null,
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
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

  test('animates toward the requested state while the gateway restart is pending', async () => {
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
    expect(toggle.getAttribute('aria-label')).toBe(
      'extensionEnable · extensionImportStageRestartingGateway',
    );
    expect(toggle.querySelector('.animate-shimmer')).toBeTruthy();
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

  test('keeps a stable action row while respecting OpenClaw ownership flags', async () => {
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
          onImportProgress: vi.fn(() => vi.fn()),
        },
        shell: { openPath },
      },
    });

    render(<ExtensionsManager />);

    expect(await screen.findByText('extensionGroup.system.label')).toBeTruthy();
    expect(screen.getByText('extensionGroup.user.label')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('switch', { name: 'extensionToggleUnavailable' })
        .disabled,
    ).toBe(true);
    expect(screen.getAllByRole('button', { name: 'extensionFolderUnavailable' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'extensionDeleteUnavailable' })).toHaveLength(2);

    const enabledSwitches = screen.getAllByRole('switch', { name: 'extensionEnable' });
    expect(enabledSwitches).toHaveLength(2);
    expect(enabledSwitches.every(control => !control.hasAttribute('disabled'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'openFolder' }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('C:\\extensions\\sample-extension'));
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
