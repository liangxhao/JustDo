import { ipcMain } from 'electron';

import type { LocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import {
  SpeechSynthesisIpc,
  type SpeechSynthesisResult,
} from '../../../shared/speech/speechSynthesis';
import { synthesizeLocalSpeech } from '../../speech/localTtsService';

const MAX_SPEECH_TEXT_LENGTH = 10_000;

interface SpeechSynthesisHandlerDependencies {
  getSettings: () => LocalSpeechSettings;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
}
export function registerSpeechSynthesisHandlers({
  requestGateway,
  getSettings,
}: SpeechSynthesisHandlerDependencies): void {
  ipcMain.handle(
    SpeechSynthesisIpc.Speak,
    async (_event, text: unknown): Promise<SpeechSynthesisResult> => {
      const normalizedText = typeof text === 'string' ? text.trim() : '';
      if (!normalizedText || normalizedText.length > MAX_SPEECH_TEXT_LENGTH) {
        throw new Error('Invalid speech text.');
      }
      const settings = getSettings();
      if (!settings.outputEnabled) throw new Error('Speech output is disabled.');
      if (settings.synthesisMode === 'local') {
        return synthesizeLocalSpeech(normalizedText, settings);
      }
      return requestGateway<SpeechSynthesisResult>('tts.speak', { text: normalizedText });
    },
  );
}
