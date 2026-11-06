import { expect, test, vi } from 'vitest';

import { AppServerNotificationMethod } from '../protocol/appServerProtocol';
import { CodexAppServerEventHub } from './codexAppServerEventHub';

test('broadcasts only live subscriptions for the exact external thread', () => {
  const hub = new CodexAppServerEventHub();
  const first = vi.fn();
  const second = vi.fn();
  const stop = hub.subscribe('one', first);
  hub.subscribe('two', second);
  hub.publish(AppServerNotificationMethod.ThreadStarted, { thread: { id: 'one' } });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  stop();
  hub.publish(AppServerNotificationMethod.TurnStarted, { threadId: 'one', turn: { id: 'turn' } });
  expect(first).toHaveBeenCalledTimes(1);
  const later = vi.fn();
  hub.subscribe('one', later);
  expect(later).not.toHaveBeenCalled();
});

test('a failed observer cannot break publication or another observer', () => {
  const hub = new CodexAppServerEventHub();
  const failed = vi.fn(() => { throw new Error('disconnected'); });
  const live = vi.fn();
  hub.subscribe('one', failed);
  hub.subscribe('one', live);
  hub.publish(AppServerNotificationMethod.TurnStarted, { threadId: 'one' });
  hub.publish(AppServerNotificationMethod.TurnCompleted, { threadId: 'one' });
  expect(failed).toHaveBeenCalledTimes(1);
  expect(live).toHaveBeenCalledTimes(2);
});

test('withdrawing another listener during publication prevents its stale delivery', () => {
  const hub = new CodexAppServerEventHub();
  const second = vi.fn();
  let stopSecond = () => {};
  hub.subscribe('one', () => stopSecond());
  stopSecond = hub.subscribe('one', second);
  hub.publish(AppServerNotificationMethod.TurnStarted, { threadId: 'one' });
  expect(second).not.toHaveBeenCalled();
});
