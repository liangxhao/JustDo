// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import type { ExtensionChangedEvent } from '@shared/plugins/extensions';
import { getSkillManagementCapabilities } from '@shared/plugins/skillManagement';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { usePluginMarketplace } from '@/features/plugins/marketplace/usePluginMarketplace';
import PluginOperationFeedback from '@/features/plugins/shared/PluginOperationFeedback';

import type { Skill } from './skill';
import { skillService } from './skillService';
import skillReducer from './skillSlice';
import SkillsManager from './SkillsManager';

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
    <button onClick={() => void controller.refreshInventory()}>
      finish marketplace install or update
    </button>
  ),
}));
vi.mock('./skillService', () => ({
  skillService: {
    loadSkills: vi.fn(),
    refreshInventoryAfterMutation: vi.fn(),
    importSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    subscribeInventory: vi.fn(() => () => undefined),
    isGatewayOffline: vi.fn(() => false),
    hasInventoryReadFailed: vi.fn(() => false),
    getLocalizedSkillDescription: (_id: string, _name: string, description: string) => description,
  },
}));

vi.mock('@/features/plugins/marketplace/usePluginMarketplace', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/features/plugins/marketplace/usePluginMarketplace')>();
  return {
    ...actual,
    usePluginMarketplace: vi.fn((options: { onInstalled?: () => Promise<void> }) => ({
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
    })),
  };
});

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => {
      const messages: Record<string, string> = {
        pluginImportPartialSummary: '{successCount} succeeded and {failureCount} failed.',
        skillImportSuccess: 'Skill {skillId} imported successfully',
        skillDeleteSuccess: 'Skill "{name}" deleted',
        skillResolutionUnavailable: '"{name}" is currently unavailable.',
        skillResolutionChanged: '"{name}" now uses {to} instead of {from}.',
      };
      return messages[key] ?? key;
    },
    getLanguage: () => 'en',
  },
}));

const skill: Skill = {
  id: 'coding-agent',
  name: 'coding-agent',
  description: 'Delegate coding work',
  enabled: false,
  isOfficial: true,
  isBuiltIn: true,
  updatedAt: 0,
  prompt: '',
  skillPath: 'C:/skills/coding-agent/SKILL.md',
  source: 'openclaw-bundled',
  eligible: false,
  missing: { bins: [], env: [], config: ['skills.entries.coding-agent.enabled'], os: [] },
  scope: 'system',
  ownershipScope: 'system',
  management: getSkillManagementCapabilities({
    source: 'openclaw-bundled',
    bundled: true,
    eligible: false,
    hasPath: true,
  }),
};

