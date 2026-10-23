// @vitest-environment jsdom
import { PluginKind } from '@shared/plugins/marketplace';
import {
  PluginOperationAction,
  type PluginOperationProgress,
  PluginOperationStage,
} from '@shared/plugins/pluginOperation';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import {
  getPluginOperationOwner,
  reportPluginOperationFailure,
  runPluginOperation,
} from './pluginOperationService';
import PluginOperationStatus from './PluginOperationStatus';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'pluginOperationElapsed' ? '{seconds}s elapsed' : key),
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  let notify!: (progress: PluginOperationProgress) => void;
  const unsubscribe = vi.fn();
  const bridge = {
    plugins: {
      onOperationProgress: vi.fn((callback: typeof notify) => {
        notify = callback;
        return unsubscribe;
      }),
    },
  };
  Object.defineProperty(window, 'electron', { configurable: true, value: bridge });
  return {
    owner: getPluginOperationOwner(bridge),
    notify: (progress: PluginOperationProgress) => notify(progress),
    unsubscribe,
    bridge,
  };
}

const options = {
  kind: PluginKind.EXTENSION,
  action: PluginOperationAction.INSTALL,
  label: 'Diagram editor',
};

test('accepts only matching request, kind and action progress', () => {
  const { owner, notify } = setup();
  const operation = owner.start(options);
  const progress = {
    ...operation.context,
    kind: options.kind,
    action: options.action,
    stage: PluginOperationStage.INSTALLING,
    elapsedMs: 1234,
  };
  notify({ ...progress, requestId: 'another-request' });
  notify({ ...progress, action: PluginOperationAction.REMOVE });
  notify({ ...progress, kind: PluginKind.SKILL });
  expect(owner.snapshot()[0].stage).toBe(PluginOperationStage.QUEUED);

  notify(progress);
  expect(owner.snapshot()[0]).toMatchObject({
    stage: PluginOperationStage.INSTALLING,
    elapsedMs: 1234,
  });
  operation.finish();
});

