import { beforeEach, expect, test, vi } from 'vitest';

import { AppInitializationIpc, AppInitializationPhase } from '../../../shared/app/initialization';
import { StartupRoute } from '../../../shared/app/startup/routing';
import { AppInitialization } from './appInitialization';
import { registerAppInitializationHandlers } from './initializationIpc';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({ app: { relaunch: vi.fn(), quit: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } }));
beforeEach(() => handlers.clear());

const pending = { requestId: '12345678-1234-4234-8234-123456789abc',
  source: { appVersion: '2.0.0', runtimeVersion: '2026.10.7' },
  target: { appVersion: '1.0.0', runtimeVersion: '2026.10.6' } };
function fixture() {
  const initialization = new AppInitialization('unused-in-memory', StartupRoute.Upgrade, vi.fn());
  initialization.setDowngradeConfirmation(pending);
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  const confirm = vi.fn(() => true);
  const canConfirm = vi.fn(() => true);
  registerAppInitializationHandlers(initialization, {
    getWindow: () => window as never, canConfirm, confirm,
  });
  const event = { sender: webContents, senderFrame: mainFrame };
  const invoke = (input: unknown = { requestId: pending.requestId }, sender: unknown = event) =>
    handlers.get(AppInitializationIpc.ConfirmDowngrade)!(sender, input);
  return { initialization, event, invoke, confirm, canConfirm, window };
}

test('only a current trusted main-frame click consumes a pending confirmation once', () => {
  const f = fixture();
  expect(f.invoke()).toEqual({ confirmed: true });
  expect(f.confirm).toHaveBeenCalledExactlyOnceWith(pending.requestId);
  expect(f.initialization.getState().downgradeConfirmation).toBeUndefined();
  expect(f.initialization.getState().phase).toBe(AppInitializationPhase.Preparing);
  expect(f.invoke()).toEqual({ confirmed: false });
  expect(f.confirm).toHaveBeenCalledOnce();
});

test.each([null, [], {}, { requestId: '' }, { requestId: 'a'.repeat(36) },
  { requestId: pending.requestId, target: 'different' }])('rejects malformed or stale payloads: %j', input => {
  const f = fixture();
  expect(f.invoke(input)).toEqual({ confirmed: false });
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.initialization.getState().downgradeConfirmation).toEqual(pending);
});

test.each(['other-window', 'subframe', 'destroyed', 'quitting', 'failed', 'stale-owner'])
('does not delegate confirmation for %s', reason => {
  const f = fixture();
  let event: unknown = f.event;
  if (reason === 'other-window') event = { ...f.event, sender: { mainFrame: f.event.senderFrame } };
  if (reason === 'subframe') event = { ...f.event, senderFrame: {} };
  if (reason === 'destroyed') f.window.isDestroyed = () => true;
  if (reason === 'quitting') f.canConfirm.mockReturnValue(false);
  if (reason === 'failed') f.initialization.fail(new Error('unrecoverable startup error'));
  if (reason === 'stale-owner') f.confirm.mockReturnValue(false);
  expect(f.invoke({ requestId: pending.requestId }, event)).toEqual({ confirmed: false });
  if (reason !== 'stale-owner') expect(f.confirm).not.toHaveBeenCalled();
  expect(f.initialization.getState().downgradeConfirmation).toEqual(pending);
});
