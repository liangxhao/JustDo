import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import { expect, test, vi } from 'vitest';

import { AppInitializationIpc } from '../../../shared/app/initialization';
import { registerStartupEntryClock } from './startupEntryClock';

test('starts the clock only for the owning main frame and removes its window-local listener on destruction', () => {
  const contents = Object.assign(new EventEmitter(), {
    ipc: new EventEmitter(), mainFrame: {}, isDestroyed: () => false,
  });
  const clock = vi.fn(() => 12345);
  registerStartupEntryClock(contents as unknown as WebContents, clock);
  const read = (sender = contents, senderFrame = contents.mainFrame) => {
    const event = { sender, senderFrame, returnValue: undefined as number | undefined };
    contents.ipc.emit(AppInitializationIpc.GetEntryClock, event);
    return event.returnValue;
  };
  expect(clock).not.toHaveBeenCalled();
  expect(read(contents, {})).toBeUndefined();
  expect(read({} as typeof contents)).toBeUndefined();
  expect(clock).not.toHaveBeenCalled();
  expect(read()).toBe(12345);
  expect(clock).toHaveBeenCalledOnce();
  contents.emit('destroyed');
  expect(contents.ipc.listenerCount(AppInitializationIpc.GetEntryClock)).toBe(0);
});