test('retains active operations across subscribers and ignores late completion notifications', () => {
  const { owner, notify, unsubscribe } = setup();
  const operation = owner.start(options);
  const detach = owner.subscribe(vi.fn());
  detach();
  expect(owner.snapshot()).toHaveLength(1);
  expect(unsubscribe).not.toHaveBeenCalled();

  operation.finish();
  notify({
    ...operation.context,
    ...options,
    stage: PluginOperationStage.INSTALLING,
    elapsedMs: 2000,
  });
  expect(owner.snapshot()).toEqual([]);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

test('releases feedback when a mutation rejects without converting it to success', async () => {
  const { owner, unsubscribe } = setup();
  await expect(
    runPluginOperation(options, async () => {
      expect(owner.snapshot()).toHaveLength(1);
      throw new Error('Installation outcome unknown');
    }),
  ).rejects.toThrow('Installation outcome unknown');
  expect(owner.snapshot()).toEqual([]);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

test('broken feedback consumers and cleanup cannot alter an admitted mutation result', async () => {
  const { owner, unsubscribe } = setup();
  owner.subscribe(() => {
    throw new Error('view closed');
  });
  unsubscribe.mockImplementation(() => {
    throw new Error('window destroyed');
  });
  await expect(runPluginOperation(options, async () => ({ success: true }))).resolves.toEqual({
    success: true,
  });
  expect(owner.snapshot()).toEqual([]);
});

test('a failed progress subscription retains local feedback while executing the mutation', async () => {
  const { owner, bridge } = setup();
  bridge.plugins.onOperationProgress.mockImplementation(() => {
    throw new Error('subscription unavailable');
  });
  await expect(
    runPluginOperation(options, async () => {
      expect(owner.snapshot()).toHaveLength(1);
      return 'committed';
    }),
  ).resolves.toBe('committed');
  expect(owner.snapshot()).toEqual([]);
});

test('shows real stages above dialogs, keeps them across remounts and advances only elapsed time', () => {
  vi.useFakeTimers();
  const { owner, notify } = setup();
  const operation = owner.start(options);
  const view = render(<PluginOperationStatus />);
  act(() =>
    notify({
      ...operation.context,
      ...options,
      stage: PluginOperationStage.INSTALLING_DEPENDENCIES,
      elapsedMs: 0,
    }),
  );
  expect(screen.getByText('Diagram editor')).toBeTruthy();
  expect(screen.getByText('pluginOperationStage.installing_dependencies')).toBeTruthy();
  act(() => vi.advanceTimersByTime(12000));
  expect(screen.getByText('12s elapsed')).toBeTruthy();
  expect(screen.queryByText('pluginOperationStage.confirming')).toBeNull();

  view.unmount();
  render(<PluginOperationStatus />);
  expect(screen.getByText('pluginOperationStage.installing_dependencies')).toBeTruthy();
  act(() => operation.finish());
  expect(screen.queryByText('Diagram editor')).toBeNull();
});

test('publishes a frozen failure only after mutation reconciliation finishes', () => {
  const { owner, notify } = setup();
  const operation = owner.start(options);
  operation.fail({
    message: 'Activation refused',
    failedStage: PluginOperationStage.ENABLING,
    installationCommitted: true,
  });
  expect(owner.failureSnapshot()).toEqual([]);
  expect(owner.snapshot()).toHaveLength(1);
  notify({
    ...operation.context,
    ...options,
    stage: PluginOperationStage.REFRESHING_INVENTORY,
    elapsedMs: 500,
  });
  operation.fail({ message: 'A later wrapper error' });
  operation.finish();
  expect(owner.snapshot()).toEqual([]);
  expect(owner.failureSnapshot()).toEqual([
    expect.objectContaining({
      ...operation.context,
      ...options,
      message: 'Activation refused',
      failedStage: PluginOperationStage.ENABLING,
      state: 'committed',
    }),
  ]);
});

test('retains failures without a mounted view and queues concurrent results once', () => {
  const { owner } = setup();
  const first = owner.start(options);
  const second = owner.start({ ...options, label: 'Second plugin' });
  first.fail({ message: 'First failed' });
  second.fail({ message: 'Second failed' });
  second.finish();
  first.finish();
  first.finish();
  first.fail({ message: 'Too late' });
  expect(owner.failureSnapshot().map(failure => failure.message)).toEqual([
    'Second failed',
    'First failed',
  ]);
  owner.dismissFailure(second.context.requestId);
  expect(owner.failureSnapshot()).toHaveLength(1);
  expect(owner.failureSnapshot()[0].requestId).toBe(first.context.requestId);
});

test('does not infer uncertainty, commitment or failure stages from progress or error words', () => {
  const { owner } = setup();
  const operation = owner.start(options);
  operation.stage(PluginOperationStage.CLEANING_UP);
  operation.fail({ message: 'Install committed but outcome unknown' });
  operation.finish();
  expect(owner.failureSnapshot()[0]).toMatchObject({ state: 'failed' });
  expect(owner.failureSnapshot()[0].failedStage).toBeUndefined();
});

test.each([{ installSourceInUse: true as const }, { operationUnconfirmed: true as const }])(
  'requires explicit uncertainty metadata for an unconfirmed result: %j',
  metadata => {
    const { owner } = setup();
    const operation = owner.start(options);
    operation.fail({ message: 'Status is unavailable', ...metadata });
    operation.finish();
    expect(owner.failureSnapshot()[0].state).toBe('unconfirmed');
  },
);

test('adds a refresh warning to the original failure without replacing its stage or outcome', () => {
  const { owner } = setup();
  const operation = owner.start(options);
  operation.fail({
    message: 'Configuration rejected',
    failedStage: PluginOperationStage.VALIDATING,
  });
  operation.fail({ message: 'Status refresh failed', state: 'refresh_failed' });
  operation.finish();
  expect(owner.failureSnapshot()).toHaveLength(1);
  expect(owner.failureSnapshot()[0]).toMatchObject({
    message: 'Configuration rejected',
    failedStage: PluginOperationStage.VALIDATING,
    details: 'Status refresh failed',
    state: 'failed',
  });
});

test('redacts error details before retaining them, including batch items', () => {
  const { owner } = setup();
  reportPluginOperationFailure(options, {
    message: 'Authorization: Bearer private-value',
    details: 'https://operator:password@internal.example/config?token=private-value',
    items: [{ label: 'skill', message: 'api_key=secret-value', installationCommitted: true }],
  });
  const serialized = JSON.stringify(owner.failureSnapshot());
  expect(serialized).not.toContain('private-value');
  expect(serialized).not.toContain('operator:password');
  expect(serialized).not.toContain('secret-value');
  expect(owner.failureSnapshot()[0].items?.[0].installationCommitted).toBe(true);
});

test('a failed result subscriber cannot replace a mutation result or interrupt cleanup', async () => {
  const { owner, unsubscribe } = setup();
  owner.subscribeFailures(() => {
    throw new Error('View destroyed');
  });
  const operation = owner.start(options);
  operation.fail({ message: 'Failed' });
  expect(() => operation.finish()).not.toThrow();
  expect(owner.failureSnapshot()).toHaveLength(1);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
