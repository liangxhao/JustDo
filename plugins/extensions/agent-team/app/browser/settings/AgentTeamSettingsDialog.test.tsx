// @vitest-environment jsdom
import { defaultAgentTeamSettings } from '../../contracts/agentTeamSettings';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import AgentTeamSettingsDialog from './AgentTeamSettingsDialog';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
const api = { read: vi.fn(), save: vi.fn(), readTeam: vi.fn(), saveTeam: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  api.read.mockResolvedValue({
    success: true,
    value: { version: 1, revision: 3, value: defaultAgentTeamSettings() },
  });
  api.save.mockResolvedValue({ success: true });
  api.readTeam.mockResolvedValue({
    success: true,
    value: {
      global: { version: 1, revision: 3, value: defaultAgentTeamSettings() },
      team: { revision: 5, value: {} },
      memberCount: 3,
    },
  });
  api.saveTeam.mockResolvedValue({ success: true });
  vi.stubGlobal('electron', { agentTeamSettings: api });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
});

it('keeps the modal, focus trap and restored focus in the detached team document', async () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const ownerDocument = frame.contentDocument!;
  const previous = ownerDocument.createElement('button');
  ownerDocument.body.append(previous);
  previous.focus();
  const close = vi.fn();
  const view = render(
    <OwnerDocumentContext.Provider value={ownerDocument}>
      <AgentTeamSettingsDialog team={{ kind: 'discussion', roomId: 'group' }} onClose={close} />
    </OwnerDocumentContext.Provider>,
  );
  const host = within(ownerDocument.body);
  const dialog = host.getByRole('dialog');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(ownerDocument.activeElement).toBe(dialog);
  const concurrency = await host.findByLabelText('agentTeamConcurrency');
  const reset = host.getByRole('button', { name: 'agentTeamResetInherit' });
  const save = host.getByRole('button', { name: 'save' });
  save.focus();
  fireEvent.keyDown(save, { key: 'Tab' });
  expect(ownerDocument.activeElement).toBe(host.getByRole('button', { name: 'close' }));
  fireEvent.keyDown(ownerDocument.activeElement!, { key: 'Tab', shiftKey: true });
  expect(ownerDocument.activeElement).toBe(save);
  fireEvent.change(concurrency, { target: { value: '1' } });
  fireEvent.click(save);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api.saveTeam).toHaveBeenCalledWith('discussion', 'group', { maxConcurrent: 1 }, 5);
  expect(reset.ownerDocument).toBe(ownerDocument);
  view.unmount();
  expect(ownerDocument.activeElement).toBe(previous);
});
it('edits defaults without enabling any extension and cancelling does not persist', async () => {
  const close = vi.fn();
  render(<AgentTeamSettingsDialog onClose={close} />);
  await screen.findByLabelText('agentTeamConcurrency');
  fireEvent.change(screen.getByLabelText('agentTeamConcurrency'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
  expect(close).toHaveBeenCalledOnce();
  expect(api.save).not.toHaveBeenCalled();
});
it('validates cross-field rounds and saves only explicitly reviewed drafts', async () => {
  const close = vi.fn();
  render(<AgentTeamSettingsDialog onClose={close} />);
  await screen.findByLabelText('agentTeamConcurrency');
  fireEvent.change(screen.getByLabelText('agentTeamMaxRounds'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'save' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'agentTeamSettingsRoundsConflict',
  );
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('agentTeamDefaultRounds'), { target: { value: '1' } });
  const organizer = screen.getByRole('switch', { name: 'agentTeamOrganizerDefault' });
  expect(organizer.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(organizer);
  expect(organizer.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'save' }));
  await waitFor(() =>
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({
        discussion: expect.objectContaining({
          defaultRounds: 1,
          maxRounds: 1,
          organizerParticipates: true,
        }),
      }),
      3,
    ),
  );
  expect(close).toHaveBeenCalledOnce();
});
it('saves room inheritance separately and keeps a stale-write conflict visible', async () => {
  const close = vi.fn();
  api.saveTeam.mockResolvedValue({ success: false, error: 'agentTeamSettingsConflict' });
  render(
    <AgentTeamSettingsDialog team={{ kind: 'discussion', roomId: 'group' }} onClose={close} />,
  );
  const concurrency = await screen.findByLabelText('agentTeamConcurrency');
  fireEvent.change(concurrency, { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'save' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'agentTeamSettingsConflict',
  );
  expect(api.saveTeam).toHaveBeenCalledWith('discussion', 'group', { maxConcurrent: 1 }, 5);
  expect(close).not.toHaveBeenCalled();
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'agentTeamResetInherit' }));
  expect((concurrency as HTMLSelectElement).value).toBe('');
});
