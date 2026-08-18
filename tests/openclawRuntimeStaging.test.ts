import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { commitStagedRuntime, prepareStagedRuntimeForCommit } =
  require('../scripts/openclaw-runtime-staging.cjs') as {
    commitStagedRuntime: (
      stagedDir: string,
      targetDir: string,
      currentDir: string,
      options?: { renameDirectory?: (source: string, target: string) => void },
    ) => void;
    prepareStagedRuntimeForCommit: (
      stagedDir: string,
      targetDir: string,
      options?: { platform?: string },
    ) => string;
  };

const temporaryRoots: string[] = [];

function createFixture() {
  const runtimeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-staging-'));
  temporaryRoots.push(runtimeBase);
  const targetDir = path.join(runtimeBase, 'win-x64');
  const stagedDir = path.join(runtimeBase, '.win-x64.staging-test');
  const currentDir = path.join(runtimeBase, 'current');
  fs.mkdirSync(targetDir);
  fs.mkdirSync(stagedDir);
  fs.writeFileSync(path.join(targetDir, 'version.txt'), 'old\n');
  fs.writeFileSync(path.join(stagedDir, 'version.txt'), 'new\n');
  fs.symlinkSync(targetDir, currentDir, process.platform === 'win32' ? 'junction' : 'dir');
  return { currentDir, runtimeBase, stagedDir, targetDir };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('OpenClaw staged runtime commit', () => {
  test('atomically replaces the target and restores the current link', () => {
    const { currentDir, runtimeBase, stagedDir, targetDir } = createFixture();
    const commitCandidate = prepareStagedRuntimeForCommit(stagedDir, targetDir, {
      platform: 'win32',
    });

    expect(commitCandidate).not.toBe(stagedDir);
    expect(fs.readFileSync(path.join(commitCandidate, 'version.txt'), 'utf8')).toBe('new\n');
    commitStagedRuntime(commitCandidate, targetDir, currentDir);

    expect(fs.readFileSync(path.join(targetDir, 'version.txt'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(currentDir, 'version.txt'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(stagedDir, 'version.txt'), 'utf8')).toBe('new\n');
    expect(fs.readdirSync(runtimeBase).some(entry => entry.includes('.backup-'))).toBe(false);
  });

  test('restores the previous target and current link when staging install fails', () => {
    const { currentDir, runtimeBase, stagedDir, targetDir } = createFixture();
    const nativeRename = fs.renameSync;
    const injectedError = new Error('injected staging rename failure');

    expect(() =>
      commitStagedRuntime(stagedDir, targetDir, currentDir, {
        renameDirectory(source, target) {
          if (path.resolve(source) === path.resolve(stagedDir)) throw injectedError;
          nativeRename(source, target);
        },
      }),
    ).toThrow(injectedError);

    expect(fs.readFileSync(path.join(targetDir, 'version.txt'), 'utf8')).toBe('old\n');
    expect(fs.readFileSync(path.join(currentDir, 'version.txt'), 'utf8')).toBe('old\n');
    expect(fs.readFileSync(path.join(stagedDir, 'version.txt'), 'utf8')).toBe('new\n');
    expect(fs.readdirSync(runtimeBase).some(entry => entry.includes('.backup-'))).toBe(false);
  });
});
