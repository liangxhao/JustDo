// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SkillWorkshopPanel from './SkillWorkshopPanel';

const revision = 'a'.repeat(64);
const proposal = {
  id: 'draft-1',
  kind: 'update',
  status: 'pending',
  title: 'Release checklist',
  description: 'Repeated release procedure',
  skillName: 'release',
  skillKey: 'release',
  createdAt: '',
  updatedAt: '',
  scanState: 'clean',
  revisionHash: revision,
};
const inspection = {
  record: {
    ...proposal,
    target: { skillName: 'release' },
    origin: { agentId: 'main' },
    scan: { state: 'clean', findings: [] },
  },
  revisionHash: revision,
  content: 'Complete proposed instructions\nFinal proposed line',
  currentContent: 'Complete current instructions\nFinal current line',
  supportFiles: [{ path: 'scripts/check.py', content: 'complete support contents' }],
};
const success = (value: unknown) => ({ success: true, value });

function setup() {
  const api = {
    list: vi.fn().mockResolvedValue(success([proposal])),
    inspect: vi.fn().mockResolvedValue(success(inspection)),
    decide: vi.fn().mockResolvedValue(success(undefined)),
  };
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { skillWorkshop: api },
  });
  const onSkillsChanged = vi.fn().mockResolvedValue(undefined);
  const mount = () => {
    const result = render(<SkillWorkshopPanel onSkillsChanged={onSkillsChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skill proposals' }));
    return result;
  };
  return { api, onSkillsChanged, mount };
}

beforeEach(() => {
  vi.clearAllMocks();
  i18nService.setLanguage('en', { persist: false });
});
afterEach(cleanup);

test('keeps pending decisions open and prevents duplicate writes', async () => {
  const fixture = setup();
  let finish!: (value: unknown) => void;
  fixture.api.decide.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  fixture.mount();
  fireEvent.click(await screen.findByRole('button', { name: /Release checklist/ }));
  const approve = await screen.findByRole('button', { name: 'Approve and apply' });
  fireEvent.click(approve);
  fireEvent.click(approve);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fixture.api.decide).toHaveBeenCalledOnce();
  await act(async () => finish(success(undefined)));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
});

test('shows full before/after instructions and support content, and binds approval to the reviewed revision', async () => {
  const fixture = setup();
  fixture.mount();
  await screen.findByRole('button', { name: /Release checklist/ });
  fireEvent.click(screen.getByRole('button', { name: /Release checklist/ }));
  expect(await screen.findByText(/Final proposed line/)).toBeTruthy();
  expect(screen.getByText(/Final current line/)).toBeTruthy();
  expect(screen.getByText('complete support contents')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve and apply' }));
  await waitFor(() =>
    expect(fixture.api.decide).toHaveBeenCalledWith({
      agentId: 'main',
      proposalId: 'draft-1',
      expectedRevisionHash: revision,
      action: 'apply',
    }),
  );
  await waitFor(() => expect(fixture.onSkillsChanged).toHaveBeenCalledOnce());
});

test('clears the inspected revision after an uncertain write and never replays it on refresh', async () => {
  const fixture = setup();
  fixture.api.decide.mockResolvedValue({ success: false, error: 'timeout' });
  fixture.mount();
  await screen.findByRole('button', { name: /Release checklist/ });
  fireEvent.click(screen.getByRole('button', { name: /Release checklist/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reject proposal' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('timeout'),
  );
  expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull();
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fixture.api.list.mock.calls.length).toBeGreaterThan(2));
  expect(fixture.api.decide).toHaveBeenCalledOnce();
});

test('disables approval when current instructions cannot be compared', async () => {
  const fixture = setup();
  fixture.api.inspect.mockResolvedValue(
    success({ ...inspection, currentContent: null, comparisonUnavailable: true }),
  );
  fixture.mount();
  await screen.findByRole('button', { name: /Release checklist/ });
  fireEvent.click(screen.getByRole('button', { name: /Release checklist/ }));
  const approve = await screen.findByRole('button', { name: 'Approve and apply' });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
});

test('recovers proposal states on remount and releases panel polling on unmount', async () => {
  const fixture = setup();
  const first = fixture.mount();
  await screen.findByRole('button', { name: /Release checklist/ });
  const clear = vi.spyOn(window, 'clearInterval');
  first.unmount();
  expect(clear).toHaveBeenCalled();
  fixture.api.list.mockResolvedValue(success([{ ...proposal, status: 'applied' }]));
  fixture.mount();
  await screen.findByRole('button', { name: /Release checklist/ });
  await screen.findByRole('button', { name: /Release checklist Applied/ });
  expect(fixture.api.decide).not.toHaveBeenCalled();
  clear.mockRestore();
});

test('loads only after opening and restores keyboard focus when closed', async () => {
  const fixture = setup();
  render(<SkillWorkshopPanel onSkillsChanged={fixture.onSkillsChanged} />);
  expect(fixture.api.list).not.toHaveBeenCalled();
  const launcher = screen.getByRole('button', { name: 'Skill proposals' });
  fireEvent.click(launcher);
  const dialog = screen.getByRole('dialog');
  await screen.findByRole('button', { name: /Release checklist/ });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(launcher);
});

test('clears the selected proposal when changing the status filter', async () => {
  const fixture = setup();
  fixture.mount();
  await screen.findByRole('button', { name: /Release checklist/ });
  fireEvent.click(screen.getByRole('button', { name: /Release checklist/ }));
  await screen.findByRole('button', { name: 'Approve and apply' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'applied' } });
  expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull();
  expect(fixture.api.decide).not.toHaveBeenCalled();
});

