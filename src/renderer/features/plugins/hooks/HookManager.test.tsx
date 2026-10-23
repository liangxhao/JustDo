// @vitest-environment jsdom

import { getHookManagement } from '@shared/plugins/management';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import PluginOperationFeedback from '@/features/plugins/shared/PluginOperationFeedback';

import type { HookEntry } from './hook';
import HookManager from './HookManager';
import { hookService } from './hookService';

vi.mock('@/features/plugins/hooks/hookService', () => ({
  hookService: {
    loadHooks: vi.fn(async () => ({ success: true, hooks: [] })),
    isGatewayOffline: vi.fn(() => false),
    hasHookLoadFailed: vi.fn(() => false),
    getHooks: vi.fn(() => []),
    deleteHook: vi.fn(),
    setHookEnabled: vi.fn(),
    importHook: vi.fn(),
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'hookDeleteSuccess' ? 'Hook "{name}" deleted' : key),
    getLanguage: () => 'en',
  },
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hookService.loadHooks).mockReset().mockResolvedValue({ success: true, hooks: [] });
  vi.mocked(hookService.getHooks).mockReset().mockReturnValue([]);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { extensions: { onChanged: vi.fn(() => () => undefined) } },
  });
});

test('reloads provider Hooks on an extension change and ignores an older failed list', async () => {
  let finishOld!: (result: { success: boolean; error: string }) => void;
  const providerHook: HookEntry = {
    id: 'provider-hook',
    name: 'Provider Hook',
    description: 'Updated provider',
    enabled: true,
    eligible: true,
    requirementsSatisfied: true,
    loadable: true,
    source: 'openclaw-plugin',
    managedByPlugin: true,
    pluginId: 'provider',
    events: ['command:new'],
    missing: { bins: [], env: [], config: [], os: [] },
  };
  vi.mocked(hookService.loadHooks)
    .mockReturnValueOnce(
      new Promise(resolve => {
        finishOld = resolve;
      }),
    )
    .mockResolvedValueOnce({ success: true, hooks: [providerHook] });
  render(<HookManager />);

  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  await screen.findByText('Provider Hook');
  await act(async () => {
    finishOld({ success: false, error: 'Old read failed' });
  });

  expect(screen.getByText('Provider Hook')).toBeTruthy();
  expect(screen.queryByText('Old read failed')).toBeNull();
  expect(hookService.loadHooks).toHaveBeenLastCalledWith({ force: true });
});

test('keeps Hooks local without exposing an unsupported marketplace', async () => {
  render(<HookManager />);

  await waitFor(() => expect(screen.getByText('noHooksAvailable')).toBeTruthy());
  expect(screen.queryByText('hookMarketplace')).toBeNull();
});

test('opens the provider from the extension badge and keeps event tags in details', async () => {
  const onOpenExtension = vi.fn();
  const hook: HookEntry = {
    id: 'extension-hook',
    name: 'Extension Hook',
    description: 'Provided by an extension',
    enabled: true,
    eligible: true,
    requirementsSatisfied: true,
    loadable: true,
    source: 'openclaw-plugin',
    managedByPlugin: true,
    pluginId: 'provider',
    events: ['command:new'],
    missing: { bins: [], env: [], config: [], os: [] },
  };
  vi.mocked(hookService.loadHooks).mockResolvedValue({ success: true, hooks: [hook] });
  render(<HookManager onOpenExtension={onOpenExtension} />);
  await screen.findByText(hook.name);
  expect(screen.queryByText('command:new')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'openExtensionDetails' }));
  expect(onOpenExtension).toHaveBeenCalledExactlyOnceWith('provider');
  expect(screen.queryByRole('button', { name: 'close' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: `subtaskShowInfo: ${hook.name}` }));
  expect(screen.getByText('command:new')).toBeTruthy();
});

test('confirms custom Hook deletion and removes its row without an unavailable warning', async () => {
  const hook: HookEntry = {
    id: 'custom-hook',
    name: 'custom-hook',
    description: 'Custom Hook',
    enabled: true,
    eligible: true,
    requirementsSatisfied: true,
    loadable: true,
    source: 'openclaw-managed',
    managedByPlugin: false,
    events: ['command:new'],
    missing: { bins: [], env: [], config: [], os: [] },
    ...getHookManagement({ source: 'openclaw-managed' }),
  };
  vi.mocked(hookService.loadHooks).mockResolvedValue({ success: true, hooks: [hook] });
  vi.mocked(hookService.deleteHook).mockResolvedValue({ success: true, hooks: [] });
  render(<HookManager />);

  fireEvent.click(await screen.findByRole('button', { name: 'subtaskShowInfo: custom-hook' }));
  fireEvent.click(screen.getByRole('button', { name: 'deleteHook' }));
  fireEvent.click(screen.getByRole('button', { name: 'delete' }));

  await screen.findByText('Hook "custom-hook" deleted');
  expect(screen.queryByText('custom-hook')).toBeNull();
  expect(screen.queryByText('hookDeleteFailed')).toBeNull();
  expect(screen.queryByText(/unavailable/i)).toBeNull();
  expect(hookService.deleteHook).toHaveBeenCalledWith('custom-hook');
});

