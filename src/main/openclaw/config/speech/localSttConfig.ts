import {
  type LocalSpeechSettings,
  normalizeLocalSpeechSettings,
  resolveLocalSpeechInputLanguage,
} from '../../../../shared/speech/localSpeechSettings';
import {
  buildLocalAsrModelArgs,
  getLocalAsrStatus,
  type LocalAsrAssetPaths,
  resolveLocalAsrAssetPaths,
} from '../../../speech/localAsrService';

/** File transcription is independent of the composer's microphone toggle/mode. */
export function buildManagedLocalSttConfig(
  settingsInput: LocalSpeechSettings,
  appLanguage: 'zh' | 'en',
  paths: LocalAsrAssetPaths | null = resolveLocalAsrAssetPaths(settingsInput.asrModelId),
): Record<string, unknown> | null {
  const settings = normalizeLocalSpeechSettings(settingsInput);
  if (!paths || !getLocalAsrStatus(settings.asrModelId, paths).available) return null;
  const language = resolveLocalSpeechInputLanguage(settings.inputLanguage, appLanguage);
  return {
    mode: 'local',
    command: paths.executablePath,
    args: [
      ...buildLocalAsrModelArgs(settings.asrModelId, language, paths.modelDir),
      `--num-threads=${settings.recognitionThreads}`,
    ],
    modelId: settings.asrModelId,
    language,
  };
}
