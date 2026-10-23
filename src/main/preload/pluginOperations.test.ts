import { beforeEach, expect, test, vi } from 'vitest';

import { PluginKind } from '../../shared/plugins/marketplace';
import {
  PluginOperationAction,
  PluginOperationIpc,
  PluginOperationStage,
} from '../../shared/plugins/pluginOperation';

const ipc = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: ipc }));

import { createPluginOperationSubscription } from './pluginOperations';

beforeEach(() => vi.clearAllMocks());

test('shares one listener and releases it when the final consumer leaves', () => {
  const subscribe = createPluginOperationSubscription();
  const callback = vi.fn();
  const unsubscribeFirst = subscribe(callback);
  const unsubscribeSecond = subscribe(callback);
  expect(ipc.on).toHaveBeenCalledTimes(1);
  const event = {
    requestId: 'operation',
    kind: PluginKind.MCP,
    action: PluginOperationAction.ENABLE,
    stage: PluginOperationStage.CONFIRMING,
    elapsedMs: 100,
  };
  const handler = ipc.on.mock.calls[0][1];
  handler({}, event);
  expect(callback).toHaveBeenCalledTimes(2);
  unsubscribeFirst();
  unsubscribeFirst();
  expect(ipc.removeListener).not.toHaveBeenCalled();
  handler({}, event);
  expect(callback).toHaveBeenCalledTimes(3);
  unsubscribeSecond();
  expect(ipc.removeListener).toHaveBeenCalledWith(PluginOperationIpc.Progress, handler);
});

test('one broken consumer cannot prevent progress delivery to the remaining consumers', () => {
  const subscribe = createPluginOperationSubscription();
  subscribe(() => {
    throw new Error('view closed');
  });
  const callback = vi.fn();
  subscribe(callback);
  ipc.on.mock.calls[0][1]({}, { requestId: 'operation' });
  expect(callback).toHaveBeenCalledOnce();
});
