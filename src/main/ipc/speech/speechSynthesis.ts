import { ipcMain } from 'electron';

import {
  getSpeechSynthesisSettingsKey,
  type LocalSpeechSettings,
} from '../../../shared/speech/localSpeechSettings';
import {
  SPEECH_SYNTHESIS_METHOD,
  SpeechSynthesisIpc,
  type SpeechSynthesisResult,
} from '../../../shared/speech/speechSynthesis';
import { synthesizeLocalSpeech } from '../../speech/localTtsService';
import { registerBuiltinSpeechPreviewHandlers } from './builtinSpeechPreview';

const MAX_SPEECH_TEXT_LENGTH = 10_000;

interface SpeechSynthesisHandlerDependencies {
  getSettings: () => LocalSpeechSettings;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
}
export function registerSpeechSynthesisHandlers({
  requestGateway,
  getSettings,
}: SpeechSynthesisHandlerDependencies): void {
  registerBuiltinSpeechPreviewHandlers();
  ipcMain.handle(
    SpeechSynthesisIpc.Speak,
    async (_event, text: unknown): Promise<SpeechSynthesisResult> => {
      const normalizedText = typeof text === 'string' ? text.trim() : '';
      if (!normalizedText || normalizedText.length > MAX_SPEECH_TEXT_LENGTH) {
        throw new Error('Invalid speech text.');
      }
      const settings = getSettings();
      if (!settings.outputEnabled) throw new Error('Speech output is disabled.');
      const settingsKey = getSpeechSynthesisSettingsKey(settings);
      const result =
        settings.synthesisMode === 'local'
          ? await synthesizeLocalSpeech(normalizedText, settings)
          : await requestGateway<SpeechSynthesisResult>(SPEECH_SYNTHESIS_METHOD, {
              text: normalizedText,
            });
      if (getSpeechSynthesisSettingsKey(getSettings()) !== settingsKey)
        throw new Error('Speech settings changed before synthesis completed.');
      return result;
    },
  );
}
