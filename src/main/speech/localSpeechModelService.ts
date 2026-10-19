import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import { setTimeout as delay } from 'timers/promises';
import { createZstdDecompress } from 'zlib';

import { APP_UPDATE_CONFIG } from '../../config/appUpdate';
import { LOCAL_ASR_DEFAULT_MODEL_ID } from '../../shared/speech/localAsr';
import {
  type LocalSpeechModelInstallResult,
  LocalSpeechModelKind,
  type LocalSpeechModelKind as LocalSpeechModelKindValue,
  type LocalSpeechModelListResult,
  type LocalSpeechModelStatus,
} from '../../shared/speech/localSpeechModels';
import { LOCAL_TTS_MODEL_ID } from '../../shared/speech/localTts';
import { resolveAppUpdateResourceUrl } from '../core/app/updateResourceUrl';
import { t } from '../core/i18n';
import { downloadLocalSpeechModel } from './localSpeechModelDownload';
import { resolveLocalSpeechModelDir, resolveLocalSpeechModelsRoot } from './localSpeechPaths';

async function renameModelDirectory(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows scanners may briefly hold freshly extracted model files open.
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ||
        attempt >= 4
      ) {
        throw error;
      }
      await delay(100 * 2 ** attempt);
    }
  }
}

export interface LocalSpeechModelArtifact {
  id: string;
  kind: LocalSpeechModelKindValue;
  file: string;
  sha256: string;
  compressedBytes: number;
  estimatedBytes?: number;
  requiredFiles: string[];
}

interface LocalSpeechServerManifest {
  version: 1;
  models: Array<{
    id: string;
    file: string;
    sha256: string;
    compressedBytes: number;
  }>;
}

export const LOCAL_SPEECH_MODEL_ARTIFACTS: LocalSpeechModelArtifact[] = [
  {
    id: LOCAL_TTS_MODEL_ID,
    kind: LocalSpeechModelKind.Tts,
    file: `${LOCAL_TTS_MODEL_ID}.tar.zst`,
    sha256: '9747b508672de5ad7994ac69cc5480e9a2aa8b0adc892d6eab3d625c8c84763b',
    compressedBytes: 144_319_265,
    requiredFiles: [
      'model.int8.onnx',
      'voices.bin',
      'tokens.txt',
      'espeak-ng-data',
      'lexicon-us-en.txt',
      'lexicon-zh.txt',
      'phone-zh.fst',
      'date-zh.fst',
      'number-zh.fst',
      'MODEL-LICENSE.txt',
    ],
  },
  {
    id: LOCAL_ASR_DEFAULT_MODEL_ID,
    kind: LocalSpeechModelKind.Asr,
    file: `${LOCAL_ASR_DEFAULT_MODEL_ID}.r2.tar.zst`,
    sha256: 'a319fd0fc2f6a91624bee794e110d11f3b1e641acd3e7c24823f6f94a713f5cf',
    compressedBytes: 155_335_094,
    requiredFiles: ['model.int8.onnx', 'tokens.txt', 'MODEL-LICENSE.txt'],
  },
  {
    id: 'sherpa-onnx-whisper-base',
    kind: LocalSpeechModelKind.Asr,
    file: 'sherpa-onnx-whisper-base.tar.zst',
    sha256: 'def1d8cd94ddb368deb60964a97f75f0f1a5ca928beb7f6930d3ce989f4534ce',
    compressedBytes: 87_430_450,
    requiredFiles: [
      'base-encoder.int8.onnx',
      'base-decoder.int8.onnx',
      'base-tokens.txt',
      'MODEL-LICENSE.txt',
    ],
  },
  {
    id: 'vits-icefall-zh-aishell3',
    kind: LocalSpeechModelKind.Tts,
    file: 'vits-icefall-zh-aishell3.tar.zst',
    sha256: '0d14917e6936085cc1c63af8b755305539bf3e712f3e16adf833420c3f70f205',
    compressedBytes: 27_270_347,
    requiredFiles: [
      'model.onnx',
      'tokens.txt',
      'lexicon.txt',
      'phone.fst',
      'date.fst',
      'number.fst',
      'MODEL-LICENSE.txt',
    ],
  },
  {
    id: 'vits-piper-en_US-lessac-medium-int8',
    kind: LocalSpeechModelKind.Tts,
    file: 'vits-piper-en_US-lessac-medium-int8.r2.tar.zst',
    sha256: 'cedf910bab1f307d3eb1f4d220bea24b1ba79616d6ed4813f36a92f4dd4bd4d7',
    compressedBytes: 21_181_920,
    requiredFiles: [
      'en_US-lessac-medium.onnx',
      'tokens.txt',
      'espeak-ng-data',
      'MODEL-LICENSE.txt',
    ],
  },
];

interface LocalSpeechModelServiceDependencies {
  userDataPath: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  notify: (status: LocalSpeechModelStatus) => void;
  syncOpenClawConfig: (reason: string) => Promise<void>;
  artifacts?: LocalSpeechModelArtifact[];
  baseUrl?: string;
  resolveModelDir?: (modelId: string) => string | null;
}

