import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_SPEECH_MODEL_ARTIFACTS,
  LocalSpeechModelService,
} from '../src/main/speech/localSpeechModelService';

const artifactRoot = path.resolve('build/speech-models/v1');
const manifestPath = path.join(artifactRoot, 'manifest.json');

// Release verification uses real generated archives; ordinary source-only runs skip it.
describe.skipIf(!fs.existsSync(manifestPath) || process.platform !== 'win32')(
  'generated local speech artifacts',
  () => {
    it.each(LOCAL_SPEECH_MODEL_ARTIFACTS)(
      'installs $id with the compiled-in integrity metadata',
      async artifact => {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        expect(manifest.models).toContainEqual({
          id: artifact.id,
          file: artifact.file,
          sha256: artifact.sha256,
          compressedBytes: artifact.compressedBytes,
        });
        const userDataPath = fs.mkdtempSync(
          path.join(os.tmpdir(), 'justdo-artifact-verification-'),
        );
        try {
          const fetchModel = vi.fn(async (url: string | URL | Request) => {
            expect(String(url)).toBe(`https://artifacts.example.test/${artifact.file}`);
            const archivePath = path.join(artifactRoot, artifact.file);
            return new Response(
              Readable.toWeb(fs.createReadStream(archivePath)) as ReadableStream,
              {
                headers: { 'content-length': String(fs.statSync(archivePath).size) },
              },
            );
          });
          const service = new LocalSpeechModelService({
            userDataPath,
            fetch: fetchModel,
            notify: vi.fn(),
            syncOpenClawConfig: vi.fn(),
            baseUrl: 'https://artifacts.example.test/',
            resolveModelDir: id => path.join(userDataPath, 'local-speech-models', id),
          });
          const result = await service.install(artifact.kind, artifact.id);
          expect(result.status.error).toBeUndefined();
          expect(result.success).toBe(true);
          expect(fetchModel).toHaveBeenCalledTimes(1);
          for (const file of artifact.requiredFiles) {
            expect(
              fs.existsSync(path.join(userDataPath, 'local-speech-models', artifact.id, file)),
            ).toBe(true);
          }
        } finally {
          fs.rmSync(userDataPath, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