const extensionEvents = {
  onChanged: vi.fn<(listener: (event: ExtensionChangedEvent) => void) => () => void>(
    () => () => undefined,
  ),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(skillService.loadSkills).mockReset().mockResolvedValue([skill]);
  vi.mocked(skillService.importSkill).mockReset();
  vi.mocked(skillService.deleteSkill).mockReset();
  vi.mocked(skillService.setSkillEnabled).mockReset();
  vi.mocked(skillService.hasInventoryReadFailed).mockReset().mockReturnValue(false);
  vi.mocked(skillService.subscribeInventory)
    .mockReset()
    .mockReturnValue(() => undefined);
  vi.mocked(skillService.refreshInventoryAfterMutation)
    .mockReset()
    .mockImplementation(() => skillService.loadSkills({ force: true }));
  extensionEvents.onChanged.mockReset().mockReturnValue(() => undefined);
  vi.stubGlobal('electron', { extensions: extensionEvents });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('does not authorize marketplace inventory or confirm refresh after an online read failure', async () => {
  vi.mocked(skillService.hasInventoryReadFailed).mockReturnValue(true);
  const store = configureStore({ reducer: { skill: skillReducer } });
  render(
    <Provider store={store}>
      <SkillsManager />
    </Provider>,
  );
  await waitFor(() => expect(store.getState().skill.skills).toEqual([skill]));

  const calls = vi.mocked(usePluginMarketplace).mock.calls;
  const options = calls[calls.length - 1][0];
  expect(options.runtimeUnavailable).toBe(false);
  expect(options.inventoryReady).toBe(false);
  await expect(options.onInstalled?.()).rejects.toThrow('Inventory unavailable');
});

test('reconciles an extension change missed before mounting and ignores updates after leaving', async () => {
  let notify!: (skills: Skill[]) => void;
  const stopInventory = vi.fn();
  vi.mocked(skillService.subscribeInventory).mockImplementation(listener => {
    notify = listener;
    return stopInventory;
  });
  vi.mocked(skillService.refreshInventoryAfterMutation).mockResolvedValue([]);
  const store = configureStore({ reducer: { skill: skillReducer } });
  const view = render(
    <Provider store={store}>
      <SkillsManager searchQuery={skill.name} visibility="installed" />
    </Provider>,
  );
  await waitFor(() => {
    const calls = vi.mocked(usePluginMarketplace).mock.calls;
    expect(calls[calls.length - 1][0].inventoryReady).toBe(true);
  });
  expect(store.getState().skill.skills).toEqual([]);
  expect(skillService.refreshInventoryAfterMutation).toHaveBeenCalledOnce();

  // Native discovery publishes after the initial successful, but stale, read.
  // No new extensions.onChanged event is needed once this page is mounted.
  await act(async () => notify([skill]));
  expect(screen.getByRole('button', { name: `subtaskShowInfo: ${skill.name}` })).toBeTruthy();
  view.unmount();
  expect(stopInventory).toHaveBeenCalledOnce();
  await act(async () => notify([]));
  expect(store.getState().skill.skills).toEqual([skill]);
});

test('refreshes attached skills and open details when their parent extension changes', async () => {
  let changed!: (event: ExtensionChangedEvent) => void;
  const stop = vi.fn();
  extensionEvents.onChanged.mockImplementation(listener => {
    changed = listener;
    return stop;
  });
  let notify!: (skills: Skill[]) => void;
  vi.mocked(skillService.subscribeInventory).mockImplementation(listener => {
    notify = listener;
    return () => undefined;
  });
  vi.mocked(skillService.refreshInventoryAfterMutation)
    .mockResolvedValueOnce([skill])
    .mockImplementation(async () => {
      notify([]);
      return [];
    });
  const store = configureStore({ reducer: { skill: skillReducer } });
  const view = render(
    <Provider store={store}>
      <SkillsManager searchQuery={skill.name} visibility="installed" />
    </Provider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: `subtaskShowInfo: ${skill.name}` }));
  expect(screen.getByRole('button', { name: 'close' })).toBeTruthy();
  expect(extensionEvents.onChanged).toHaveBeenCalledOnce();

  await act(async () => changed({ extensionId: 'parent-plugin', enabled: false }));

  expect(skillService.refreshInventoryAfterMutation).toHaveBeenCalledTimes(2);
  expect(store.getState().skill.skills).toEqual([]);
  expect(screen.queryByRole('button', { name: 'close' })).toBeNull();
  await act(async () => notify([skill]));
  expect(screen.getByRole('button', { name: `subtaskShowInfo: ${skill.name}` })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'close' })).toBeNull();
  view.unmount();
  expect(stop).toHaveBeenCalledOnce();
});

async function openDetails(readOnly = false, skillName = skill.name) {
  const store = configureStore({ reducer: { skill: skillReducer } });
  render(
    <Provider store={store}>
      <SkillsManager searchQuery={skillName} visibility="installed" readOnly={readOnly} />
    </Provider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: `subtaskShowInfo: ${skillName}` }));
  return store;
}

