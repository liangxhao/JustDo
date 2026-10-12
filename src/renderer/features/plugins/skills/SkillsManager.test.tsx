// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { getSkillManagementCapabilities } from '@shared/plugins/skillManagement';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Skill } from './skill';
import { skillService } from './skillService';
import skillReducer from './skillSlice';
import SkillsManager from './SkillsManager';

vi.mock('./SkillMarketplace', () => ({ default: () => null }));
vi.mock('./skillService', () => ({
  skillService: {
    loadSkills: vi.fn(),
    importSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    isGatewayOffline: vi.fn(() => false),
    getLocalizedSkillDescription: (_id: string, _name: string, description: string) => description,
  },
}));
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(skillService.loadSkills).mockReset().mockResolvedValue([skill]);
  vi.mocked(skillService.importSkill).mockReset();
  vi.mocked(skillService.deleteSkill).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

test('enables an opt-in skill from its details and refreshes the open dialog', async () => {
  let finish!: (skills: Skill[]) => void;
  vi.mocked(skillService.setSkillEnabled).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  const store = await openDetails();
  expect(screen.queryByText('skillMissingRequirements')).toBeNull();
  expect(screen.queryByText('1 missing')).toBeNull();
  const enable = screen.getByRole('switch', { name: 'enableSkill: coding-agent' });
  expect(enable.getAttribute('aria-checked')).toBe('false');
  expect(enable.textContent).toBe('');

  fireEvent.click(enable);
  expect(skillService.setSkillEnabled).toHaveBeenCalledWith('coding-agent', true);
  expect(enable.hasAttribute('disabled')).toBe(true);
  expect(enable.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(enable);
  expect(skillService.setSkillEnabled).toHaveBeenCalledOnce();
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

  const disable = await screen.findByRole('switch', { name: 'disableSkill: coding-agent' });
  expect(disable.getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByText('skillMissingRequirements')).toBeNull();
  expect(store.getState().skill.skills[0].enabled).toBe(true);

  vi.mocked(skillService.setSkillEnabled).mockResolvedValue([skill]);
  fireEvent.click(disable);
  const disabled = await screen.findByRole('switch', { name: 'enableSkill: coding-agent' });
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
  fireEvent.click(screen.getByRole('switch', { name: 'enableSkill: coding-agent' }));

  await screen.findByText('Save failed');
  await waitFor(() =>
    expect(
      screen.getByRole('switch', { name: 'enableSkill: coding-agent' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(
    screen.getByRole('switch', { name: 'enableSkill: coding-agent' }).getAttribute('aria-checked'),
  ).toBe('false');
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

  fireEvent.click(screen.getByRole('switch', { name: 'enableSkill: coding-agent' }));
  await screen.findByRole('switch', { name: 'disableSkill: coding-agent' });
  expect(screen.getByText('missingAnyBins: claude, codex, opencode')).toBeTruthy();
  expect(screen.getByText('1 missing')).toBeTruthy();
});

test('keeps extension-managed skills locked in their details', async () => {
  vi.mocked(skillService.loadSkills).mockResolvedValue([
    {
      ...skill,
      management: getSkillManagementCapabilities({
        source: 'openclaw-extra',
        bundled: false,
        eligible: false,
        hasPath: true,
        filePath: 'C:/state/plugin-skills/coding-agent/SKILL.md',
      }),
    },
  ]);
  await openDetails();

  expect(screen.queryByRole('switch', { name: 'enableSkill: coding-agent' })).toBeNull();
  expect(
    screen.getAllByRole('img', { name: 'pluginStatusDisabled · pluginManagedActionUnavailable' }),
  ).toHaveLength(2);
  expect(skillService.setSkillEnabled).not.toHaveBeenCalled();
});

test('does not expose mutations in read-only skill details', async () => {
  await openDetails(true);

  const toggle = screen.getByRole('switch', { name: 'enableSkill: coding-agent' });
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

async function startImport(paths: string[], sourceType: 'folders' | 'archives' = 'folders') {
  vi.stubGlobal('electron', {
    dialog: {
      selectFolders: vi.fn().mockResolvedValue({ success: true, paths }),
      selectFiles: vi.fn().mockResolvedValue({ success: true, paths }),
    },
  });
  const store = configureStore({ reducer: { skill: skillReducer } });
  render(
    <Provider store={store}>
      <SkillsManager visibility="installed" />
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

    const dialog = await screen.findByRole('alertdialog', { name: 'pluginImportPartialTitle' });
    expect(within(dialog).getByText('1 succeeded and 1 failed.')).toBeTruthy();
    expect(within(dialog).getByText(`invalid-skill${suffix}`)).toBeTruthy();
    expect(within(dialog).getByText('SKILL.md is missing')).toBeTruthy();
    expect(within(dialog).getByText(importedSkill.id)).toBeTruthy();
    expect(within(dialog).getByText('pluginImportItemSuccess')).toBeTruthy();
    await screen.findByRole('button', { name: 'subtaskShowInfo: imported-skill' });
    expect(store.getState().skill.skills).toEqual([skill, importedSkill]);
    expect(skillService.importSkill).toHaveBeenNthCalledWith(1, paths[0]);
    expect(skillService.importSkill).toHaveBeenNthCalledWith(2, paths[1]);
    expect(skillService.loadSkills).toHaveBeenCalledTimes(2);
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
});

test('shows every failure and keeps the list when all imports fail', async () => {
  vi.mocked(skillService.importSkill)
    .mockResolvedValueOnce({ success: false, error: 'SKILL.md is missing' })
    .mockResolvedValueOnce({ success: false, error: 'Invalid skill name' });

  const store = await startImport(['C:/imports/missing-skill', 'C:/imports/invalid-skill']);

  const dialog = await screen.findByRole('alertdialog', { name: 'skillImportFailed' });
  expect(within(dialog).getByText('missing-skill')).toBeTruthy();
  expect(within(dialog).getByText('SKILL.md is missing')).toBeTruthy();
  expect(within(dialog).getByText('invalid-skill')).toBeTruthy();
  expect(within(dialog).getByText('Invalid skill name')).toBeTruthy();
  expect(store.getState().skill.skills).toEqual([skill]);
  expect(skillService.loadSkills).toHaveBeenCalledOnce();
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