test('clears a transient read error after automatic recovery', async () => {
  const fixture = setup();
  fixture.api.list.mockResolvedValueOnce({ success: false, error: 'offline' });
  fixture.mount();
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('offline'),
  );
  fireEvent.focus(window);
  await screen.findByRole('button', { name: /Release checklist/ });
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each(['status', 'revision', 'removed'] as const)(
  'does not resurrect an inspection after a newer list changes its %s',
  async change => {
    const fixture = setup();
    let finish!: (value: unknown) => void;
    fixture.api.inspect.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    fixture.mount();
    fireEvent.click(await screen.findByRole('button', { name: /Release checklist/ }));
    fixture.api.list.mockResolvedValue(
      success(
        change === 'removed'
          ? []
          : [
              {
                ...proposal,
                ...(change === 'status' ? { status: 'applied' } : { revisionHash: 'b'.repeat(64) }),
              },
            ],
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await act(async () => finish(success(inspection)));
    expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull();
    expect(fixture.api.decide).not.toHaveBeenCalled();
  },
);

test('keeps keyboard focus in the dialog when a decision removes the focused button', async () => {
  const fixture = setup();
  let finish!: (value: unknown) => void;
  fixture.api.decide.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  fixture.mount();
  fireEvent.click(await screen.findByRole('button', { name: /Release checklist/ }));
  const approve = await screen.findByRole('button', { name: 'Approve and apply' });
  approve.focus();
  fireEvent.click(approve);
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'How to use' }));
  await act(async () => finish(success(undefined)));
});

test('discards an in-flight inspection when list refresh fails', async () => {
  const fixture = setup();
  let finish!: (value: unknown) => void;
  fixture.api.inspect.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  fixture.mount();
  fireEvent.click(await screen.findByRole('button', { name: /Release checklist/ }));
  fixture.api.list.mockResolvedValue({ success: false, error: 'offline' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert');
  await act(async () => finish(success(inspection)));
  expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull();
});

test('restores dialog focus when polling removes the focused detail', async () => {
  const fixture = setup();
  fixture.mount();
  fireEvent.click(await screen.findByRole('button', { name: /Release checklist/ }));
  (await screen.findByRole('button', { name: 'Approve and apply' })).focus();
  fixture.api.list.mockResolvedValue(success([{ ...proposal, status: 'applied' }]));
  fireEvent.focus(window);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull(),
  );
  expect(document.activeElement).toBe(screen.getByRole('dialog'));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