test('shows imported extension Hooks in the user section and bundled extension Hooks in the collapsed system section', async () => {
  const hooks: HookEntry[] = ['personal', 'system'].map(scope => ({
    id: `${scope}-hook`,
    name: `${scope}-hook`,
    description: 'Demo hook',
    enabled: true,
    eligible: true,
    requirementsSatisfied: true,
    loadable: true,
    source: 'openclaw-plugin',
    managedByPlugin: true,
    pluginId: `${scope}-plugin`,
    events: ['command:new'],
    missing: { bins: [], env: [], config: [], os: [] },
    ...getHookManagement({
      managedByPlugin: true,
      pluginId: `${scope}-plugin`,
      pluginScope: scope as 'personal' | 'system',
    }),
  }));
  vi.mocked(hookService.loadHooks).mockResolvedValue({ success: true, hooks });
  render(<HookManager />);
  await screen.findByText('personal-hook');
  const userSection = screen.getByText('pluginGroup.user.label').closest('section')!;
  const systemSection = screen.getByText('pluginGroup.system.label').closest('section')!;
  expect(within(userSection).getByText('personal-hook').closest('[hidden]')).toBeNull();
  expect(within(userSection).queryByText('system-hook')).toBeNull();
  expect(within(userSection).queryByRole('switch')).toBeNull();
  expect(
    within(userSection).getByLabelText('pluginStatusEnabled · hookManagedByPlugin'),
  ).toBeTruthy();
  const expand = within(systemSection).getByRole('button', { expanded: false });
  fireEvent.click(expand);
  expect(within(systemSection).getByText('system-hook').closest('[hidden]')).toBeNull();
});

const customHook: HookEntry = {
  id: 'custom-hook',
  name: 'custom-hook',
  description: 'Custom hook',
  enabled: true,
  eligible: true,
  requirementsSatisfied: true,
  loadable: true,
  source: 'openclaw-managed',
  managedByPlugin: false,
  events: ['command:new'],
  missing: { bins: [], env: [], config: [], os: [] },
  ...getHookManagement({ source: 'openclaw-managed' }),
};

test('a read consumed during a switch cannot restore the old Hook state or leave loading active', async () => {
  let finishRead!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  let finishSwitch!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  vi.mocked(hookService.loadHooks)
    .mockResolvedValueOnce({ success: true, hooks: [customHook] })
    .mockReturnValueOnce(new Promise(resolve => (finishRead = resolve)));
  vi.mocked(hookService.setHookEnabled).mockReturnValueOnce(
    new Promise(resolve => (finishSwitch = resolve)),
  );
  render(<HookManager />);
  const toggle = await screen.findByRole('switch', { name: 'disableHook' });
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
    fireEvent.click(toggle);
  });

  await act(async () => {
    vi.mocked(hookService.getHooks).mockReturnValue([{ ...customHook, enabled: false }]);
    finishRead({ success: true, hooks: [customHook] });
    finishSwitch({ success: true, hooks: [{ ...customHook, enabled: false }] });
  });

  expect(screen.getByRole('switch', { name: 'enableHook' }).getAttribute('aria-checked')).toBe(
    'false',
  );
  expect(screen.queryByText('loading')).toBeNull();
});

test('a provider refresh started during a Hook switch remains eligible after the switch ends', async () => {
  let finishRead!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  let finishSwitch!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  const disabled = { ...customHook, enabled: false };
  const added = { ...customHook, id: 'added-hook', name: 'added-hook' };
  vi.mocked(hookService.loadHooks)
    .mockResolvedValueOnce({ success: true, hooks: [customHook] })
    .mockReturnValueOnce(new Promise(resolve => (finishRead = resolve)));
  vi.mocked(hookService.setHookEnabled).mockReturnValueOnce(
    new Promise(resolve => (finishSwitch = resolve)),
  );
  render(<HookManager />);
  fireEvent.click(await screen.findByRole('switch', { name: 'disableHook' }));
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  await act(async () => {
    vi.mocked(hookService.getHooks).mockReturnValue([disabled]);
    finishSwitch({ success: true, hooks: [disabled] });
  });
  await act(async () => finishRead({ success: true, hooks: [disabled, added] }));

  expect(screen.getByText('added-hook')).toBeTruthy();
  expect(screen.getByRole('switch', { name: 'enableHook' }).getAttribute('aria-checked')).toBe(
    'false',
  );
  expect(screen.queryByText('loading')).toBeNull();
});

