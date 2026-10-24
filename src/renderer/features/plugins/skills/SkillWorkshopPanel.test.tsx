// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SkillWorkshopPanel from './SkillWorkshopPanel';

const inventory = {
  agentId: 'main',
  mode: 'off',
  root: '/native/workshop',
  skills: [
    {
      name: 'release',
      description: 'Release checklist',
      updatedAtMs: 10,
      sizeBytes: 40,
      files: ['SKILL.md', 'references/check.md'],
      useCount: 0,
    },
  ],
  archived: [
    {
      name: 'release',
      live: true,
      versions: [{ id: 'before-patch', action: 'patch', createdAtMs: 9 }],
    },
    {
      name: 'retired',
      live: false,
      versions: [{ id: 'before-archive', action: 'archive', createdAtMs: 8 }],
    },
  ],
};
const change = {
  id: 'c1',
  agentId: 'main',
  skillName: 'release',
  action: 'patch',
  actor: 'agent',
  summary: 'Improved',
  versionId: 'before-patch',
  createdAtMs: 9,
};
const success = (value: unknown) => ({ success: true, value });
function setup() {
  const api = {
    list: vi.fn().mockResolvedValue(success(inventory)),
    changes: vi.fn().mockResolvedValue(success([change])),
    read: vi.fn().mockImplementation(async (input: { name: string; filePath: string }) =>
      success({
        name: input.name,
        filePath: input.filePath,
        content:
          input.filePath === 'SKILL.md'
            ? 'Complete instructions\nLast instruction'
            : 'Full support content',
        files: ['SKILL.md', 'references/check.md'],
      }),
    ),
    archive: vi.fn().mockResolvedValue(success({ ...change, actor: 'user', action: 'archive' })),
    restore: vi
      .fn()
      .mockResolvedValue(
        success({ ...change, actor: 'user', action: 'restore', versionId: 'backup-current' }),
      ),
  };
  Object.defineProperty(window, 'electron', { configurable: true, value: { skillWorkshop: api } });
  const onSkillsChanged = vi.fn().mockResolvedValue(undefined);
  const mount = () => {
    const result = render(<SkillWorkshopPanel onSkillsChanged={onSkillsChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skill Workshop' }));
    return result;
  };
  return { api, mount, onSkillsChanged };
}
beforeEach(() => {
  vi.clearAllMocks();
  i18nService.setLanguage('en', { persist: false });
});
afterEach(cleanup);
const current = async () =>
  fireEvent.click(await screen.findByRole('button', { name: /release.*Release checklist/ }));
test('loads only when open, shows immediate native semantics and distinguishes live history', async () => {
  const fixture = setup();
  render(<SkillWorkshopPanel onSkillsChanged={fixture.onSkillsChanged} />);
  expect(fixture.api.list).not.toHaveBeenCalled();
  const launcher = screen.getByRole('button', { name: 'Skill Workshop' });
  fireEvent.click(launcher);
  await screen.findByText('Current skills');
  expect(await screen.findByText(/release · Live copy available/)).toBeTruthy();
  expect(screen.getByText(/retired · Archived/)).toBeTruthy();
  expect(screen.getByText(/Skill changes take effect immediately/)).toBeTruthy();
  expect(screen.queryByText(/Approve and apply|Reject proposal/)).toBeNull();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(launcher);
});
test('reads complete live instructions and selected support file using native read', async () => {
  const fixture = setup();
  fixture.mount();
  await current();
  expect(await screen.findByText(/Last instruction/)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'File' }), {
    target: { value: 'references/check.md' },
  });
  expect(await screen.findByText('Full support content')).toBeTruthy();
  expect(fixture.api.read).toHaveBeenLastCalledWith({
    agentId: 'main',
    name: 'release',
    filePath: 'references/check.md',
  });
});
test('restores an explicitly inspected version; returned backup is not reused as target', async () => {
  const fixture = setup();
  fixture.mount();
  fireEvent.click(await screen.findByRole('button', { name: /before-patch$/ }));
  await screen.findByText(/Last instruction/);
  fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
  expect(fixture.api.restore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  await waitFor(() =>
    expect(fixture.api.restore).toHaveBeenCalledExactlyOnceWith({
      agentId: 'main',
      name: 'release',
      versionId: 'before-patch',
    }),
  );
  await screen.findByText('The runtime confirmed the skill change.');
  expect(fixture.onSkillsChanged).toHaveBeenCalledOnce();
});
test('archive confirmation submits once, retains dialog while pending and accepts optional reason', async () => {
  const fixture = setup();
  let finish!: (value: unknown) => void;
  fixture.api.archive.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  fixture.mount();
  await current();
  fireEvent.click(await screen.findByRole('button', { name: 'Archive skill' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Archive reason (optional)' }), {
    target: { value: 'Obsolete' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fixture.api.archive).toHaveBeenCalledExactlyOnceWith({
    agentId: 'main',
    name: 'release',
    reason: 'Obsolete',
  });
  await act(async () => finish(success({ ...change, action: 'archive', actor: 'user' })));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
});
test('uncertain write clears selection, reconciles read-only and is never replayed on refresh', async () => {
  const fixture = setup();
  fixture.api.archive.mockResolvedValue({
    success: false,
    error: 'skillWorkshopMutationUnconfirmed',
  });
  fixture.mount();
  await current();
  fireEvent.click(await screen.findByRole('button', { name: 'Archive skill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('may have taken effect'),
  );
  expect(screen.queryByRole('button', { name: 'Archive skill' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fixture.api.list.mock.calls.length).toBeGreaterThan(2));
  expect(fixture.api.archive).toHaveBeenCalledOnce();
  expect(fixture.api.restore).not.toHaveBeenCalled();
});
test('keeps a confirmed mutation distinct from a failed product-list refresh', async () => {
  const fixture = setup();
  fixture.onSkillsChanged.mockRejectedValue(new Error('offline'));
  fixture.mount();
  await current();
  fireEvent.click(await screen.findByRole('button', { name: 'Archive skill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  await screen.findByText('The runtime confirmed the skill change.');
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('without repeating'),
  );
  expect(fixture.api.archive).toHaveBeenCalledOnce();
});
test('late read cannot resurrect a selection after a newer inventory refresh', async () => {
  const fixture = setup();
  let finish!: (value: unknown) => void;
  fixture.api.read.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  fixture.mount();
  await current();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fixture.api.list).toHaveBeenCalledTimes(2));
  await act(async () =>
    finish(
      success({
        name: 'release',
        filePath: 'SKILL.md',
        content: 'Late content',
        files: ['SKILL.md'],
      }),
    ),
  );
  expect(screen.queryByText('Late content')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Archive skill' })).toBeNull();
});
test('unmount releases focus listener and ignores pending native reads', async () => {
  const fixture = setup();
  const remove = vi.spyOn(window, 'removeEventListener');
  const mounted = fixture.mount();
  await current();
  mounted.unmount();
  expect(remove).toHaveBeenCalledWith('focus', expect.any(Function));
  remove.mockRestore();
});
