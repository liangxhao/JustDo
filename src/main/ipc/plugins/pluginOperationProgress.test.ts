import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';

import { PluginKind } from '../../../shared/plugins/marketplace';
import {
  PluginOperationAction,
  type PluginOperationContext,
  PluginOperationIpc,
  PluginOperationStage,
} from '../../../shared/plugins/pluginOperation';
import { createPluginOperationReporter } from './pluginOperationProgress';

afterEach(() => vi.restoreAllMocks());

test('sends bounded progress only to the invoking sender and stops after finish', () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  const reporter = createPluginOperationReporter(
    { sender } as unknown as IpcMainInvokeEvent,
    { requestId: 'operation-1' },
    PluginKind.MCP,
    PluginOperationAction.ENABLE,
  );
  now.mockReturnValue(350);
  reporter.report(PluginOperationStage.APPLYING_CONFIGURATION);
  expect(sender.send).toHaveBeenCalledWith(PluginOperationIpc.Progress, {
    requestId: 'operation-1',
    kind: PluginKind.MCP,
    action: PluginOperationAction.ENABLE,
    stage: PluginOperationStage.APPLYING_CONFIGURATION,
    elapsedMs: 250,
  });
  reporter.finish();
  reporter.report(PluginOperationStage.CONFIRMING);
  expect(sender.send).toHaveBeenCalledTimes(1);
});

test.each([null, {}, [], { requestId: '' }, { requestId: 'x'.repeat(129) }, { requestId: 'a\nb' }])(
  'rejects malformed operation context before starting work: %j',
  context => {
    expect(() =>
      createPluginOperationReporter(
        undefined,
        context as PluginOperationContext,
        PluginKind.SKILL,
        PluginOperationAction.INSTALL,
      ),
    ).toThrow('Invalid plugin operation request id');
  },
);

test('closing a sender or failing to deliver progress does not affect the mutation', () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const sender = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(() => {
      throw new Error('closed');
    }),
  };
  const reporter = createPluginOperationReporter(
    { sender } as unknown as IpcMainInvokeEvent,
    { requestId: 'operation-2' },
    PluginKind.HOOK,
    PluginOperationAction.REMOVE,
  );
  expect(() => reporter.report(PluginOperationStage.UNINSTALLING)).not.toThrow();
  sender.isDestroyed.mockReturnValue(true);
  reporter.report(PluginOperationStage.CLEANING_UP);
  expect(sender.send).toHaveBeenCalledTimes(1);
  reporter.finish();
});

test('callers without progress context retain the original behavior', () => {
  const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  const reporter = createPluginOperationReporter(
    { sender } as unknown as IpcMainInvokeEvent,
    undefined,
    PluginKind.EXTENSION,
    PluginOperationAction.DISABLE,
  );
  reporter.report(PluginOperationStage.DISABLING);
  reporter.finish();
  expect(sender.send).not.toHaveBeenCalled();
});

test('retains the failed business step through rollback and later inventory refresh', () => {
  const reporter = createPluginOperationReporter(
    undefined,
    undefined,
    PluginKind.MCP,
    PluginOperationAction.SAVE,
  );
  reporter.report(PluginOperationStage.APPLYING_CONFIGURATION);
  reporter.report(PluginOperationStage.ROLLING_BACK);
  reporter.report(PluginOperationStage.REFRESHING_INVENTORY);
  expect(reporter.result({ success: false, error: 'apply failed' })).toEqual({
    success: false,
    error: 'apply failed',
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
  });
});

test('explicit native failure classification takes precedence over a captured progress step', () => {
  const reporter = createPluginOperationReporter(
    undefined,
    undefined,
    PluginKind.EXTENSION,
    PluginOperationAction.INSTALL,
  );
  reporter.report(PluginOperationStage.INSTALLING);
  reporter.captureFailure();
  reporter.report(PluginOperationStage.CLEANING_UP);
  expect(
    reporter.result({ success: false, failedStage: PluginOperationStage.INSTALLING_DEPENDENCIES }),
  ).toMatchObject({
    failedStage: PluginOperationStage.INSTALLING_DEPENDENCIES,
  });
});

test('success and capability review do not acquire failure metadata', () => {
  const reporter = createPluginOperationReporter(
    undefined,
    undefined,
    PluginKind.EXTENSION,
    PluginOperationAction.ENABLE,
  );
  reporter.report(PluginOperationStage.VALIDATING);
  expect(reporter.result({ success: true })).toEqual({ success: true });
  const review = { success: false, capabilityReview: { id: 'review' } };
  expect(reporter.result(review)).toBe(review);
});

test('freezes a returned failure before cleanup without inferring an operation outcome', () => {
  const reporter = createPluginOperationReporter(
    undefined,
    undefined,
    PluginKind.EXTENSION,
    PluginOperationAction.REMOVE,
  );
  reporter.report(PluginOperationStage.UNINSTALLING);
  reporter.captureFailure();
  reporter.report(PluginOperationStage.REFRESHING_INVENTORY);
  expect(reporter.result({ success: false, operationUnconfirmed: true })).toEqual({
    success: false,
    operationUnconfirmed: true,
    failedStage: PluginOperationStage.UNINSTALLING,
  });
});
