import fs from 'fs';
import path from 'path';

import {
  defaultLocalSpeechSettings,
  type LocalSpeechSettings,
  normalizeLocalSpeechSettings,
} from '../../../../shared/speech/localSpeechSettings';
import {
  LOCAL_TTS_MODEL_ID,
  LOCAL_TTS_MODEL_IDS,
  LOCAL_TTS_PROVIDER_ID,
  type LocalTtsModelId,
  type LocalTtsStatus,
} from '../../../../shared/speech/localTts';
import {
  isLocalSpeechRuntimeReady,
  type LocalSpeechPathOptions,
  resolveLocalSpeechModelDir,
  resolveLocalSpeechRuntimeDir,
} from '../../../speech/localSpeechPaths';

const WINDOWS_X64_EXECUTABLE = path.join('runtime', 'bin', 'sherpa-onnx-offline-tts.exe');
const REQUIRED_MODEL_FILES: Record<LocalTtsModelId, string[]> = {
  'kokoro-int8-multi-lang-v1_1': [
    'model.int8.onnx',
    'voices.bin',
    'tokens.txt',
    'espeak-ng-data',
    'lexicon-us-en.txt',
    'lexicon-zh.txt',
    'phone-zh.fst',
    'date-zh.fst',
    'number-zh.fst',
  ],
  'vits-icefall-zh-aishell3': [
    'model.onnx',
    'tokens.txt',
    'lexicon.txt',
    'phone.fst',
    'date.fst',
    'number.fst',
  ],
  'vits-piper-en_US-lessac-medium-int8': [
    'en_US-lessac-medium.onnx',
    'tokens.txt',
    'espeak-ng-data',
  ],
};

export interface LocalTtsAssetPaths {
  executablePath: string;
  modelDir: string;
  modelId: LocalTtsModelId;
}

export const isLocalTtsModelId = (value: unknown): value is LocalTtsModelId =>
  LOCAL_TTS_MODEL_IDS.includes(value as LocalTtsModelId);

export function resolveLocalTtsAssetPaths(
  modelId: LocalTtsModelId = LOCAL_TTS_MODEL_ID,
  options?: LocalSpeechPathOptions,
): LocalTtsAssetPaths | null {
  if (!isLocalSpeechRuntimeReady(options)) return null;
  const runtimeDir = resolveLocalSpeechRuntimeDir(options);
  const modelDir = resolveLocalSpeechModelDir(modelId, options);
  if (!runtimeDir || !modelDir) return null;
  return {
    executablePath: path.join(path.dirname(runtimeDir), WINDOWS_X64_EXECUTABLE),
    modelDir,
    modelId,
  };
}

export function getLocalTtsStatus(
  modelIdOrPaths: LocalTtsModelId | LocalTtsAssetPaths = LOCAL_TTS_MODEL_ID,
  suppliedPaths?: LocalTtsAssetPaths | null,
): LocalTtsStatus {
  const modelId =
    typeof modelIdOrPaths === 'string'
      ? modelIdOrPaths
      : (modelIdOrPaths.modelId ?? LOCAL_TTS_MODEL_ID);
  const paths =
    typeof modelIdOrPaths === 'string'
      ? (suppliedPaths ?? resolveLocalTtsAssetPaths(modelId))
      : modelIdOrPaths;
  const supported = paths !== null;
  let available = false;
  try {
    available = Boolean(
      paths &&
        fs.existsSync(paths.executablePath) &&
        REQUIRED_MODEL_FILES[modelId].every(file => fs.existsSync(path.join(paths.modelDir, file))),
    );
  } catch {
    available = false;
  }
  return { available, supported, modelId };
}

export function buildManagedLocalTtsConfig(
  paths: LocalTtsAssetPaths | null | undefined = undefined,
  settingsInput: LocalSpeechSettings = defaultLocalSpeechSettings,
): Record<string, unknown> | null {
  const settings = normalizeLocalSpeechSettings(settingsInput);
  const resolvedPaths = paths ?? resolveLocalTtsAssetPaths(settings.ttsModelId);
  if (
    !settings.outputEnabled ||
    settings.synthesisMode !== 'local' ||
    !resolvedPaths ||
    !getLocalTtsStatus(settings.ttsModelId, resolvedPaths).available
  ) {
    return null;
  }

  const model = (file: string): string => path.join(resolvedPaths.modelDir, file);
  const modelArgs = (() => {
    if (settings.ttsModelId === 'vits-icefall-zh-aishell3') {
      return [
        `--vits-model=${model('model.onnx')}`,
        `--vits-tokens=${model('tokens.txt')}`,
        `--vits-lexicon=${model('lexicon.txt')}`,
        `--tts-rule-fsts=${model('phone.fst')},${model('date.fst')},${model('number.fst')}`,
      ];
    }
    if (settings.ttsModelId === 'vits-piper-en_US-lessac-medium-int8') {
      return [
        `--vits-model=${model('en_US-lessac-medium.onnx')}`,
        `--vits-tokens=${model('tokens.txt')}`,
        `--vits-data-dir=${model('espeak-ng-data')}`,
      ];
    }
    return [
      `--kokoro-model=${model('model.int8.onnx')}`,
      `--kokoro-voices=${model('voices.bin')}`,
      `--kokoro-tokens=${model('tokens.txt')}`,
      `--kokoro-data-dir=${model('espeak-ng-data')}`,
      `--kokoro-lexicon=${model('lexicon-us-en.txt')},${model('lexicon-zh.txt')}`,
      `--tts-rule-fsts=${model('phone-zh.fst')},${model('date-zh.fst')},${model('number-zh.fst')}`,
    ];
  })();
  return {
    enabled: true,
    auto: 'off',
    provider: LOCAL_TTS_PROVIDER_ID,
    timeoutMs: 120_000,
    maxTextLength: 10_000,
    providers: {
      [LOCAL_TTS_PROVIDER_ID]: {
        command: resolvedPaths.executablePath,
        args: [
          ...modelArgs,
          `--num-threads=${settings.synthesisThreads}`,
          `--sid=${settings.voiceId}`,
          ...(settings.ttsModelId === LOCAL_TTS_MODEL_ID
            ? [`--kokoro-length-scale=${Number((1 / settings.speechRate).toFixed(4))}`]
            : [`--vits-noise-scale=0.667`, `--vits-noise-scale-w=0.8`, `--vits-length-scale=${Number((1 / settings.speechRate).toFixed(4))}`]),
          '--output-filename={{OutputPath}}',
          '{{Text}}',
        ],
        outputFormat: 'wav',
        timeoutMs: 120_000,
      },
    },
  };
}
