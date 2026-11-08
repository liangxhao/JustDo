import fs from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';
import { expect, test } from 'vitest';

const source = path.resolve(import.meta.dirname, '..');

test('ships generic speech entry points without account, browser-media or private transport dependencies', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
  expect(pkg.openclaw.build.workerEntries ?? []).toEqual([]);
  expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
  expect(Object.keys(pkg.dependencies).sort()).toEqual(['jose', 'ws', 'zod']);
  const result = await build({
    entryPoints: [
      'speech-provider.ts',
      'realtime-transcription-provider-factory.ts',
      'managed-realtime-voice-provider.ts',
      'audio-transcription.ts',
    ].map(name => path.join(source, name)),
    outdir: path.resolve('build/speech-source-boundary'),
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  const localInputs = Object.keys(result.metafile!.inputs)
    .map(input => path.relative(source, path.resolve(input)).replaceAll('\\', '/'))
    .filter(input => !input.startsWith('../'));
  expect(localInputs.length).toBeGreaterThan(4);
  expect(localInputs.filter(input => /account|oauth|chatgpt|webrtc|worker/i.test(input))).toEqual(
    [],
  );
  const externalImports = Object.values(result.metafile!.outputs)
    .flatMap(output => output.imports)
    .filter(dependency => dependency.external)
    .map(dependency => dependency.path);
  expect(externalImports.some(name => /oauth|provider-auth|webrtc|opus|werift/i.test(name))).toBe(
    false,
  );
  expect(externalImports).toContain('ws');
});
