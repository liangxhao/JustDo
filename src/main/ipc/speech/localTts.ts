import { ipcMain } from 'electron';

import { LOCAL_TTS_MODEL_ID, LocalTtsIpc } from '../../../shared/speech/localTts';
import { getLocalTtsStatus, isLocalTtsModelId } from '../../openclaw/config/localTtsConfig';

export function registerLocalTtsHandlers(): void {
  ipcMain.handle(LocalTtsIpc.GetStatus, (_event, modelId: unknown) =>
    getLocalTtsStatus(isLocalTtsModelId(modelId) ? modelId : LOCAL_TTS_MODEL_ID),
  );
}