const isModelComplete = (modelDir: string, artifact: LocalSpeechModelArtifact): boolean =>
  artifact.requiredFiles.every(file => fs.existsSync(path.join(modelDir, file)));

export class LocalSpeechModelService {
  private readonly statuses = new Map<string, LocalSpeechModelStatus>();
  private readonly installs = new Map<string, Promise<LocalSpeechModelInstallResult>>();
  private readonly artifacts: LocalSpeechModelArtifact[];
  private manifestLoad: Promise<void> | null = null;

  constructor(private readonly dependencies: LocalSpeechModelServiceDependencies) {
    this.artifacts = dependencies.artifacts ?? LOCAL_SPEECH_MODEL_ARTIFACTS;
    for (const artifact of this.artifacts) {
      const installed = this.isInstalled(artifact);
      this.statuses.set(artifact.id, {
        id: artifact.id,
        kind: artifact.kind,
        phase: installed ? 'ready' : 'not-installed',
        installed,
        downloadBytes: artifact.compressedBytes || artifact.estimatedBytes,
        downloadBytesExact: artifact.compressedBytes > 0,
      });
    }
  }

  list(): LocalSpeechModelListResult {
    return {
      supported: process.platform === 'win32' && process.arch === 'x64',
      models: this.artifacts.map(artifact => ({
        ...this.statuses.get(artifact.id)!,
      })),
    };
  }

  install(kind: unknown, id: unknown): Promise<LocalSpeechModelInstallResult> {
    const artifact = this.artifacts.find(model => model.kind === kind && model.id === id);
    if (!artifact) {
      return Promise.resolve({
        success: false,
        status: {
          id: typeof id === 'string' ? id : '',
          kind: kind === LocalSpeechModelKind.Tts ? kind : LocalSpeechModelKind.Asr,
          phase: 'error',
          installed: false,
          error: 'Unknown local speech model.',
        },
      });
    }
    const current = this.installs.get(artifact.id);
    if (current) return current;
    const operation = this.ensureArtifactMetadata(artifact)
      .then(() => this.installArtifact(artifact))
      .catch(error => this.fail(artifact, error instanceof Error ? error.message : String(error)))
      .finally(() => this.installs.delete(artifact.id));
    this.installs.set(artifact.id, operation);
    return operation;
  }

  async remove(kind: unknown, id: unknown): Promise<LocalSpeechModelInstallResult> {
    const artifact = this.artifacts.find(model => model.kind === kind && model.id === id);
    if (!artifact) {
      return {
        success: false,
        status: {
          id: typeof id === 'string' ? id : '',
          kind: kind === LocalSpeechModelKind.Tts ? kind : LocalSpeechModelKind.Asr,
          phase: 'error',
          installed: false,
          error: 'Unknown local speech model.',
        },
      };
    }
    if (this.installs.has(artifact.id)) {
      return {
        success: false,
        status: {
          ...this.statuses.get(artifact.id)!,
          error: 'Model installation is in progress.',
        },
      };
    }
    const modelDir = this.dependencies.resolveModelDir
      ? this.dependencies.resolveModelDir(artifact.id)
      : resolveLocalSpeechModelDir(artifact.id, {
          userDataPath: this.dependencies.userDataPath,
        });
    if (modelDir) fs.rmSync(modelDir, { recursive: true, force: true });
    this.update(artifact, {
      phase: 'not-installed',
      installed: false,
      downloadPercent: undefined,
      error: undefined,
    });
    try {
      await this.dependencies.syncOpenClawConfig('local-speech-model-removed');
    } catch {
      // The next settings/config synchronization will remove the now-unavailable provider.
    }
    return { success: true, status: { ...this.statuses.get(artifact.id)! } };
  }

  private resolveBaseUrl(): URL {
    const configured =
      this.dependencies.baseUrl !== undefined
        ? resolveAppUpdateResourceUrl('', this.dependencies.baseUrl)
        : resolveAppUpdateResourceUrl(
            `${APP_UPDATE_CONFIG.speechModels.path.replace(/^\/+|\/+$/g, '')}/`,
          );
    if (!configured) throw new Error(t('localSpeechModelServerNotConfigured'));
    return new URL(configured);
  }

