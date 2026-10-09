// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import PermissionModeSelector from './PermissionModeSelector';

const mocks = vi.hoisted(() => ({
  state: {
    cowork: {
      config: { permissionMode: 'ask' },
      currentSession: null as { id: string; permissionMode: 'ask' | 'auto' | 'full' } | null,
      newSessionPlanMode: false,
      planModeBySession: {} as Record<string, boolean>,
    },
  },
  setPlanMode: vi.fn(),
  updatePermissionMode: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}));

vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: {
    setPlanMode: mocks.setPlanMode,
    updatePermissionMode: mocks.updatePermissionMode,
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

const openSelector = () =>
  fireEvent.click(screen.getByRole('button', { name: 'permissionModeTitle' }));

describe('PermissionModeSelector', () => {
  beforeEach(() => {
    mocks.state.cowork.config.permissionMode = 'ask';
    mocks.state.cowork.currentSession = null;
    mocks.state.cowork.newSessionPlanMode = false;
    mocks.state.cowork.planModeBySession = {};
    mocks.setPlanMode.mockReset().mockResolvedValue(true);
    mocks.updatePermissionMode.mockReset().mockResolvedValue({ success: true });
  });

  afterEach(cleanup);

  test('offers only execution permissions without a Plan entry', () => {
    render(<PermissionModeSelector />);
    openSelector();

    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'permissionModeAskpermissionModeAskDescription',
      'permissionModeAutopermissionModeAutoDescription',
      'permissionModeFullpermissionModeFullDescription',
    ]);
    expect(screen.queryByText('planModeTitle')).toBeNull();
    expect(mocks.setPlanMode).not.toHaveBeenCalled();
    expect(mocks.updatePermissionMode).not.toHaveBeenCalled();
  });

  test('changing permissions leaves the independently selected Plan mode intact', async () => {
    mocks.state.cowork.currentSession = { id: 'session-1', permissionMode: 'ask' };
    mocks.state.cowork.planModeBySession = { 'session-1': true };
    render(<PermissionModeSelector />);
    openSelector();

    fireEvent.click(screen.getByText('permissionModeAuto').closest('button')!);

    await waitFor(() => expect(mocks.updatePermissionMode).toHaveBeenCalledWith('auto'));
    expect(mocks.setPlanMode).not.toHaveBeenCalled();
    expect(screen.queryByText('planModeTitle')).toBeNull();
  });

  test('closes the menu without saving when selecting the current permission', () => {
    render(<PermissionModeSelector />);
    openSelector();

    fireEvent.click(
      screen.getByRole('option', { name: 'permissionModeAskpermissionModeAskDescription' }),
    );

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(mocks.setPlanMode).not.toHaveBeenCalled();
    expect(mocks.updatePermissionMode).not.toHaveBeenCalled();
  });

  test('shows permission save failures without changing Plan mode', async () => {
    mocks.state.cowork.currentSession = { id: 'session-1', permissionMode: 'ask' };
    mocks.state.cowork.planModeBySession = { 'session-1': true };
    mocks.updatePermissionMode.mockResolvedValue({ success: false, error: 'save failed' });
    render(<PermissionModeSelector />);
    openSelector();

    fireEvent.click(screen.getByText('permissionModeAuto').closest('button')!);

    await waitFor(() => expect(screen.getByText('save failed')).toBeTruthy());
    expect(mocks.setPlanMode).not.toHaveBeenCalled();
    expect(mocks.updatePermissionMode).toHaveBeenCalledWith('auto');
  });

  test('requires confirmation before granting full access', async () => {
    render(<PermissionModeSelector />);

    openSelector();
    fireEvent.click(screen.getByText('permissionModeFull').closest('button')!);
    expect(mocks.updatePermissionMode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'permissionModeFullConfirmAction' }));

    await waitFor(() => expect(mocks.updatePermissionMode).toHaveBeenCalledWith('full'));
    expect(mocks.setPlanMode).not.toHaveBeenCalled();
  });

  test('keeps the permission selector disabled during Plan review', () => {
    mocks.state.cowork.currentSession = { id: 'session-1', permissionMode: 'ask' };
    mocks.state.cowork.planModeBySession = { 'session-1': true };
    render(<PermissionModeSelector disabled />);

    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.setPlanMode).not.toHaveBeenCalled();
  });
});