test('enables an opt-in skill from its card and refreshes the open details', async () => {
  let finish!: (skills: Skill[]) => void;
  vi.mocked(skillService.setSkillEnabled).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  const store = await openDetails();
  expect(screen.queryByText('skillMissingRequirements')).toBeNull();
  expect(screen.queryByText('1 missing')).toBeNull();
  const close = screen.getByRole('button', { name: 'close' });
  expect(
    within(close.closest<HTMLElement>('[data-workspace-overlay]')!).queryByRole('switch'),
  ).toBeNull();
  fireEvent.click(close);
  const enable = screen.getByRole('switch', { name: 'enableSkill' });
  expect(enable.getAttribute('aria-checked')).toBe('false');
  expect(enable.textContent).toBe('');

  fireEvent.click(enable);
  expect(skillService.setSkillEnabled).toHaveBeenCalledWith('coding-agent', true);
  expect(enable.hasAttribute('disabled')).toBe(true);
  expect(enable.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(enable);
  expect(skillService.setSkillEnabled).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: coding-agent' }));
  await act(async () =>
    finish([
      {
        ...skill,
        enabled: true,
        eligible: true,
        missing: { bins: [], env: [], config: [], os: [] },
      },
    ]),
  );

  const disable = await screen.findByRole('switch', { name: 'disableSkill' });
  expect(disable.getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByText('skillMissingRequirements')).toBeNull();
  expect(store.getState().skill.skills[0].enabled).toBe(true);

  vi.mocked(skillService.setSkillEnabled).mockResolvedValue([skill]);
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  fireEvent.click(disable);
  const disabled = await screen.findByRole('switch', { name: 'enableSkill' });
  expect(skillService.setSkillEnabled).toHaveBeenLastCalledWith('coding-agent', false);
  expect(disabled.getAttribute('aria-checked')).toBe('false');
});

test('keeps the original state and allows retrying after enabling fails', async () => {
  vi.mocked(skillService.loadSkills).mockResolvedValue([
    {
      ...skill,
      missing: {
        bins: ['codex'],
        env: [],
        config: ['skills.entries.coding-agent.enabled', 'tools.exec.enabled'],
        os: [],
      },
    },
  ]);
  vi.mocked(skillService.setSkillEnabled).mockRejectedValue(new Error('Save failed'));
  await openDetails();
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  fireEvent.click(screen.getByRole('switch', { name: 'enableSkill' }));

  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'enableSkill' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  expect(screen.getByRole('switch', { name: 'enableSkill' }).getAttribute('aria-checked')).toBe(
    'false',
  );
  expect(screen.queryByText('Save failed')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: coding-agent' }));
  expect(screen.getByText('missingConfig: tools.exec.enabled')).toBeTruthy();
  expect(screen.getByText('missingBins: codex')).toBeTruthy();
  expect(screen.getByText('2 missing')).toBeTruthy();
  expect(screen.queryByText(/skills.entries.coding-agent.enabled/)).toBeNull();
});

test('keeps alternative tool requirements visible before and after enabling a skill', async () => {
  const missing = {
    bins: [],
    anyBins: ['claude', 'codex', 'opencode'],
    env: [],
    config: ['skills.entries.coding-agent.enabled'],
    os: [],
  };
  vi.mocked(skillService.loadSkills).mockResolvedValue([{ ...skill, missing }]);
  vi.mocked(skillService.setSkillEnabled).mockResolvedValue([
    {
      ...skill,
      enabled: true,
      eligible: false,
      missing: { ...missing, config: [] },
    },
  ]);
  await openDetails();

  expect(screen.getByText('missingAnyBins: claude, codex, opencode')).toBeTruthy();
  expect(screen.queryByText(/skills.entries.coding-agent.enabled/)).toBeNull();
  const badge = screen.getByText('1 missing');
  fireEvent.mouseEnter(badge);
  await waitFor(() =>
    expect(screen.getByRole('tooltip').textContent).toBe(
      'skillMissingRequirements: missingAnyBins: claude, codex, opencode',
    ),
  );
  fireEvent.mouseLeave(badge);

  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  fireEvent.click(screen.getByRole('switch', { name: 'enableSkill' }));
  await screen.findByRole('switch', { name: 'disableSkill' });
  fireEvent.click(screen.getByRole('button', { name: 'subtaskShowInfo: coding-agent' }));
  expect(screen.getByText('missingAnyBins: claude, codex, opencode')).toBeTruthy();
  expect(screen.getByText('1 missing')).toBeTruthy();
});

test('switches an extension skill from its card while keeping details free of switches and removal', async () => {
  const extensionSkill = {
    ...skill,
    isBuiltIn: false,
    source: 'openclaw-extra' as const,
    scope: 'extension' as const,
    skillPath: 'C:/state/plugin-skills/coding-agent/SKILL.md',
    management: getSkillManagementCapabilities({
      source: 'openclaw-extra',
      bundled: false,
      eligible: false,
      hasPath: true,
      filePath: 'C:/state/plugin-skills/coding-agent/SKILL.md',
    }),
  };
  vi.mocked(skillService.loadSkills).mockResolvedValue([extensionSkill]);
  vi.mocked(skillService.setSkillEnabled).mockResolvedValue([{ ...extensionSkill, enabled: true }]);
  const store = await openDetails();

  const close = screen.getByRole('button', { name: 'close' });
  expect(
    within(close.closest<HTMLElement>('[data-workspace-overlay]')!).queryByRole('switch'),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'deleteSkill' })).toBeNull();
  fireEvent.click(close);
  const toggle = screen.getByRole('switch', { name: 'enableSkill' });
  expect(toggle.hasAttribute('disabled')).toBe(false);
  await act(async () => fireEvent.click(toggle));
  expect(skillService.setSkillEnabled).toHaveBeenCalledWith(extensionSkill.id, true);
  expect(store.getState().skill.skills[0].enabled).toBe(true);
  expect(screen.getByRole('switch', { name: 'disableSkill' })).toBeTruthy();
});

