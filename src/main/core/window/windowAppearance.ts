import type { IpcMainEvent, WebContents } from 'electron';

import { RENDERER_PREFERENCES_KEY } from '../../../shared/app/rendererPreferences';
import {
  normalizeWindowAppearance,
  type WindowAppearance,
  WindowAppearanceIpc,
} from '../../../shared/app/windowAppearance';

export function readStoredWindowAppearance(store: { get(key: string): unknown }): WindowAppearance {
  try {
    const config = store.get('app_config') as { theme?: unknown } | undefined;
    const preferences = store.get(RENDERER_PREFERENCES_KEY) as Record<string, unknown> | undefined;
    return normalizeWindowAppearance(config?.theme, preferences?.['justdo-theme-id']);
  } catch {
    console.warn('[WindowAppearance] Could not read startup appearance; using the default theme.');
    return normalizeWindowAppearance(undefined);
  }
}
/** Read at each document's preload and on every reload. */
export function registerWindowAppearance(
  contents: WebContents,
  getStore: () => { get(key: string): unknown },
): void {
  const ipc = contents.ipc;
  const read = (event: IpcMainEvent) => {
    let appearance = normalizeWindowAppearance(undefined);
    if (
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame
    ) {
      try {
        appearance = readStoredWindowAppearance(getStore());
      } catch {
        console.warn(
          '[WindowAppearance] Startup appearance is unavailable; using the default theme.',
        );
      }
    }
    // Electron sends the synchronous reply on assignment; publish exactly once.
    event.returnValue = appearance;
  };
  ipc.on(WindowAppearanceIpc.Get, read);
  contents.once('destroyed', () => ipc.removeListener(WindowAppearanceIpc.Get, read));
}
