import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createZstdCompress } from 'zlib';

import { LocalSpeechModelKind } from '../../shared/speech/localSpeechModels';
import { getLanguage, setLanguage } from '../core/i18n';
import { type LocalSpeechModelArtifact, LocalSpeechModelService } from './localSpeechModelService';

const temporaryRoots: string[] = [];

const createArchive = async (modelId: string, files: string[]) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-model-test-'));
  temporaryRoots.push(root);
  const modelDir = path.join(root, modelId);
  fs.mkdirSync(modelDir, { recursive: true });
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(modelDir, file)), { recursive: true });
    fs.writeFileSync(path.join(modelDir, file), `fixture:${file}`);
  }
  const tarPath = path.join(root, `${modelId}.tar`);
  const archivePath = `${tarPath}.zst`;
  tar.create({ cwd: root, file: tarPath, sync: true }, [modelId]);
  await pipeline(
    fs.createReadStream(tarPath),
    createZstdCompress(),
    fs.createWriteStream(archivePath),
  );
  const body = fs.readFileSync(archivePath);
  return {
    body,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('LocalSpeechModelService', () => {
  it.each([undefined, '', '   '])(
    'rejects an unconfigured model service without a network request (%s)',
    async baseUrl => {
      const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-model-server-'));
      temporaryRoots.push(userDataPath);
      const fetchModel = vi.fn();
      const service = new LocalSpeechModelService({
        userDataPath,
        fetch: fetchModel,
        notify: vi.fn(),
        syncOpenClawConfig: vi.fn(),
        baseUrl,
        resolveModelDir: () => path.join(userDataPath, 'local-speech-models', 'test-asr'),
        artifacts: [
          {
            id: 'test-asr',
            kind: LocalSpeechModelKind.Asr,
            file: 'test.tar.zst',
            sha256: 'a'.repeat(64),
            compressedBytes: 1,
            requiredFiles: ['model.onnx'],
          },
        ],
      });
      expect(service.list().models[0].phase).toBe('not-installed');
      expect(fetchModel).not.toHaveBeenCalled();
      const previousLanguage = getLanguage();
      try {
        setLanguage('en');
        const result = await service.install(LocalSpeechModelKind.Asr, 'test-asr');
        expect(result).toMatchObject({
          success: false,
          status: {
            phase: 'error',
            error: expect.stringContaining('internal speech model server is not configured'),
          },
        });
        expect(fetchModel).not.toHaveBeenCalled();
      } finally {
        setLanguage(previousLanguage);
      }
    },
  );

  it('reuses a complete installed model without a configured server', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-model-server-'));
    temporaryRoots.push(userDataPath);
    const modelDir = path.join(userDataPath, 'local-speech-models', 'test-asr');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'model.onnx'), 'already installed');
    const fetchModel = vi.fn();
    const service = new LocalSpeechModelService({
      userDataPath,
      fetch: fetchModel,
      notify: vi.fn(),
      syncOpenClawConfig: vi.fn(),
      artifacts: [
        {
          id: 'test-asr',
          kind: LocalSpeechModelKind.Asr,
          file: 'test.tar.zst',
          sha256: 'a'.repeat(64),
          compressedBytes: 1,
          requiredFiles: ['model.onnx'],
        },
      ],
      resolveModelDir: () => modelDir,
    });
    expect(await service.install(LocalSpeechModelKind.Asr, 'test-asr')).toMatchObject({
      success: true,
      status: { phase: 'ready' },
    });
    expect(fetchModel).not.toHaveBeenCalled();
  });
  it.each([undefined, ...(process.platform === 'win32' ? ['EPERM', 'EBUSY'] : [])])(
    'downloads, verifies, and atomically installs a model archive (rename error: %s)',
    async renameError => {
      const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-user-data-'));
      temporaryRoots.push(userDataPath);
      const id = 'test-asr';
      const requiredFiles = ['encoder.onnx', 'tokens.txt', 'MODEL-LICENSE.txt'];
      const archive = await createArchive(id, requiredFiles);
      const artifact: LocalSpeechModelArtifact = {
        id,
        kind: LocalSpeechModelKind.Asr,
        file: `${id}.tar.zst`,
        sha256: archive.sha256,
        compressedBytes: archive.body.length,
        requiredFiles,
      };
      const notify = vi.fn();
      const syncOpenClawConfig = vi.fn();
      const fetchModel = vi.fn(
        async () =>
          new Response(archive.body, {
            headers: { 'content-length': String(archive.body.length) },
          }),
      );
      const service = new LocalSpeechModelService({
        userDataPath,
        fetch: fetchModel,
        notify,
        syncOpenClawConfig,
        artifacts: [artifact],
        baseUrl: 'https://example.com/speech-models/v1/',
        resolveModelDir: modelId => path.join(userDataPath, 'local-speech-models', modelId),
      });

      const rename = vi.spyOn(fs.promises, 'rename');
      if (renameError) {
        rename.mockRejectedValueOnce(
          Object.assign(new Error('Temporary model file lock'), { code: renameError }),
        );
      }

      const result = await service.install(LocalSpeechModelKind.Asr, id);

      expect(result.success).toBe(true);
      expect(rename).toHaveBeenCalledTimes(renameError ? 2 : 1);
      expect(fetchModel).toHaveBeenCalledTimes(1);
      expect(syncOpenClawConfig).toHaveBeenCalledWith('local-speech-model-installed');
      expect(result.status).toMatchObject({ phase: 'ready', installed: true });
      expect(fetchModel).toHaveBeenCalledWith(
        `https://example.com/speech-models/v1/${id}.tar.zst`,
        { redirect: 'follow' },
      );
      for (const file of requiredFiles) {
        expect(fs.existsSync(path.join(userDataPath, 'local-speech-models', id, file))).toBe(true);
      }
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ phase: 'downloading' }));
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ready' }));
      await service.remove(LocalSpeechModelKind.Asr, id);
      expect(syncOpenClawConfig).toHaveBeenCalledWith('local-speech-model-removed');
    },
  );

  it.each(['EIO', ...(process.platform === 'win32' ? ['EPERM'] : [])])(
    'reports a persistent directory rename failure without reinstalling (%s)',
    async code => {
      const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-model-rename-'));
      temporaryRoots.push(userDataPath);
      const id = 'test-asr';
      const requiredFiles = ['model.onnx'];
      const archive = await createArchive(id, requiredFiles);
      const artifact: LocalSpeechModelArtifact = {
        id,
        kind: LocalSpeechModelKind.Asr,
        file: `${id}.tar.zst`,
        sha256: archive.sha256,
        compressedBytes: archive.body.length,
        requiredFiles,
      };
      const fetchModel = vi.fn(async () => new Response(archive.body));
      const syncOpenClawConfig = vi.fn();
      const service = new LocalSpeechModelService({
        userDataPath,
        fetch: fetchModel,
        notify: vi.fn(),
        syncOpenClawConfig,
        artifacts: [artifact],
        baseUrl: 'https://artifacts.example.test/',
        resolveModelDir: modelId => path.join(userDataPath, 'local-speech-models', modelId),
      });
      const rename = vi
        .spyOn(fs.promises, 'rename')
        .mockRejectedValue(Object.assign(new Error('Persistent model rename failure'), { code }));

      const result = await service.install(LocalSpeechModelKind.Asr, id);

      expect(result).toMatchObject({
        success: false,
        status: { phase: 'error', installed: false, error: 'Persistent model rename failure' },
      });
      expect(rename).toHaveBeenCalledTimes(code === 'EPERM' ? 5 : 1);
      expect(fetchModel).toHaveBeenCalledTimes(1);
      expect(syncOpenClawConfig).not.toHaveBeenCalled();
      expect(fs.readdirSync(path.join(userDataPath, 'local-speech-models'))).toEqual([
        '.downloads',
      ]);
      expect(fs.readdirSync(path.join(userDataPath, 'local-speech-models', '.downloads'))).toEqual(
        [],
      );
    },
  );

  it('rejects a model whose SHA-256 does not match and leaves no partial installation', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-user-data-'));
    temporaryRoots.push(userDataPath);
    const id = 'test-tts';
    const requiredFiles = ['model.onnx', 'MODEL-LICENSE.txt'];
    const archive = await createArchive(id, requiredFiles);
    const artifact: LocalSpeechModelArtifact = {
      id,
      kind: LocalSpeechModelKind.Tts,
      file: `${id}.tar.zst`,
      sha256: '0'.repeat(64),
      compressedBytes: archive.body.length,
      requiredFiles,
    };
    const service = new LocalSpeechModelService({
      userDataPath,
      fetch: async () =>
        new Response(archive.body, {
          headers: { 'content-length': String(archive.body.length) },
        }),
      notify: vi.fn(),
      syncOpenClawConfig: vi.fn(),
      artifacts: [artifact],
      baseUrl: 'https://updates.example.test/speech-models/v1/',
      resolveModelDir: modelId => path.join(userDataPath, 'local-speech-models', modelId),
    });

    const result = await service.install(LocalSpeechModelKind.Tts, id);

    expect(result).toMatchObject({
      success: false,
      status: { phase: 'error', installed: false },
    });
    expect(fs.existsSync(path.join(userDataPath, 'local-speech-models', id))).toBe(false);
  });

  it('loads unpublished artifact integrity metadata from the update-server manifest', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-user-data-'));
    temporaryRoots.push(userDataPath);
    const id = 'catalog-asr';
    const requiredFiles = ['model.onnx', 'MODEL-LICENSE.txt'];
    const archive = await createArchive(id, requiredFiles);
    const artifact: LocalSpeechModelArtifact = {
      id,
      kind: LocalSpeechModelKind.Asr,
      file: `${id}.tar.zst`,
      sha256: '',
      compressedBytes: 0,
      requiredFiles,
    };
    const fetchModel = vi.fn(async (url: string) => {
      if (url.endsWith('/manifest.json')) {
        return Response.json({
          version: 1,
          models: [
            {
              id,
              file: artifact.file,
              sha256: archive.sha256,
              compressedBytes: archive.body.length,
            },
          ],
        });
      }
      return new Response(archive.body, {
        headers: { 'content-length': String(archive.body.length) },
      });
    });
    const service = new LocalSpeechModelService({
      userDataPath,
      fetch: fetchModel,
      notify: vi.fn(),
      syncOpenClawConfig: vi.fn(),
      artifacts: [artifact],
      baseUrl: 'https://updates.example.test/speech-models/v1/',
      resolveModelDir: modelId => path.join(userDataPath, 'local-speech-models', modelId),
    });

    const result = await service.install(LocalSpeechModelKind.Asr, id);

    expect(result.success).toBe(true);
    expect(fetchModel).toHaveBeenNthCalledWith(
      1,
      'https://updates.example.test/speech-models/v1/manifest.json',
      { cache: 'no-store', redirect: 'follow' },
    );
    expect(fetchModel).toHaveBeenNthCalledWith(
      2,
      `https://updates.example.test/speech-models/v1/${id}.tar.zst`,
      { redirect: 'follow' },
    );
  });

  it('removes an installed model and publishes its unavailable status', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-user-data-'));
    temporaryRoots.push(userDataPath);
    const id = 'removable-tts';
    const modelDir = path.join(userDataPath, 'local-speech-models', id);
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'model.onnx'), 'fixture');
    const artifact: LocalSpeechModelArtifact = {
      id,
      kind: LocalSpeechModelKind.Tts,
      file: `${id}.tar.zst`,
      sha256: '0'.repeat(64),
      compressedBytes: 1,
      requiredFiles: ['model.onnx'],
    };
    const notify = vi.fn();
    const syncOpenClawConfig = vi.fn().mockResolvedValue(undefined);
    const service = new LocalSpeechModelService({
      userDataPath,
      fetch: vi.fn(),
      notify,
      syncOpenClawConfig,
      artifacts: [artifact],
      resolveModelDir: () => modelDir,
    });

    const result = await service.remove(LocalSpeechModelKind.Tts, id);

    expect(result).toMatchObject({
      success: true,
      status: { phase: 'not-installed', installed: false },
    });
    expect(fs.existsSync(modelDir)).toBe(false);
    expect(syncOpenClawConfig).toHaveBeenCalledWith('local-speech-model-removed');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id, installed: false }));
  });
});
