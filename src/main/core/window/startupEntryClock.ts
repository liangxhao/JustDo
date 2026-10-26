import type { IpcMainEvent, WebContents } from 'electron';

import { AppInitializationIpc } from '../../../shared/app/initialization';

/** A scoped preload read, not a Renderer command; no profile or execution capability is exposed. */
export function registerStartupEntryClock(contents: WebContents, getClock: () => number): void {
  const read = (event: IpcMainEvent) => {
    event.returnValue = !contents.isDestroyed() && event.sender === contents &&
      event.senderFrame === contents.mainFrame ? getClock() : undefined;
  };
  contents.ipc.on(AppInitializationIpc.GetEntryClock, read);
  contents.once('destroyed', () => contents.ipc.removeListener(AppInitializationIpc.GetEntryClock, read));
}