  private async ensureArtifactMetadata(artifact: LocalSpeechModelArtifact): Promise<void> {
    if (artifact.compressedBytes > 0 && /^[a-f0-9]{64}$/.test(artifact.sha256)) return;
    if (!this.manifestLoad) {
      this.manifestLoad = (async () => {
        const response = await this.dependencies.fetch(
          new URL('manifest.json', this.resolveBaseUrl()).toString(),
          { cache: 'no-store', redirect: 'follow' },
        );
        if (!response.ok)
          throw new Error(`Model catalog download failed with HTTP ${response.status}.`);
        const manifest = (await response.json()) as Partial<LocalSpeechServerManifest>;
        if (manifest.version !== 1 || !Array.isArray(manifest.models)) {
          throw new Error('Model catalog is invalid.');
        }
        for (const entry of manifest.models) {
          const known = this.artifacts.find(candidate => candidate.id === entry?.id);
          if (
            !known ||
            entry.file !== known.file ||
            !Number.isSafeInteger(entry.compressedBytes) ||
            entry.compressedBytes <= 0 ||
            !/^[a-f0-9]{64}$/.test(entry.sha256)
          ) {
            continue;
          }
          known.compressedBytes = entry.compressedBytes;
          known.sha256 = entry.sha256;
          const status = this.statuses.get(known.id);
          if (status) {
            this.statuses.set(known.id, {
              ...status,
              downloadBytes: entry.compressedBytes,
              downloadBytesExact: true,
            });
          }
        }
      })().catch(error => {
        this.manifestLoad = null;
        throw error;
      });
    }
    await this.manifestLoad;
    if (artifact.compressedBytes <= 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error('This model is not published on the update server.');
    }
  }

  private isInstalled(artifact: LocalSpeechModelArtifact): boolean {
    const modelDir = this.dependencies.resolveModelDir
      ? this.dependencies.resolveModelDir(artifact.id)
      : resolveLocalSpeechModelDir(artifact.id, {
          userDataPath: this.dependencies.userDataPath,
        });
    return Boolean(modelDir && isModelComplete(modelDir, artifact));
  }

  private update(artifact: LocalSpeechModelArtifact, patch: Partial<LocalSpeechModelStatus>): void {
    const status = { ...this.statuses.get(artifact.id)!, ...patch };
    this.statuses.set(artifact.id, status);
    this.dependencies.notify({ ...status });
  }

  private async installArtifact(
    artifact: LocalSpeechModelArtifact,
  ): Promise<LocalSpeechModelInstallResult> {
    const modelsRoot = resolveLocalSpeechModelsRoot({
      userDataPath: this.dependencies.userDataPath,
    });
    if (!modelsRoot) return this.fail(artifact, 'Local speech models are unsupported.');

    const downloadDir = path.join(modelsRoot, '.downloads');
    const archivePath = path.join(downloadDir, `${artifact.id}.download`);
    const stagingRoot = path.join(modelsRoot, `.install-${artifact.id}`);
    const stagedModel = path.join(stagingRoot, artifact.id);
    const targetModel = path.join(modelsRoot, artifact.id);
    const backupModel = path.join(modelsRoot, `.backup-${artifact.id}`);
    try {
      if (this.isInstalled(artifact)) {
        await this.dependencies.syncOpenClawConfig('local-speech-model-installed');
        this.update(artifact, {
          phase: 'ready',
          installed: true,
          downloadPercent: undefined,
          error: undefined,
        });
        return { success: true, status: { ...this.statuses.get(artifact.id)! } };
      }
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.rmSync(archivePath, { force: true });
      this.update(artifact, {
        phase: 'downloading',
        installed: this.isInstalled(artifact),
        downloadPercent: 0,
        error: undefined,
      });

      const baseUrl = this.resolveBaseUrl();
      await downloadLocalSpeechModel({
        url: new URL(artifact.file, baseUrl).toString(),
        archivePath,
        compressedBytes: artifact.compressedBytes,
        sha256: artifact.sha256,
        fetch: this.dependencies.fetch,
        onProgress: downloadPercent => this.update(artifact, { downloadPercent }),
      });

      this.update(artifact, { phase: 'installing', downloadPercent: 100 });
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      fs.mkdirSync(stagingRoot, { recursive: true });
      await pipeline(
        fs.createReadStream(archivePath),
        createZstdDecompress(),
        tar.extract({ cwd: stagingRoot, strict: true }),
      );
      if (!isModelComplete(stagedModel, artifact)) {
        throw new Error('Downloaded model archive is incomplete.');
      }

      fs.rmSync(backupModel, { recursive: true, force: true });
      if (fs.existsSync(targetModel)) await renameModelDirectory(targetModel, backupModel);
      try {
        await renameModelDirectory(stagedModel, targetModel);
        fs.rmSync(backupModel, { recursive: true, force: true });
      } catch (error) {
        fs.rmSync(targetModel, { recursive: true, force: true });
        if (fs.existsSync(backupModel)) await renameModelDirectory(backupModel, targetModel);
        throw error;
      }

      await this.dependencies.syncOpenClawConfig('local-speech-model-installed');
      this.update(artifact, {
        phase: 'ready',
        installed: true,
        downloadPercent: undefined,
        error: undefined,
      });
      return { success: true, status: { ...this.statuses.get(artifact.id)! } };
    } catch (error) {
      return this.fail(artifact, error instanceof Error ? error.message : String(error));
    } finally {
      fs.rmSync(archivePath, { force: true });
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  private fail(artifact: LocalSpeechModelArtifact, error: string): LocalSpeechModelInstallResult {
    this.update(artifact, {
      phase: 'error',
      installed: this.isInstalled(artifact),
      downloadPercent: undefined,
      error,
    });
    return { success: false, status: { ...this.statuses.get(artifact.id)! } };
  }
}
