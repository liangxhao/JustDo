// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';

import AgentManager from './AgentManager';
import agentReducer, { setAgents } from './agentSlice';
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: { updateConfig: vi.fn().mockResolvedValue(true) },
}));
vi.mock('./agentService', () => ({
  agentService: { loadAgents: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/features/models/openclawModelRef', () => ({
  toOpenClawModelRef: () => 'provider/model',
}));
const readFile = vi.fn();
const writeFile = vi.fn();
const save = vi.fn();
const deleteAgent = vi.fn();
const openPath = vi.fn();
const profile = {
  id: 'review',
  name: 'Reviewer',
  description: '',
  icon: '',
  model: '',
  enabled: true,
  isDefault: false,
  skillIds: [],
};
function mount(profiles = [profile]) {
  const store = configureStore({
    reducer: {
      agent: agentReducer,
      model: () => ({ availableModels: [] }),
      cowork: () => ({ config: {} }),
    },
  });
  store.dispatch(setAgents(profiles));
  const leaveGuard = { current: null as (() => boolean) | null };
  render(
    <Provider store={store}>
      <AgentManager leaveGuard={leaveGuard} />
    </Provider>,
  );
  return { leaveGuard };
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { agents: { readFile, writeFile, save, delete: deleteAgent }, shell: { openPath } },
  });
  readFile.mockResolvedValue({
    success: true,
    value: { workspace: '/roles/review', content: 'Read only', missing: false },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('independent Agent manager', () => {
  it('defaults assistant switching off and saves an explicit opt-in', async () => {
    mount();
    const checkbox = screen.getByRole('checkbox', { name: /agentAllowMainSwitch/ });
    expect(checkbox).toHaveProperty('checked', false);
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(coworkService.updateConfig).toHaveBeenCalledWith({ allowMainAgentSwitch: true }),
    );
  });

  it('navigates file tabs with the keyboard without discarding the current draft', async () => {
    mount();
    const rules = screen.getByRole('tab', { name: 'AGENTS.md' });
    await waitFor(() => expect(rules).toHaveProperty('disabled', false));
    fireEvent.change(screen.getByRole('textbox', { name: 'AGENTS.md' }), {
      target: { value: 'Unsaved rules' },
    });
    rules.focus();
    fireEvent.keyDown(rules, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'SOUL.md' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'MEMORY.md' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(rules);
    expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
      'value',
      'Unsaved rules',
    );
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('opens the native workspace from the icon toolbar and reports failures', async () => {
    openPath.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('missing'));
    mount();
    const button = screen.getByRole('button', { name: 'agentOpenWorkspace' });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/roles/review'));
    fireEvent.click(button);
    await screen.findByText('agentOpenWorkspaceFailed');
  });

  it.each(['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md', 'MEMORY.md'])(
    'explains a missing main %s and allows creating it',
    async name => {
      const workspace = '/project';
      const missing = { workspace, content: '', missing: true };
      readFile.mockImplementation(async (_id, file) => ({
        success: true,
        value:
          file === 'AGENTS.md' ? { workspace, content: 'Main rules', missing: false } : missing,
      }));
      writeFile.mockResolvedValue({
        success: true,
        value: { workspace, content: 'Main identity', missing: false },
      });
      mount([{ ...profile, id: 'main', isDefault: true }]);
      await waitFor(() =>
        expect(screen.getByRole('tab', { name })).toHaveProperty('disabled', false),
      );
      fireEvent.click(screen.getByRole('tab', { name }));
      await screen.findByText('agentFileMissing');
      expect(readFile).toHaveBeenCalledWith('main', name);
      const editor = screen.getByRole('textbox', { name });
      expect(editor).toHaveProperty('disabled', false);
      fireEvent.change(editor, { target: { value: 'Main identity' } });
      fireEvent.click(screen.getByRole('button', { name: 'agentSaveFile' }));
      await waitFor(() =>
        expect(writeFile).toHaveBeenCalledWith('main', name, 'Main identity', missing),
      );
      await waitFor(() => expect(screen.queryByText('agentFileMissing')).toBeNull());
      expect(editor).toHaveProperty('value', 'Main identity');
    },
  );

  it('shows the normalized saved profile and retains unsaved role text', async () => {
    save.mockResolvedValue({
      success: true,
      value: { ...profile, name: 'Reviewer renamed', description: 'Review changes' },
    });
    mount();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
        'value',
        'Read only',
      ),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'agentName' }), {
      target: { value: '  Reviewer renamed  ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'agentDescription' }), {
      target: { value: '  Review changes  ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'AGENTS.md' }), {
      target: { value: 'Unsaved rules' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'agentName' })).toHaveProperty(
        'value',
        'Reviewer renamed',
      ),
    );
    expect(screen.getByRole('textbox', { name: 'agentDescription' })).toHaveProperty(
      'value',
      'Review changes',
    );
    expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
      'value',
      'Unsaved rules',
    );
    expect(screen.getByRole('button', { name: 'save' })).toHaveProperty('disabled', true);
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('uses an application dialog when native confirmations are disabled and retains edits on failure', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
        'value',
        'Read only',
      ),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'agentName' }), {
      target: { value: 'Unsaved name' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'AGENTS.md' }), {
      target: { value: 'Unsaved rules' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'agentDelete' }));
    expect(screen.getByRole('dialog', { name: 'agentDelete' })).toBeTruthy();
    expect(deleteAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteAgent).not.toHaveBeenCalled();

    deleteAgent.mockResolvedValueOnce({ success: false, error: 'agentBusy' });
    fireEvent.click(screen.getByRole('button', { name: 'agentDelete' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'agentDelete' }),
    );
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'agentBusy');
    expect(screen.getByRole('textbox', { name: 'agentName' })).toHaveProperty(
      'value',
      'Unsaved name',
    );
    expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
      'value',
      'Unsaved rules',
    );

    deleteAgent.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'agentDelete' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'agentDelete' }),
    );
    expect(await screen.findByText('agentDeleted')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'agentName' })).toHaveProperty('value', '');
    expect(deleteAgent).toHaveBeenLastCalledWith('review');
    expect(confirm).not.toHaveBeenCalled();
  });
  it('cancels deletion with Escape and blocks closing or resubmitting while deletion is pending', async () => {
    let finish!: (result: { success: boolean }) => void;
    deleteAgent.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const { leaveGuard } = mount();
    await waitFor(() => expect(readFile).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'agentDelete' }));
    expect(leaveGuard.current?.()).toBe(false);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'agentDelete' }));
    const dialog = screen.getByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'agentDelete' });
    fireEvent.click(submit);
    expect(submit).toHaveProperty('disabled', true);
    expect(within(dialog).getByRole('button', { name: 'cancel' })).toHaveProperty('disabled', true);
    fireEvent.click(submit);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(deleteAgent).toHaveBeenCalledTimes(1);
    finish({ success: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('hides deleted profiles without removing their historical identity from the roster', async () => {
    mount([
      profile,
      {
        ...profile,
        id: 'deleted',
        name: 'Deleted reviewer',
        enabled: false,
        deletedAt: 123,
      } as typeof profile,
    ]);
    expect(screen.queryByRole('button', { name: /Deleted reviewer/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'agentDisabled' }));
    expect(screen.getByText('agentNoMatches')).toBeTruthy();
    await waitFor(() => expect(readFile).toHaveBeenCalled());
  });
  it('does not offer deletion for main', async () => {
    mount([{ ...profile, id: 'main', isDefault: true }]);
    expect(screen.queryByRole('button', { name: 'agentDelete' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'agentModel' })).toBeNull();
    await waitFor(() => expect(readFile).toHaveBeenCalled());
  });

  it('filters profiles by description and enabled state without changing the editor', async () => {
    mount([
      profile,
      { ...profile, id: 'writer', name: 'Writer', description: 'Documentation', enabled: false },
    ]);
    fireEvent.change(screen.getByRole('searchbox', { name: 'agentSearch' }), {
      target: { value: 'documentation' },
    });
    expect(screen.queryByRole('button', { name: /Reviewer/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Writer/ })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'agentName' }) as HTMLInputElement).value).toBe(
      'Reviewer',
    );
    fireEvent.click(screen.getByRole('button', { name: 'agentEnabled' }));
    expect(screen.queryByRole('button', { name: /Writer/ })).toBeNull();
    expect(screen.getByText('agentNoMatches')).toBeTruthy();
    await waitFor(() => expect(readFile).toHaveBeenCalled());
  });
  it('duplicates only persisted profile settings into an unsaved independent draft', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
        'value',
        'Read only',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'agentDuplicate' }));
    expect(screen.queryByRole('textbox', { name: 'AGENTS.md' })).toBeNull();
    expect(screen.getByText('agentCreateFirst')).toBeTruthy();
    expect(writeFile).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'agentEnabled' })).toHaveProperty('checked', true);
  });
  it('fills a new profile from a role preset without avatar controls', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'agentCreate' }));
    fireEvent.click(screen.getByRole('button', { name: /agentTemplateResearch$/ }));
    expect(screen.getByRole('textbox', { name: 'agentName' })).toHaveProperty(
      'value',
      'agentTemplateResearch',
    );
    expect(screen.getByRole('textbox', { name: 'agentDescription' })).toHaveProperty(
      'value',
      'agentTemplateResearchDescription',
    );
    expect(screen.getByRole('button', { name: 'save' })).toHaveProperty('disabled', false);
    expect(screen.queryByRole('textbox', { name: 'agentIcon' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'agentAvatarPresets' })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it('protects unsaved rule text when switching files or reloading', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
        'value',
        'Read only',
      ),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'AGENTS.md' }), {
      target: { value: 'Unsaved rules' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'SOUL.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'agentReloadFile' }));
    expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
      'value',
      'Unsaved rules',
    );
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('opens role files without exposing a direct chat or default-agent control', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Reviewer/ }));
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'AGENTS.md' }) as HTMLTextAreaElement).value,
      ).toBe('Read only'),
    );
    expect(readFile).toHaveBeenCalledWith('review', 'AGENTS.md');
    expect(screen.queryByRole('button', { name: 'agentStartChat' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'agentDefault' })).toBeNull();
  });
  it('creates a persistent assistant with an inherited model and opens its role files', async () => {
    save.mockResolvedValue({ success: true, value: { ...profile, id: 'new-review' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'agentCreate' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'agentName' }), {
      target: { value: 'Reviewer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith('new-review', 'AGENTS.md'));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Reviewer',
        model: '',
        enabled: true,
        isDefault: false,
      }),
    );
  });
  it('keeps edits visible after a file conflict', async () => {
    writeFile.mockResolvedValue({ success: false, error: 'agentFileConflict' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Reviewer/ }));
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'AGENTS.md' }) as HTMLTextAreaElement).value,
      ).toBe('Read only'),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'AGENTS.md' }), {
      target: { value: 'My rules' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'agentSaveFile' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'agentFileConflict');
    expect((screen.getByRole('textbox', { name: 'AGENTS.md' }) as HTMLTextAreaElement).value).toBe(
      'My rules',
    );
  });
  it('does not discard an unsaved profile when the user cancels closing', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { leaveGuard } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'agentName' }), {
      target: { value: 'Research' },
    });
    expect(leaveGuard.current?.()).toBe(false);
  });
});

