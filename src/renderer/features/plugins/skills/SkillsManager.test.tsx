// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { getSkillManagementCapabilities } from '@shared/plugins/skillManagement';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    setSkillEnabled: vi.fn(),
    isGatewayOffline: vi.fn(() => false),
    getLocalizedSkillDescription: (_id: string, _name: string, description: string) => description,
  },
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
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
  vi.mocked(skillService.loadSkills).mockResolvedValue([skill]);
});
afterEach(cleanup);

async function openDetails(readOnly = false) {
  const store = configureStore({ reducer: { skill: skillReducer } });
  render(
    <Provider store={store}>
      <SkillsManager searchQuery="coding-agent" visibility="installed" readOnly={readOnly} />
    </Provider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'subtaskShowInfo: coding-agent' }));
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