test.each([true, false])(
  'shows Hook deletion progress until it finishes (success: %s)',
  async success => {
    let finish!: (result: { success: boolean; hooks: HookEntry[] }) => void;
    let fail!: (error: Error) => void;
    vi.mocked(hookService.loadHooks).mockResolvedValue({ success: true, hooks: [customHook] });
    vi.mocked(hookService.deleteHook).mockReturnValueOnce(
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    );
    render(<HookManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'subtaskShowInfo: custom-hook' }));
    fireEvent.click(screen.getByRole('button', { name: 'deleteHook' }));
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    const deleting = screen.getByRole('button', { name: 'hookDeleting' });
    expect(deleting.getAttribute('aria-busy')).toBe('true');
    expect(deleting.hasAttribute('disabled')).toBe(true);
    expect(deleting.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cancel' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(deleting);
    expect(hookService.deleteHook).toHaveBeenCalledOnce();

    await act(async () => {
      if (success) finish({ success: true, hooks: [] });
      else fail(new Error('Native delete refused'));
    });

    expect(screen.queryByRole('button', { name: 'hookDeleting' })).toBeNull();
    if (!success) {
      expect(screen.queryByText('Native delete refused')).toBeNull();
      expect(screen.getByRole('button', { name: 'delete' }).hasAttribute('disabled')).toBe(false);
    }
  },
);

test('a late Hook mutation consumes the current projection instead of erasing newer provider metadata', async () => {
  let finish!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  const disabled = { ...customHook, enabled: false };
  const added = { ...customHook, id: 'new-provider-hook', name: 'New provider Hook' };
  vi.mocked(hookService.loadHooks)
    .mockResolvedValueOnce({ success: true, hooks: [customHook] })
    .mockResolvedValueOnce({ success: true, hooks: [disabled, added] });
  vi.mocked(hookService.setHookEnabled).mockReturnValueOnce(
    new Promise(resolve => (finish = resolve)),
  );
  render(<HookManager />);
  fireEvent.click(await screen.findByRole('switch', { name: 'disableHook' }));
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  expect(screen.getByText(added.name)).toBeTruthy();
  vi.mocked(hookService.getHooks).mockReturnValue([disabled, added]);
  await act(async () => finish({ success: true, hooks: [disabled] }));

  expect(screen.getByText(added.name)).toBeTruthy();
  expect(screen.getByRole('switch', { name: 'enableHook' }).getAttribute('aria-checked')).toBe(
    'false',
  );
});

test('cancelling the Hook picker leaves the in-flight provider refresh eligible', async () => {
  let finishRead!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  const added = { ...customHook, id: 'provider-hook', name: 'New provider Hook' };
  vi.mocked(hookService.loadHooks)
    .mockResolvedValueOnce({ success: true, hooks: [customHook] })
    .mockReturnValueOnce(new Promise(resolve => (finishRead = resolve)));
  window.electron.dialog = {
    selectFolders: vi.fn().mockResolvedValue({ success: true, paths: [] }),
  } as unknown as typeof window.electron.dialog;
  render(<HookManager />);
  fireEvent.click(await screen.findByRole('button', { name: 'importHook' }));
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  fireEvent.click(
    screen.getByRole('button', { name: /selectHookFolders selectHookFoldersDescription/ }),
  );
  await act(async () => finishRead({ success: true, hooks: [customHook, added] }));

  expect(screen.getByText(added.name)).toBeTruthy();
  expect(hookService.loadHooks).toHaveBeenCalledTimes(2);
  expect(hookService.importHook).not.toHaveBeenCalled();
  expect(screen.queryByText('loading')).toBeNull();
});

