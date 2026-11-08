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
import { resolveOnlineReplySpeechProfile } from '../../speech/onlineReplySpeechProfile';
import { getSpeechConfigurationRevision } from '../../speech/speechConfigurationRevision';
import { registerBuiltinSpeechPreviewHandlers } from './builtinSpeechPreview';

const MAX_SPEECH_TEXT_LENGTH = 10_000;

interface SpeechSynthesisHandlerDependencies {
  getSettings: () => LocalSpeechSettings;
  getModelCategory: () => unknown;
  requestGateway: <T>(
    method: string,
    params?: unknown,
    options?: { assertBeforeSend?: () => void },
  ) => Promise<T>;
}
export function registerSpeechSynthesisHandlers({
  requestGateway,
  getSettings,
  getModelCategory,
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
      const profile = resolveOnlineReplySpeechProfile(settings, getModelCategory());
      if (settings.synthesisMode === 'online' && !profile)
        throw new Error('Reply speech is not configured.');
      const configurationKey = (value: LocalSpeechSettings) =>
        JSON.stringify([
          getSpeechSynthesisSettingsKey(value),
          resolveOnlineReplySpeechProfile(value, getModelCategory())?.configurationId,
        ]);
      const settingsKey = configurationKey(settings);
      const revision = getSpeechConfigurationRevision('output');
      const assertCurrent = () => {
        if (
          configurationKey(getSettings()) !== settingsKey ||
          getSpeechConfigurationRevision('output') !== revision
        )
          throw new Error('Speech settings changed before synthesis completed.');
      };
      const result =
        settings.synthesisMode === 'local'
          ? await synthesizeLocalSpeech(normalizedText, settings)
          : await requestGateway<SpeechSynthesisResult>(
              SPEECH_SYNTHESIS_METHOD,
              {
                text: normalizedText,
                configurationId: profile!.configurationId,
              },
              { assertBeforeSend: assertCurrent },
            );
      assertCurrent();
      return result;
    },
  );
}
