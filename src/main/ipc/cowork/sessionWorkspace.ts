import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { SessionWorkspaceIpc } from '../../../shared/cowork/sessionWorkspace';
import {
  createSessionWorkspaceUpdater,
  type SessionWorkspaceDependencies,
  type SessionWorkspaceUpdater,
} from '../../engine/cowork/sessionWorkspace';

interface Dependencies extends SessionWorkspaceDependencies {
  isAllowedSender: (event: IpcMainInvokeEvent) => boolean;
}

export function registerSessionWorkspaceHandler(deps: Dependencies): SessionWorkspaceUpdater {
  const update = createSessionWorkspaceUpdater(deps);
  ipcMain.handle(SessionWorkspaceIpc.Set, (event, input) =>
    update(input, () => deps.isAllowedSender(event)),
  );
  return update;
}
