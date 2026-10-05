import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPackage } from '@electron/asar';
import { afterEach, expect, test } from 'vitest';

const { extractRuntimeEntryFiles } =
  require('../../../scripts/openclaw/sync-openclaw-runtime-current.cjs') as {
    extractRuntimeEntryFiles: (runtimeRoot: string) => number;
  };

const temporaryRoots: string[] = [];

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-extraction-'));
  temporaryRoots.push(root);
  const source = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  const files = {
    'openclaw.mjs': '// CLI',
    'node-version.mjs': '// version',
    'package.json': '{}',
    'dist/entry.js': '// entry',
    'dist/config/sessions/session-transcript.worker.js': '// transcript worker',
    'dist/cron/store/read-only.worker.js': '// cron worker',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), content);
  }
  fs.mkdirSync(runtimeRoot);
  await createPackage(source, path.join(runtimeRoot, 'gateway.asar'));
  return { runtimeRoot, files };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('extracts nested workers even when all CLI entry files already exist', async () => {
  const { runtimeRoot, files } = await createFixture();
  for (const name of ['openclaw.mjs', 'node-version.mjs', 'dist/entry.js', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(runtimeRoot, name)), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, name), 'existing frozen file');
  }

  expect(extractRuntimeEntryFiles(runtimeRoot)).toBe(2);
  for (const name of Object.keys(files).filter(name => name.includes('worker'))) {
    expect(fs.readFileSync(path.join(runtimeRoot, name), 'utf8')).toBe(
      files[name as keyof typeof files],
    );
  }
  expect(fs.readFileSync(path.join(runtimeRoot, 'dist/entry.js'), 'utf8')).toBe(
    'existing frozen file',
  );
  expect(extractRuntimeEntryFiles(runtimeRoot)).toBe(0);
});

test('extracts the complete entry tree from a newly installed archive', async () => {
  const { runtimeRoot, files } = await createFixture();

  expect(extractRuntimeEntryFiles(runtimeRoot)).toBe(Object.keys(files).length);
  for (const [name, content] of Object.entries(files)) {
    expect(fs.readFileSync(path.join(runtimeRoot, name), 'utf8')).toBe(content);
  }
});

test('reports extraction failures instead of treating them as directory entries', async () => {
  const { runtimeRoot } = await createFixture();
  fs.writeFileSync(path.join(runtimeRoot, 'dist'), 'invalid directory');

  expect(() => extractRuntimeEntryFiles(runtimeRoot)).toThrow();
});