test('does not expose mutations in read-only skill details', async () => {
  await openDetails(true);

  const close = screen.getByRole('button', { name: 'close' });
  expect(
    within(close.closest<HTMLElement>('[data-workspace-overlay]')!).queryByRole('switch'),
  ).toBeNull();
  fireEvent.click(close);
  const toggle = screen.getByRole('switch', { name: 'enableSkill' });
  expect(toggle.hasAttribute('disabled')).toBe(true);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle);
  expect(skillService.setSkillEnabled).not.toHaveBeenCalled();
});

const importedSkill: Skill = {
  ...skill,
  id: 'imported-skill',
  name: 'imported-skill',
  description: 'A locally imported skill',
  enabled: true,
  isOfficial: false,
  isBuiltIn: false,
  skillPath: 'C:/state/skills/imported-skill/SKILL.md',
  source: 'openclaw-managed',
  eligible: true,
  missing: { bins: [], env: [], config: [], os: [] },
  scope: 'personal',
  ownershipScope: 'personal',
  management: getSkillManagementCapabilities({
    source: 'openclaw-managed',
    bundled: false,
    eligible: true,
    hasPath: true,
  }),
};

test.each([true, false])(
  'applies a card switch with a single click from enabled=%s',
  async enabled => {
    const initial = { ...importedSkill, enabled };
    vi.mocked(skillService.loadSkills).mockResolvedValue([initial]);
    let finish!: (skills: Skill[]) => void;
    vi.mocked(skillService.setSkillEnabled).mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const store = configureStore({ reducer: { skill: skillReducer } });
    render(
      <Provider store={store}>
        <SkillsManager searchQuery={initial.name} visibility="installed" />
      </Provider>,
    );
    const toggle = await screen.findByRole('switch', {
      name: enabled ? 'disableSkill' : 'enableSkill',
    });

    fireEvent.click(toggle);

    expect(skillService.setSkillEnabled).toHaveBeenCalledExactlyOnceWith(initial.id, !enabled);
    expect(toggle.getAttribute('aria-busy')).toBe('true');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(toggle);
    expect(skillService.setSkillEnabled).toHaveBeenCalledOnce();
    await act(async () => finish([{ ...initial, enabled: !enabled }]));

    const updated = screen.getByRole('switch', {
      name: enabled ? 'enableSkill' : 'disableSkill',
    });
    expect(updated.getAttribute('aria-checked')).toBe(String(!enabled));
    expect(updated.hasAttribute('disabled')).toBe(false);
    expect(store.getState().skill.skills[0].enabled).toBe(!enabled);
  },
);

