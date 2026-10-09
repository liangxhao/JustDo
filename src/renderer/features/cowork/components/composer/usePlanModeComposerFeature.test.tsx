// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import ComposerFeatureMenu from './ComposerFeatureMenu';
import { buildComposerFeatures } from './composerFeatures';
import PlanModeBadge from './PlanModeBadge';
import { usePlanModeComposerFeature } from './usePlanModeComposerFeature';

const mocks = vi.hoisted(() => ({ setPlanMode: vi.fn() }));

vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: { setPlanMode: mocks.setPlanMode },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

const defaultProps = { enabled: false, disabled: false, runActive: false };

function PlanMenu(props: Parameters<typeof usePlanModeComposerFeature>[0]) {
  const feature = usePlanModeComposerFeature(props);
  const items = buildComposerFeatures([feature], {
    loaded: false,
    enabled: new Map(),
    disabledRevisions: new Map(),
  });
  return (
    <>
      <ComposerFeatureMenu
        label="composerFeatures"
        items={items}
        disabled={items.every(item => item.disabled)}
      />
      {feature.selected && (
        <PlanModeBadge disabled={feature.disabled} onRemove={feature.onSelect} />
      )}
    </>
  );
}

const selectPlanMode = () => {
  fireEvent.click(screen.getByRole('button', { name: 'composerFeatures' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'planModeTitle' }));
};

describe('Plan mode composer feature', () => {
  beforeEach(() => {
    mocks.setPlanMode.mockReset().mockResolvedValue(true);
  });
  afterEach(cleanup);

  test.each([undefined, 'session-1', 'temp-1'])(
    'enables Plan from the plus menu for %s without requiring an enabled plugin',
    async sessionId => {
      render(<PlanMenu {...defaultProps} sessionId={sessionId} />);
      selectPlanMode();

      await waitFor(() => expect(mocks.setPlanMode).toHaveBeenCalledWith(sessionId, true));
      expect(screen.queryByRole('menu')).toBeNull();
    },
  );

  test('marks an enabled Plan mode and lets the same menu entry turn it off', async () => {
    const { result } = renderHook(usePlanModeComposerFeature, {
      initialProps: { ...defaultProps, sessionId: 'session-1', enabled: true },
    });
    expect(result.current.selected).toBe(true);
    await act(async () => result.current.onSelect());

    expect(mocks.setPlanMode).toHaveBeenCalledWith('session-1', false);
  });

  test('shows the Plan badge after enabling and removes it when the close button exits the mode', async () => {
    const view = render(<PlanMenu {...defaultProps} sessionId="session-1" />);
    expect(screen.queryByRole('button', { name: 'planModeExit' })).toBeNull();
    selectPlanMode();
    await waitFor(() => expect(mocks.setPlanMode).toHaveBeenCalledWith('session-1', true));

    view.rerender(<PlanMenu {...defaultProps} enabled sessionId="session-1" />);
    expect(screen.getByText('planModeBadgeLabel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'planModeExit' }));
    await waitFor(() => expect(mocks.setPlanMode).toHaveBeenLastCalledWith('session-1', false));

    view.rerender(<PlanMenu {...defaultProps} sessionId="session-1" />);
    expect(screen.queryByRole('button', { name: 'planModeExit' })).toBeNull();
  });

  test('allows the badge to cancel Plan mode even when a run or review disables ordinary input', async () => {
    render(<PlanMenu enabled disabled runActive sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'planModeExit' }));

    await waitFor(() => expect(mocks.setPlanMode).toHaveBeenCalledWith('session-1', false));
  });

  test('keeps the badge visible and retryable when cancelling Plan mode fails', async () => {
    mocks.setPlanMode.mockResolvedValueOnce(false);
    render(<PlanMenu {...defaultProps} enabled sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'planModeExit' }));

    await waitFor(() => {
      expect(mocks.setPlanMode).toHaveBeenCalledOnce();
      expect(
        (screen.getByRole('button', { name: 'planModeExit' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'planModeExit' }));
    await waitFor(() => expect(mocks.setPlanMode).toHaveBeenCalledTimes(2));
  });

  test('keeps the plus menu available to leave Plan mode during a run or disabled Plan review', async () => {
    render(<PlanMenu enabled disabled runActive sessionId="session-1" />);
    selectPlanMode();

    await waitFor(() => expect(mocks.setPlanMode).toHaveBeenCalledWith('session-1', false));
  });

  test.each([{ runActive: true }, { disabled: true }])(
    'does not enable Plan while unavailable: %j',
    async unavailable => {
      const { result } = renderHook(usePlanModeComposerFeature, {
        initialProps: { ...defaultProps, ...unavailable },
      });
      expect(result.current.disabled).toBe(true);
      await act(async () => result.current.onSelect());
      expect(mocks.setPlanMode).not.toHaveBeenCalled();
    },
  );

  test.each(['rejected', 'throw'])(
    'reports a %s update without changing the selected state',
    async failure => {
      if (failure === 'throw')
        mocks.setPlanMode.mockRejectedValue(new Error('Gateway unavailable'));
      else mocks.setPlanMode.mockResolvedValue(false);
      const toast = vi.fn();
      window.addEventListener('app:showToast', toast);
      try {
        const { result } = renderHook(usePlanModeComposerFeature, {
          initialProps: { ...defaultProps, enabled: true },
        });
        await act(async () => result.current.onSelect());

        expect(toast).toHaveBeenCalledOnce();
        expect((toast.mock.calls[0][0] as CustomEvent).detail).toBe('planModeSaveFailed');
        expect(result.current.selected).toBe(true);
        expect(result.current.disabled).toBe(false);
      } finally {
        window.removeEventListener('app:showToast', toast);
      }
    },
  );

  test('does not submit another toggle while the first save is pending', async () => {
    let resolve!: (success: boolean) => void;
    mocks.setPlanMode.mockReturnValue(
      new Promise<boolean>(done => {
        resolve = done;
      }),
    );
    const { result } = renderHook(usePlanModeComposerFeature, { initialProps: defaultProps });

    act(() => {
      result.current.onSelect();
      result.current.onSelect();
    });
    expect(mocks.setPlanMode).toHaveBeenCalledOnce();
    expect(result.current.disabled).toBe(true);
    await act(async () => resolve(true));
    expect(result.current.disabled).toBe(false);
  });
});
