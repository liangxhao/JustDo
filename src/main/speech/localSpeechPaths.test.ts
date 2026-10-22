import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isLocalSpeechRuntimeReady,
  LOCAL_SPEECH_RUNTIME_MARKER,
  resolveLocalSpeechModelDir,
} from './localSpeechPaths';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('local speech paths', () => {
  it.each([true, false])('requires the pinned runtime marker and both speech executables (packaged=%s)', (packaged) => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-resources-'));
    const resourcesPath = path.join(appPath, 'resources');
    const options = { packaged, appPath, resourcesPath };
    temporaryRoots.push(appPath);
    const root = path.join(
      packaged ? resourcesPath : path.join(appPath, 'build', 'runtimes'),
      'local-tts',
      'win-x64',
    );
    const bin = path.join(root, 'runtime', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'sherpa-onnx-offline.exe'), 'asr');
    fs.writeFileSync(path.join(bin, 'sherpa-onnx-offline-tts.exe'), 'tts');

    expect(isLocalSpeechRuntimeReady(options)).toBe(false);

    fs.writeFileSync(
      path.join(root, '.justdo-local-speech-runtime-version'),
      LOCAL_SPEECH_RUNTIME_MARKER,
    );
    expect(isLocalSpeechRuntimeReady(options)).toBe(true);
  });

  it('reuses prepared development models until a user model is installed', () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-development-'));
    temporaryRoots.push(appPath);
    const userDataPath = path.join(appPath, 'user-data');
    const options = { packaged: false, appPath, userDataPath };
    const preparedModel = path.join(appPath, 'build', 'runtimes', 'local-tts', 'win-x64', 'model-a');
    const installedModel = path.join(userDataPath, 'local-speech-models', 'model-a');
    fs.mkdirSync(preparedModel, { recursive: true });

    expect(resolveLocalSpeechModelDir('model-a', options)).toBe(preparedModel);

    fs.mkdirSync(installedModel, { recursive: true });

    expect(resolveLocalSpeechModelDir('model-a', options)).toBe(installedModel);
  });

  it('resolves packaged models from user data instead of application resources', () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-resources-'));
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-user-data-'));
    temporaryRoots.push(resourcesPath, userDataPath);

    expect(
      resolveLocalSpeechModelDir('model-a', {
        packaged: true,
        resourcesPath,
        userDataPath,
      }),
    ).toBe(path.join(userDataPath, 'local-speech-models', 'model-a'));
  });
});
