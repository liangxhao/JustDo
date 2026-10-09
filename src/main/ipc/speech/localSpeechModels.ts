import { ipcMain } from 'electron';

import { LocalSpeechModelIpc } from '../../../shared/speech/localSpeechModels';
import type { LocalSpeechModelService } from '../../speech/localSpeechModelService';

interface LocalSpeechModelHandlerDependencies {
  getService: () => LocalSpeechModelService;
}

export const registerLocalSpeechModelHandlers = ({
  getService,
}: LocalSpeechModelHandlerDependencies): void => {
  ipcMain.handle(LocalSpeechModelIpc.List, () => getService().list());
  ipcMain.handle(LocalSpeechModelIpc.Install, (_event, kind: unknown, id: unknown) =>
    getService().install(kind, id),
  );
  ipcMain.handle(LocalSpeechModelIpc.Remove, (_event, kind: unknown, id: unknown) =>
    getService().remove(kind, id),
  );
};