test('an initial list consumed after switching cannot restore the previous card state', async () => {
  const initial = { ...importedSkill, enabled: true };
  let finishRead!: (skills: Skill[]) => void;
  let finishSwitch!: (skills: Skill[]) => void;
  vi.mocked(skillService.loadSkills).mockReturnValue(
    new Promise(resolve => {
      finishRead = resolve;
    }),
  );
  vi.mocked(skillService.setSkillEnabled).mockReturnValue(
    new Promise(resolve => {
      finishSwitch = resolve;
    }),
  );
  const store = configureStore({
    reducer: { skill: skillReducer },
    preloadedState: { skill: { skills: [initial], activeSkillIds: [] } },
  });
  render(
    <Provider store={store}>
      <SkillsManager visibility="installed" />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('switch', { name: 'disableSkill' }));

  await act(async () => {
    finishRead([initial]);
    finishSwitch([{ ...initial, enabled: false }]);
  });

  expect(store.getState().skill.skills[0].enabled).toBe(false);
  expect(screen.getByRole('switch', { name: 'enableSkill' }).getAttribute('aria-checked')).toBe(
    'false',
  );
});

test('a switch finishing after leaving the page cannot overwrite the remounted inventory', async () => {
  const initial = { ...importedSkill, enabled: true };
  const fresh = { ...initial, enabled: false, description: 'Fresh native metadata' };
  let finish!: (skills: Skill[]) => void;
  vi.mocked(skillService.loadSkills)
    .mockResolvedValueOnce([initial])
    .mockResolvedValueOnce([fresh]);
  vi.mocked(skillService.setSkillEnabled).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  const store = configureStore({ reducer: { skill: skillReducer } });
  const firstPage = render(
    <Provider store={store}>
      <SkillsManager visibility="installed" />
    </Provider>,
  );
  fireEvent.click(await screen.findByRole('switch', { name: 'disableSkill' }));
  firstPage.unmount();
  render(
    <Provider store={store}>
      <SkillsManager visibility="installed" />
    </Provider>,
  );
  await waitFor(() => expect(store.getState().skill.skills).toEqual([fresh]));

  await act(async () => finish([{ ...initial, enabled: false }]));

  expect(store.getState().skill.skills).toEqual([fresh]);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('does not turn a successful switch refresh into a skill-unavailable notice', async () => {
  vi.mocked(skillService.loadSkills).mockResolvedValue([importedSkill]);
  vi.mocked(skillService.setSkillEnabled).mockResolvedValue([]);
  const store = configureStore({ reducer: { skill: skillReducer } });
  render(
    <Provider store={store}>
      <SkillsManager visibility="installed" />
    </Provider>,
  );
  fireEvent.click(await screen.findByRole('switch', { name: 'disableSkill' }));

  await waitFor(() => expect(store.getState().skill.skills).toEqual([]));
  expect(screen.queryByText('"imported-skill" is currently unavailable.')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test.each(['success', 'failure'] as const)(
  'a switch ending with %s does not discard an import refresh started during the switch',
  async outcome => {
    const initial = { ...importedSkill, enabled: true };
    const disabled = { ...initial, enabled: false };
    const added = { ...importedSkill, id: 'another-skill', name: 'another-skill' };
    const refreshed = [outcome === 'success' ? disabled : initial, added];
    let finishImport!: (result: { success: boolean; skillId?: string }) => void;
    let finishRefresh!: (skills: Skill[]) => void;
    let finishSwitch!: (skills: Skill[]) => void;
    let failSwitch!: (error: Error) => void;
    vi.stubGlobal('electron', {
      extensions: extensionEvents,
      dialog: {
        selectFolders: vi.fn().mockResolvedValue({
          success: true,
          paths: ['C:/imports/another-skill'],
        }),
      },
    });
    vi.mocked(skillService.loadSkills)
      .mockResolvedValueOnce([initial])
      .mockReturnValueOnce(
        new Promise(resolve => {
          finishRefresh = resolve;
        }),
      );
    vi.mocked(skillService.importSkill).mockReturnValue(
      new Promise(resolve => {
        finishImport = resolve;
      }),
    );
    vi.mocked(skillService.setSkillEnabled).mockReturnValue(
      new Promise((resolve, reject) => {
        finishSwitch = resolve;
        failSwitch = reject;
      }),
    );
    const store = configureStore({ reducer: { skill: skillReducer } });
    render(
      <Provider store={store}>
        <SkillsManager visibility="installed" />
      </Provider>,
    );
    await screen.findByRole('switch', { name: 'disableSkill' });
    fireEvent.click(screen.getByRole('button', { name: 'importSkill' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /selectSkillFolders selectSkillFoldersDescription/,
      }),
    );
    await waitFor(() => expect(skillService.importSkill).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('switch', { name: 'disableSkill' }));

    await act(async () => finishImport({ success: true, skillId: added.id }));
    expect(skillService.loadSkills).toHaveBeenCalledTimes(2);
    expect(skillService.loadSkills).toHaveBeenLastCalledWith({ force: true });
    await act(async () => {
      if (outcome === 'success') finishSwitch([disabled]);
      else failSwitch(new Error('Save failed'));
    });
    if (outcome === 'failure') expect(screen.queryByText('Save failed')).toBeNull();
    await act(async () => finishRefresh(refreshed));

    expect(store.getState().skill.skills).toEqual(refreshed);
    expect(screen.getByRole('button', { name: 'subtaskShowInfo: another-skill' })).toBeTruthy();
  },
);

async function startImport(paths: string[], sourceType: 'folders' | 'archives' = 'folders') {
  vi.stubGlobal('electron', {
    extensions: extensionEvents,
    dialog: {
      selectFolders: vi.fn().mockResolvedValue({ success: true, paths }),
      selectFiles: vi.fn().mockResolvedValue({ success: true, paths }),
    },
  });
  const store = configureStore({ reducer: { skill: skillReducer } });
  render(
    <Provider store={store}>
      <SkillsManager visibility="installed" />
      <PluginOperationFeedback />
    </Provider>,
  );
  await waitFor(() => expect(store.getState().skill.skills).toEqual([skill]));
  fireEvent.click(screen.getByRole('button', { name: 'importSkill' }));
  fireEvent.click(
    screen.getByRole('button', {
      name:
        sourceType === 'folders'
          ? /selectSkillFolders selectSkillFoldersDescription/
          : /selectSkillArchives selectSkillArchivesDescription/,
    }),
  );
  return store;
}

test.each(['folders', 'archives'] as const)(
  'shows partial import details and refreshes successful skills from %s',
  async sourceType => {
    const suffix = sourceType === 'archives' ? '.zip' : '';
    const paths = [`C:/imports/invalid-skill${suffix}`, `C:/imports/imported-skill${suffix}`];
    vi.mocked(skillService.importSkill)
      .mockResolvedValueOnce({ success: false, error: 'SKILL.md is missing' })
      .mockResolvedValueOnce({ success: true, skillId: importedSkill.id });
    vi.mocked(skillService.loadSkills)
      .mockResolvedValueOnce([skill])
      .mockResolvedValue([skill, importedSkill]);

    const store = await startImport(paths, sourceType);

    const dialog = await screen.findByRole('alertdialog', {
      name: 'pluginOperationFailureTitle.install',
    });
    expect(within(dialog).getByText('1 succeeded and 1 failed.')).toBeTruthy();
    expect(within(dialog).getByText(`invalid-skill${suffix}`)).toBeTruthy();
    expect(within(dialog).getByText('SKILL.md is missing')).toBeTruthy();
    expect(within(dialog).getByText(importedSkill.id)).toBeTruthy();
    expect(within(dialog).getByText('pluginImportItemSuccess')).toBeTruthy();
    await screen.findByRole('button', { name: 'subtaskShowInfo: imported-skill' });
    expect(store.getState().skill.skills).toEqual([skill, importedSkill]);
    expect(skillService.importSkill).toHaveBeenNthCalledWith(1, paths[0], { reportFailure: false });
    expect(skillService.importSkill).toHaveBeenNthCalledWith(2, paths[1], { reportFailure: false });
    expect(skillService.loadSkills).toHaveBeenCalledTimes(2);
    expect(skillService.loadSkills).toHaveBeenLastCalledWith({ force: true });
  },
);

test('refreshes the list and shows a success dialog when all imports succeed', async () => {
  vi.mocked(skillService.importSkill).mockResolvedValue({
    success: true,
    skillId: importedSkill.id,
  });
  vi.mocked(skillService.loadSkills)
    .mockResolvedValueOnce([skill])
    .mockResolvedValue([skill, importedSkill]);

  const store = await startImport(['C:/imports/imported-skill']);

  const dialog = await screen.findByRole('alertdialog', { name: 'importSkill' });
  expect(within(dialog).getByText('Skill imported-skill imported successfully')).toBeTruthy();
  await screen.findByRole('button', { name: 'subtaskShowInfo: imported-skill' });
  expect(store.getState().skill.skills).toEqual([skill, importedSkill]);
  expect(skillService.loadSkills).toHaveBeenCalledTimes(2);
  expect(skillService.loadSkills).toHaveBeenLastCalledWith({ force: true });
});

test('shows every failure and keeps the list when all imports fail', async () => {
  vi.mocked(skillService.importSkill)
    .mockResolvedValueOnce({ success: false, error: 'SKILL.md is missing' })
    .mockResolvedValueOnce({ success: false, error: 'Invalid skill name' });

  const store = await startImport(['C:/imports/missing-skill', 'C:/imports/invalid-skill']);

  const dialog = await screen.findByRole('alertdialog', {
    name: 'pluginOperationFailureTitle.install',
  });
  expect(within(dialog).getByText('missing-skill')).toBeTruthy();
  expect(within(dialog).getByText('SKILL.md is missing')).toBeTruthy();
  expect(within(dialog).getByText('invalid-skill')).toBeTruthy();
  expect(within(dialog).getByText('Invalid skill name')).toBeTruthy();
  expect(store.getState().skill.skills).toEqual([skill]);
  expect(skillService.loadSkills).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'importSkill' }).hasAttribute('disabled')).toBe(false);
});

test('confirms successful deletion without calling the removed skill unavailable', async () => {
  vi.mocked(skillService.loadSkills).mockResolvedValue([importedSkill]);
  vi.mocked(skillService.deleteSkill).mockResolvedValue({ success: true, skills: [] });
  const store = await openDetails(false, importedSkill.name);

  fireEvent.click(screen.getByRole('button', { name: 'deleteSkill' }));
  fireEvent.click(screen.getByRole('button', { name: 'delete' }));

  const dialog = await screen.findByRole('alertdialog', { name: 'deleteSkill' });
  expect(within(dialog).getByText('Skill "imported-skill" deleted')).toBeTruthy();
  expect(within(dialog).queryByText(/currently unavailable/)).toBeNull();
  expect(store.getState().skill.skills).toEqual([]);
  expect(screen.queryByRole('button', { name: 'subtaskShowInfo: imported-skill' })).toBeNull();
  expect(skillService.deleteSkill).toHaveBeenCalledWith(importedSkill.id, importedSkill.source);
});

test('confirms deletion and explains the actual same-name fallback', async () => {
  const fallback: Skill = {
    ...skill,
    id: importedSkill.id,
    name: importedSkill.name,
    skillPath: 'C:/runtime/skills/imported-skill/SKILL.md',
  };
  vi.mocked(skillService.loadSkills).mockResolvedValue([importedSkill]);
  vi.mocked(skillService.deleteSkill).mockResolvedValue({ success: true, skills: [fallback] });
  const store = await openDetails(false, importedSkill.name);

  fireEvent.click(screen.getByRole('button', { name: 'deleteSkill' }));
  fireEvent.click(screen.getByRole('button', { name: 'delete' }));

  const dialog = await screen.findByRole('alertdialog', { name: 'deleteSkill' });
  expect(within(dialog).getByText('Skill "imported-skill" deleted')).toBeTruthy();
  expect(
    within(dialog).getByText(
      '"imported-skill" now uses pluginSkillSource.openclaw-bundled instead of pluginSkillSource.openclaw-managed.',
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByText(/currently unavailable/)).toBeNull();
  expect(store.getState().skill.skills).toEqual([fallback]);
});

test('marketplace installation and updates start the shared native inventory reconciliation', async () => {
  const store = configureStore({ reducer: { skill: skillReducer } });
  render(
    <Provider store={store}>
      <SkillsManager visibility="all" />
    </Provider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'finish marketplace install or update' }),
  );
  expect(skillService.refreshInventoryAfterMutation).toHaveBeenCalledTimes(2);
});
