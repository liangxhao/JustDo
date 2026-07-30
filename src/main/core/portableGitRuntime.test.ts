import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import {
  applyPortableGitRuntimeEnv,
  resolvePortableGitExecutables,
} from './portableGitRuntime';

const tempDirs: string[] = [];

const createPortableGitFixture = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-portable-git-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'bash.exe'), '');
  fs.writeFileSync(path.join(root, 'bin', 'git.exe'), '');
  return root;
};

const createAlternativePortableGitFixture = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-portable-git-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cmd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'usr', 'bin', 'bash.exe'), '');
  fs.writeFileSync(path.join(root, 'cmd', 'git.exe'), '');
  return root;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exposes bundled Git Bash on PATH without changing the default Windows shell', () => {
  const root = createPortableGitFixture();
  const existingPath = 'C:\\Windows\\System32';
  const env: Record<string, string | undefined> = { Path: existingPath };

  applyPortableGitRuntimeEnv(env, { platform: 'win32', portableGitRoot: root });

  expect(env.PATH).toBe(`${path.join(root, 'bin')};${existingPath}`);
  expect(env.Path).toBe(env.PATH);
  expect(env.JUSTDO_PORTABLE_GIT_ROOT).toBe(root);
  expect(env.JUSTDO_BASH_PATH).toBe(path.join(root, 'bin', 'bash.exe'));
  expect(env.SHELL).toBeUndefined();
  expect(env.OPENCLAW_SHELL).toBeUndefined();
});

test('preserves an explicitly configured shell', () => {
  const root = createPortableGitFixture();
  const env: Record<string, string | undefined> = {
    PATH: 'C:\\Windows',
    SHELL: 'C:\\custom\\shell.exe',
    OPENCLAW_SHELL: 'powershell',
  };

  applyPortableGitRuntimeEnv(env, { platform: 'win32', portableGitRoot: root });

  expect(env.SHELL).toBe('C:\\custom\\shell.exe');
  expect(env.OPENCLAW_SHELL).toBe('powershell');
});

test('supports the alternative PortableGit layout accepted by packaging', () => {
  const root = createAlternativePortableGitFixture();
  const env: Record<string, string | undefined> = { PATH: 'C:\\Windows' };

  const executables = resolvePortableGitExecutables(root);
  applyPortableGitRuntimeEnv(env, { platform: 'win32', portableGitRoot: root });

  expect(executables).toEqual({
    root,
    bashPath: path.join(root, 'usr', 'bin', 'bash.exe'),
    gitPath: path.join(root, 'cmd', 'git.exe'),
  });
  expect(env.PATH).toBe(
    [
      path.join(root, 'usr', 'bin'),
      path.join(root, 'cmd'),
      'C:\\Windows',
    ].join(';'),
  );
  expect(env.JUSTDO_BASH_PATH).toBe(path.join(root, 'usr', 'bin', 'bash.exe'));
});

test('keeps PATH entries unique across casing differences and repeated application', () => {
  const root = createPortableGitFixture();
  const binDir = path.join(root, 'bin');
  const env: Record<string, string | undefined> = {
    PATH: `${binDir.toUpperCase()};C:\\Windows`,
  };

  applyPortableGitRuntimeEnv(env, { platform: 'win32', portableGitRoot: root });
  applyPortableGitRuntimeEnv(env, { platform: 'win32', portableGitRoot: root });

  expect(env.PATH?.split(';')).toEqual([binDir, 'C:\\Windows']);
  expect(env.Path).toBe(env.PATH);
  expect(env.SHELL).toBeUndefined();
  expect(env.OPENCLAW_SHELL).toBeUndefined();
});

test('does not change non-Windows environments', () => {
  const root = createPortableGitFixture();
  const env: Record<string, string | undefined> = { PATH: '/usr/bin' };

  applyPortableGitRuntimeEnv(env, { platform: 'linux', portableGitRoot: root });

  expect(env).toEqual({ PATH: '/usr/bin' });
});

test('does not advertise an incomplete PortableGit runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-portable-git-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'bash.exe'), '');
  const env: Record<string, string | undefined> = { PATH: 'C:\\Windows' };

  applyPortableGitRuntimeEnv(env, { platform: 'win32', portableGitRoot: root });

  expect(env).toEqual({ PATH: 'C:\\Windows' });
});
