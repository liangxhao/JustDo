import { ipcRenderer } from 'electron';

import {
  AutomaticErrorRetryIpc,
  type AutomaticErrorRetryPresentation,
} from '../../shared/cowork/automaticErrorRetry';

/** Content-free retry receipts only; native messages continue through Gateway. */
export function createAutomaticErrorRetryApi() {
  return {
    getAutomaticErrorRetry: (sessionId: string) =>
      ipcRenderer.invoke(AutomaticErrorRetryIpc.Get, sessionId),
    onAutomaticErrorRetryChanged: (callback: (value: AutomaticErrorRetryPresentation) => void) => {
      let active = true;
      const listener = (_event: Electron.IpcRendererEvent, value: AutomaticErrorRetryPresentation) => {
        if (active) callback(value);
      };
      ipcRenderer.on(AutomaticErrorRetryIpc.Changed, listener);
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(AutomaticErrorRetryIpc.Changed, listener);
      };
    },
  };
}
