// @vitest-environment jsdom
import { PluginKind } from '@shared/plugins/marketplace';
import {
  PluginOperationAction,
  type PluginOperationProgress,
  PluginOperationStage,
} from '@shared/plugins/pluginOperation';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import OperationResultModal from './OperationResultModal';
import PluginOperationFeedback from './PluginOperationFeedback';
import { getPluginOperationOwner } from './pluginOperationService';
import PluginOperationStatus from './PluginOperationStatus';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'pluginOperationElapsed' ? '{seconds}s elapsed' : key),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup() {
  let notify!: (progress: PluginOperationProgress) => void;
  const bridge = {
    plugins: {
      onOperationProgress: vi.fn((callback: typeof notify) => {
        notify = callback;
        return vi.fn();
      }),
    },
  };
  Object.defineProperty(window, 'electron', { configurable: true, value: bridge });
  return {
    owner: getPluginOperationOwner(bridge),
    notify: (progress: PluginOperationProgress) => notify(progress),
  };
}

const options = {
  kind: PluginKind.EXTENSION,
  action: PluginOperationAction.INSTALL,
  label: 'Library tool',
};

test('replaces running feedback with one result after final reconciliation and preserves its failure stage', () => {
  const { owner, notify } = setup();
  const operation = owner.start(options);
  render(
    <>
      <PluginOperationStatus />
      <PluginOperationFeedback />
    </>,
  );
  act(() => {
    notify({
      ...options,
      ...operation.context,
      stage: PluginOperationStage.ENABLING,
      elapsedMs: 2100,
    });
    operation.fail({
      message: 'Required configuration is missing',
      failedStage: PluginOperationStage.ENABLING,
      installationCommitted: true,
    });
    operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
  });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByText('pluginOperationStage.refreshing_inventory')).toBeTruthy();

  act(() => operation.finish());
  const dialog = screen.getByRole('alertdialog', {
    name: 'pluginOperationFailureTitle.committed',
  });
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  expect(screen.getByText('pluginOperationStageLabel.enabling')).toBeTruthy();
  expect(screen.getByText('Required configuration is missing')).toBeTruthy();
  expect(screen.queryByText('pluginOperationStage.refreshing_inventory')).toBeNull();
  expect(screen.getByText('pluginOperationFailureNext.committed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  expect(dialog.closest('[data-workspace-overlay]')?.className).toContain('z-[80]');
});

test('retains failures across category unmounts and dismisses only the displayed result', () => {
  const { owner } = setup();
  const view = render(<PluginOperationFeedback />);
  view.unmount();
  const first = owner.start(options);
  first.fail({ message: 'First failure' });
  first.finish();
  const second = owner.start({ ...options, label: 'Second tool' });
  second.fail({ message: 'Second failure', operationUnconfirmed: true });
  second.finish();

  render(<PluginOperationFeedback />);
  expect(screen.getByText('First failure')).toBeTruthy();
  expect(screen.queryByText('Second failure')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureDismiss' }));
  expect(
    screen.getByRole('alertdialog', { name: 'pluginOperationFailureTitle.unconfirmed' }),
  ).toBeTruthy();
  expect(screen.getByText('Second failure')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureDismiss' }));
  expect(owner.failureSnapshot()).toEqual([]);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('keeps long details collapsed and copies the original error, supplemental note and batch items', async () => {
  const { owner } = setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const operation = owner.start(options);
  operation.fail({
    message: 'Original native refusal\nMore information',
    details: 'Additional refresh failure',
    items: [
      {
        label: 'Another extension',
        message: 'Another package failed',
        failedStage: PluginOperationStage.CONFIRMING,
        installSourceInUse: true,
      },
    ],
  });
  operation.finish();
  render(<PluginOperationFeedback />);
  const details = screen.getByText('pluginOperationFailureDetails').closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.getByText('pluginOperationFailureItemUnconfirmed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureCopy' }));
  await waitFor(() => expect(screen.getByText('pluginOperationFailureCopied')).toBeTruthy());
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Original native refusal'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Additional refresh failure'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Another package failed'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining(operation.context.requestId));
});

test.each([true, false])('a batch only refers to its item stages when they exist (%s)', withStage => {
  const { owner } = setup();
  const operation = owner.start(options);
  operation.fail({
    message: 'One succeeded and one failed',
    items: [
      { label: 'Good package', message: 'Imported successfully', type: 'success' },
      {
        label: 'Invalid package', message: 'Native format was rejected', type: 'error',
        ...(withStage ? { failedStage: PluginOperationStage.VALIDATING } : {}),
      },
    ],
  });
  operation.finish();
  render(<PluginOperationFeedback />);
  expect(screen.getByText(withStage
    ? 'pluginOperationFailureStagesInItems' : 'pluginOperationFailureStageUnavailable')).toBeTruthy();
  expect(screen.queryByText(withStage
    ? 'pluginOperationFailureStageUnavailable' : 'pluginOperationFailureStagesInItems')).toBeNull();
  expect(screen.getByText('Imported successfully')).toBeTruthy();
  expect(screen.getByText('Native format was rejected')).toBeTruthy();
  if (withStage) expect(screen.getByText(/pluginOperationStageLabel.validating/)).toBeTruthy();
});

test('a clipboard failure retains the error dialog and reports how to copy manually', async () => {
  const { owner } = setup();
  const writeText = vi.fn().mockRejectedValue(new Error('Clipboard unavailable'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const operation = owner.start(options);
  operation.fail({ message: 'A failed operation' });
  operation.finish();
  render(<PluginOperationFeedback />);

  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureCopy' }));
  await waitFor(() => expect(screen.getByText('pluginOperationFailureCopyFailed')).toBeTruthy());
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(owner.failureSnapshot()).toHaveLength(1);
});

test('Escape closes only the top error and restores an underlying editor without changing its input', () => {
  const { owner } = setup();
  render(<input aria-label="Unsaved configuration" defaultValue="keep this value" />);
  const input = screen.getByRole('textbox');
  input.focus();
  const underlyingEscape = vi.fn();
  document.addEventListener('keydown', underlyingEscape, true);
  const operation = owner.start(options);
  operation.fail({ message: 'Save was refused' });
  operation.finish();
  render(<PluginOperationFeedback />);
  const dismiss = screen.getByRole('button', { name: 'pluginOperationFailureDismiss' });
  expect(document.activeElement).toBe(dismiss);

  fireEvent.keyDown(dismiss, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'close' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(dismiss);
  fireEvent.keyDown(dismiss, { key: 'Escape' });
  expect(underlyingEscape).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe('keep this value');
  document.removeEventListener('keydown', underlyingEscape, true);
});

test('keeps legacy successful and partially successful batch results compatible', () => {
  render(
    <OperationResultModal
      result={{
        type: 'error',
        title: 'Some imports were incomplete',
        message: 'One imported; one failed',
        items: [
          { label: 'Good package', message: 'Imported successfully', type: 'success' },
          {
            label: 'Saved package',
            message: 'Enabling refused',
            failedStage: PluginOperationStage.ENABLING,
            installationCommitted: true,
          },
        ],
      }}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole('alertdialog', { name: 'Some imports were incomplete' })).toBeTruthy();
  expect(screen.getByText('Imported successfully')).toBeTruthy();
  expect(screen.getByText('pluginOperationFailureItemCommitted')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'confirm' })).toBeTruthy();
});

test('a later legacy result cannot take keyboard ownership from the higher error layer', () => {
  const { owner } = setup();
  const operation = owner.start(options);
  operation.fail({ message: 'Visible top failure' });
  operation.finish();
  render(<PluginOperationFeedback />);
  const dismiss = screen.getByRole('button', { name: 'pluginOperationFailureDismiss' });
  const closeLegacy = vi.fn();
  render(
    <OperationResultModal
      result={{ type: 'success', title: 'Another operation completed' }}
      onClose={closeLegacy}
    />,
  );
  expect(document.activeElement).toBe(dismiss);
  fireEvent.keyDown(dismiss, { key: 'Escape' });
  expect(closeLegacy).not.toHaveBeenCalled();
  expect(owner.failureSnapshot()).toEqual([]);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'confirm' }));
});
