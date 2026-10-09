import { ipcMain } from 'electron';

import {
  LOCAL_ASR_DEFAULT_MODEL_ID,
  LocalAsrIpc,
  type LocalAsrTranscribeOptions,
  type LocalAsrTranscribeResult,
} from '../../../shared/speech/localAsr';
import { normalizeLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import {
  getLocalAsrStatus,
  isLocalAsrModelId,
  transcribeLocalAudio,
} from '../../speech/localAsrService';
import { stageAudioAttachment } from '../../speech/localAudioAttachment';

export function registerLocalAsrHandlers(): void {
  ipcMain.handle(
    LocalAsrIpc.StageAttachment,
    async (_event, source: unknown, workspace: unknown) => {
      if (typeof source !== 'string' || typeof workspace !== 'string') {
        return { success: false, error: 'Invalid audio attachment request.' };
      }
      try {
        return { success: true, path: await stageAudioAttachment(source, workspace) };
      } catch {
        return { success: false, error: 'Could not copy the audio attachment into the workspace.' };
      }
    },
  );
  ipcMain.handle(LocalAsrIpc.GetStatus, (_event, modelId: unknown) =>
    getLocalAsrStatus(isLocalAsrModelId(modelId) ? modelId : LOCAL_ASR_DEFAULT_MODEL_ID),
  );
  ipcMain.handle(
    LocalAsrIpc.Transcribe,
    async (_event, audio: unknown, options: unknown): Promise<LocalAsrTranscribeResult> => {
      const request = options as Partial<LocalAsrTranscribeOptions> | null;
      if (
        !(audio instanceof Uint8Array) ||
        !request ||
        !isLocalAsrModelId(request.modelId) ||
        !['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(request.language ?? '')
      ) {
        return { success: false, error: 'Invalid local transcription request.' };
      }
      try {
        const settings = normalizeLocalSpeechSettings({
          recognitionThreads: request.numThreads,
        });
        return {
          success: true,
          text: await transcribeLocalAudio(
            audio,
            request.modelId,
            request.language,
            settings.recognitionThreads,
          ),
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
}