test.each(['toggle', 'delete'] as const)(
  'a failed Hook %s reconciles provider inventory without repeating service-owned feedback',
  async operation => {
    let finishRead!: (result: { success: boolean; hooks: HookEntry[] }) => void;
    const added = { ...customHook, id: 'provider-hook', name: 'New provider Hook' };
    vi.mocked(hookService.loadHooks)
      .mockResolvedValueOnce({ success: true, hooks: [customHook] })
      .mockReturnValueOnce(new Promise(resolve => (finishRead = resolve)))
      .mockResolvedValueOnce({ success: true, hooks: [customHook, added] });
    vi.mocked(hookService.getHooks).mockReturnValue([customHook, added]);
    if (operation === 'toggle') {
      vi.mocked(hookService.setHookEnabled).mockRejectedValueOnce(
        new Error('Native toggle refused'),
      );
    } else {
      vi.mocked(hookService.deleteHook).mockRejectedValueOnce(new Error('Native delete refused'));
    }
    render(<HookManager />);
    const toggle = await screen.findByRole('switch', { name: 'disableHook' });
    if (operation === 'delete') {
      fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: custom-hook' }));
      fireEvent.click(screen.getByRole('button', { name: 'deleteHook' }));
    }
    await act(async () => {
      vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
        extensionId: 'provider',
        enabled: true,
      });
      if (operation === 'toggle') fireEvent.click(toggle);
      else fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    });
    expect(screen.getByText(added.name)).toBeTruthy();
    expect(hookService.loadHooks).toHaveBeenLastCalledWith({ force: true });
    expect(screen.queryByText(`Native ${operation} refused`)).toBeNull();
    await act(async () => finishRead({ success: true, hooks: [] }));

    expect(screen.getByText(added.name)).toBeTruthy();
    expect(screen.queryByText(`Native ${operation} refused`)).toBeNull();
    expect(screen.queryByText('loading')).toBeNull();
  },
);

test('a failed Hook import refreshes native provider metadata without claiming success', async () => {
  let finishRead!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  const added = { ...customHook, id: 'provider-hook', name: 'New provider Hook' };
  vi.mocked(hookService.loadHooks)
    .mockResolvedValueOnce({ success: true, hooks: [customHook] })
    .mockReturnValueOnce(new Promise(resolve => (finishRead = resolve)))
    .mockResolvedValueOnce({ success: true, hooks: [customHook, added] });
  vi.mocked(hookService.getHooks).mockReturnValue([customHook, added]);
  vi.mocked(hookService.importHook).mockResolvedValueOnce({
    success: false,
    error: 'Import refused',
  });
  window.electron.dialog = {
    selectFolders: vi.fn().mockResolvedValue({ success: true, paths: ['C:/imports/invalid-hook'] }),
  } as unknown as typeof window.electron.dialog;
  render(
    <>
      <HookManager />
      <PluginOperationFeedback />
    </>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'importHook' }));
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: /selectHookFolders selectHookFoldersDescription/ }),
    );
  });
  expect(screen.getByText(added.name)).toBeTruthy();
  expect(screen.getByText('Import refused')).toBeTruthy();
  expect(hookService.importHook).toHaveBeenCalledExactlyOnceWith('C:/imports/invalid-hook', {
    reportFailure: false,
  });
  await act(async () => finishRead({ success: true, hooks: [] }));

  expect(screen.getByText(added.name)).toBeTruthy();
  expect(screen.queryByText('loading')).toBeNull();
});

test('Hook failure reconciliation does not consume an older projection after a newer provider read starts', async () => {
  let finishMutationRead!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  let finishProviderRead!: (result: { success: boolean; hooks: HookEntry[] }) => void;
  const added = { ...customHook, id: 'provider-hook', name: 'New provider Hook' };
  vi.mocked(hookService.loadHooks)
    .mockResolvedValueOnce({ success: true, hooks: [customHook] })
    .mockReturnValueOnce(new Promise(resolve => (finishMutationRead = resolve)))
    .mockReturnValueOnce(new Promise(resolve => (finishProviderRead = resolve)));
  vi.mocked(hookService.setHookEnabled).mockImplementationOnce(async () => {
    await hookService.loadHooks({ force: true });
    throw new Error('Native toggle refused');
  });
  vi.mocked(hookService.getHooks).mockReturnValue([customHook]);
  render(<HookManager />);
  fireEvent.click(await screen.findByRole('switch', { name: 'disableHook' }));
  await waitFor(() => expect(hookService.loadHooks).toHaveBeenCalledTimes(2));
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  await act(async () => finishMutationRead({ success: true, hooks: [customHook] }));
  expect(screen.getByText('loading')).toBeTruthy();
  await act(async () => finishProviderRead({ success: true, hooks: [customHook, added] }));

  expect(screen.getByText(added.name)).toBeTruthy();
  expect(screen.queryByText('loading')).toBeNull();
});
