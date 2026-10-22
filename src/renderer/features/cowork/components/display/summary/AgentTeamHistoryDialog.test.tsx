// @vitest-environment jsdom
import type { TeamDiscussionRoom } from '@shared/cowork/agent-team/teamDiscussion';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import type { AgentTeamHistoryEntry } from './agentTeamHistory';
import AgentTeamHistoryDialog from './AgentTeamHistoryDialog';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));
vi.mock('react-redux', () => ({
  useSelector: (select: (state: unknown) => unknown) =>
    select({ cowork: { sessions: [] }, agent: { agents: [] } }),
}));
const rooms = [
  { id: 'linked', title: 'Linked group', sourceSessionId: 'source', members: [] },
  { id: 'orphan', title: 'Retained group', sourceSessionId: 'deleted', members: [] },
  { id: 'standalone', title: 'Independent group', members: [] },
] as unknown as TeamDiscussionRoom[];
const list = vi.fn();
beforeEach(() => {
  list.mockReset().mockResolvedValue({ success: true, value: rooms });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      teamDiscussion: { list },
      collaboration: { list: vi.fn(async () => ({ success: true, value: [] })) },
    },
  });
});
afterEach(cleanup);

it('browses every native room using only metadata and opens its exact identity', async () => {
  const open = vi.fn(async (_room: AgentTeamHistoryEntry, _isCurrent: () => boolean) => {});
  render(<AgentTeamHistoryDialog onOpen={open} onClose={vi.fn()} />);
  expect(await screen.findByRole('button', { name: /Linked group/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Retained group/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Independent group/ }));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ discussion: rooms[2], key: 'group:standalone' }),
    expect.any(Function),
  );
  expect(open.mock.calls[0][1]()).toBe(true);
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {});
});

it.each(['close', 'unmount'])('invalidates delayed navigation on %s', async action => {
  let isCurrent!: () => boolean;
  let finish!: () => void;
  const open = vi.fn(async (_room: AgentTeamHistoryEntry, current: () => boolean) => {
    isCurrent = current;
    await new Promise<void>(resolve => {
      finish = resolve;
    });
  });
  const onClose = vi.fn();
  const view = render(<AgentTeamHistoryDialog onOpen={open} onClose={onClose} />);
  fireEvent.click(await screen.findByRole('button', { name: /Retained group/ }));
  expect(isCurrent()).toBe(true);
  if (action === 'unmount') view.unmount();
  else fireEvent.click(screen.getByRole('button', { name: 'close' }));
  expect(isCurrent()).toBe(false);
  await act(async () => {
    finish();
  });
  if (action === 'close') expect(onClose).toHaveBeenCalledTimes(1);
});

it('keeps the history picker available when guarded navigation does not proceed', async () => {
  const open = vi.fn(async () => {});
  const close = vi.fn();
  render(<AgentTeamHistoryDialog onOpen={open} onClose={close} />);
  const room = await screen.findByRole('button', { name: /Linked group/ });
  await act(async () => {
    fireEvent.click(room);
  });
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect((room as HTMLButtonElement).disabled).toBe(false);
});

it('reports unavailable metadata rather than presenting an empty history', async () => {
  list.mockResolvedValue({ success: false, error: 'teamDiscussionUnavailable' });
  render(<AgentTeamHistoryDialog onOpen={vi.fn()} onClose={vi.fn()} />);
  expect((await screen.findByRole('alert')).textContent).toContain('teamRecordsUnavailable');
  expect(screen.queryByText('teamHistoryEmpty')).toBeNull();
});

it('portals and traps focus in the detached owner document', async () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const owner = frame.contentDocument!;
  const container = owner.createElement('div');
  owner.body.append(container);
  const view = render(
    <OwnerDocumentContext.Provider value={owner}>
      <AgentTeamHistoryDialog onOpen={vi.fn()} onClose={vi.fn()} />
    </OwnerDocumentContext.Provider>,
    { container },
  );
  await act(async () => {});
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const dialog = owner.querySelector<HTMLElement>('[role="dialog"]')!;
  const buttons = dialog.querySelectorAll('button');
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(owner.activeElement).toBe(buttons[0]);
  fireEvent.keyDown(buttons[0], { key: 'Tab', shiftKey: true });
  expect(owner.activeElement).toBe(buttons[buttons.length - 1]);
  view.unmount();
  frame.remove();
});

it('lists historical collaboration batches alongside discussions and filters by mode and member', async () => {
  vi.mocked(window.electron.collaboration.list).mockResolvedValue({
    success: true,
    value: [
      {
        id: 'team',
        anchorSessionId: 'source',
        members: [{ agentId: 'research', sessionId: 'member', sessionKey: 'key' }],
        rounds: [
          { id: 'old', state: 'settled', pending: 0 },
          { id: 'new', state: 'open', pending: 1 },
        ],
      },
    ],
  });
  const open = vi.fn(async () => {});
  render(<AgentTeamHistoryDialog onOpen={open} onClose={vi.fn()} />);
  const old = await screen.findByRole('button', { name: /teamTask · 1/ });
  expect(screen.getByRole('button', { name: /Retained group/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^teamTask2$/ }));
  expect(screen.queryByRole('button', { name: /Retained group/ })).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'research' } });
  expect(screen.getByRole('button', { name: /teamTask · 1/ })).toBeTruthy();
  await act(async () => {
    fireEvent.click(old);
  });
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'task:team:old', sourceSessionId: 'source' }),
    expect.any(Function),
  );
});

it('retains available groups and reports incomplete records when collaboration metadata fails', async () => {
  vi.mocked(window.electron.collaboration.list).mockRejectedValue(new Error('offline'));
  render(<AgentTeamHistoryDialog onOpen={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByRole('button', { name: /Retained group/ })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('teamRecordsUnavailable');
});
