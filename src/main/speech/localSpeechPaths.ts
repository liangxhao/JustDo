import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { LOCAL_TTS_RUNTIME_VERSION } from '../../shared/speech/localTts';

export const LOCAL_SPEECH_RUNTIME_MARKER = `sherpa-onnx=${LOCAL_TTS_RUNTIME_VERSION}\n`;

export interface LocalSpeechPathOptions {
  appPath?: string;
  resourcesPath?: string;
  userDataPath?: string;
  packaged?: boolean;
}

export const resolveLocalSpeechResourceRoot = (options?: LocalSpeechPathOptions): string | null => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null;
  const packaged = options?.packaged ?? app.isPackaged;
  const resourceRoot = packaged
    ? (options?.resourcesPath ?? process.resourcesPath)
    : path.join(options?.appPath ?? app.getAppPath(), 'build', 'runtimes');
  return path.join(resourceRoot, 'local-tts', 'win-x64');
};

export const resolveLocalSpeechRuntimeDir = (options?: LocalSpeechPathOptions): string | null => {
  const root = resolveLocalSpeechResourceRoot(options);
  return root ? path.join(root, 'runtime') : null;
};

export const resolveLocalSpeechModelsRoot = (options?: LocalSpeechPathOptions): string | null => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null;
  return path.join(options?.userDataPath ?? app.getPath('userData'), 'local-speech-models');
};

export const resolveLocalSpeechModelDir = (
  modelId: string,
  options?: LocalSpeechPathOptions,
): string | null => {
  const modelsRoot = resolveLocalSpeechModelsRoot(options);
  if (!modelsRoot) return null;
  const installed = path.join(modelsRoot, modelId);
  if (fs.existsSync(installed)) return installed;

  const packaged = options?.packaged ?? app.isPackaged;
  const resourceRoot = resolveLocalSpeechResourceRoot(options);
  const developmentModel = resourceRoot ? path.join(resourceRoot, modelId) : null;
  return !packaged && developmentModel && fs.existsSync(developmentModel)
    ? developmentModel
    : installed;
};

export const isLocalSpeechRuntimeReady = (options?: LocalSpeechPathOptions): boolean => {
  const root = resolveLocalSpeechResourceRoot(options);
  const runtimeDir = resolveLocalSpeechRuntimeDir(options);
  if (!root || !runtimeDir) return false;
  try {
    return (
      fs.existsSync(path.join(runtimeDir, 'bin', 'sherpa-onnx-offline-tts.exe')) &&
      fs.existsSync(path.join(runtimeDir, 'bin', 'sherpa-onnx-offline.exe')) &&
      fs.readFileSync(path.join(root, '.justdo-local-speech-runtime-version'), 'utf8') ===
        LOCAL_SPEECH_RUNTIME_MARKER
    );
  } catch {
    return false;
  }
};
