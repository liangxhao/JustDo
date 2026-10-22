import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { copySourceCodexAuth } from '../../../plugins/extensions/acpx/src/codex-auth-file.js';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justdo-codex-auth-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Codex auth bridge', () => {
  test('copies token-based auth into the isolated Codex home without interpreting it', async () => {
    const root = await makeTemporaryDirectory();
    const sourceCodexHome = path.join(root, 'source');
    const isolatedCodexHome = path.join(root, 'isolated');
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.mkdir(isolatedCodexHome, { recursive: true });
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'secret' } });
    await fs.writeFile(path.join(sourceCodexHome, 'auth.json'), auth, 'utf8');

    await copySourceCodexAuth({
      sourceCodexHome,
      isolatedCodexHome,
    });

    await expect(fs.readFile(path.join(isolatedCodexHome, 'auth.json'), 'utf8')).resolves.toBe(
      auth,
    );
  });

  test('keeps an existing isolated login when the source auth file is absent', async () => {
    const root = await makeTemporaryDirectory();
    const sourceCodexHome = path.join(root, 'source');
    const isolatedCodexHome = path.join(root, 'isolated');
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.mkdir(isolatedCodexHome, { recursive: true });
    await fs.writeFile(path.join(isolatedCodexHome, 'auth.json'), 'isolated-auth', 'utf8');

    await copySourceCodexAuth({
      sourceCodexHome,
      isolatedCodexHome,
    });

    await expect(fs.readFile(path.join(isolatedCodexHome, 'auth.json'), 'utf8')).resolves.toBe(
      'isolated-auth',
    );
  });

  test('does not replace a more recently refreshed isolated login', async () => {
    const root = await makeTemporaryDirectory();
    const sourceCodexHome = path.join(root, 'source');
    const isolatedCodexHome = path.join(root, 'isolated');
    const sourceAuthPath = path.join(sourceCodexHome, 'auth.json');
    const isolatedAuthPath = path.join(isolatedCodexHome, 'auth.json');
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.mkdir(isolatedCodexHome, { recursive: true });
    await fs.writeFile(sourceAuthPath, 'older-source-auth', 'utf8');
    await fs.writeFile(isolatedAuthPath, 'newer-isolated-auth', 'utf8');
    await fs.utimes(sourceAuthPath, new Date(1_000), new Date(1_000));
    await fs.utimes(isolatedAuthPath, new Date(2_000), new Date(2_000));

    await copySourceCodexAuth({
      sourceCodexHome,
      isolatedCodexHome,
    });

    await expect(fs.readFile(isolatedAuthPath, 'utf8')).resolves.toBe('newer-isolated-auth');
  });
});