it('creates an editable peer role template through native role files', async () => {
  save.mockResolvedValue({ success: true, value: profile });
  writeFile.mockImplementation(async (_id, _file, content) => ({
    success: true,
    value: { workspace: '/roles/review', content, missing: false },
  }));
  mount([]);
  fireEvent.click(screen.getByRole('button', { name: /agentTemplateResearch$/ }));
  const rules = screen.getByRole('textbox', { name: 'AGENTS.md' });
  expect(rules).toHaveProperty(
    'value',
    'agentTemplateResearchRules\n\nagentTemplateScopeRules\n\nagentTemplatePeerRules',
  );
  fireEvent.change(rules, { target: { value: 'Edited peer rules' } });
  fireEvent.click(screen.getByRole('button', { name: 'save' }));
  await waitFor(() =>
    expect(writeFile).toHaveBeenCalledWith(
      'review',
      'AGENTS.md',
      'Edited peer rules',
      expect.objectContaining({ content: 'Read only' }),
    ),
  );
  expect(save).toHaveBeenCalledTimes(1);
});

it('keeps a created profile and role draft when the initial native role write fails', async () => {
  save.mockResolvedValue({ success: true, value: profile });
  writeFile.mockResolvedValue({ success: false, error: 'agentSaveFailed' });
  mount([]);
  fireEvent.click(screen.getByRole('button', { name: /agentTemplateReview$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'save' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('agentTemplateSaveFailed'),
  );
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'AGENTS.md' })).toHaveProperty(
      'value',
      'agentTemplateReviewRules\n\nagentTemplateScopeRules\n\nagentTemplatePeerRules',
    ),
  );
  expect(screen.getByRole('button', { name: 'agentSaveFile' })).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'agentSaveFile' }));
  await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenCalledTimes(1);
});
