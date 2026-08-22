import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validatePreparedMinGit } = require('../../scripts/setup-mingit.js') as {
  validatePreparedMinGit: (
    baseDir: string,
    options?: { platform?: NodeJS.Platform },
  ) => { ok: boolean; gitPath: string | null; reason: string | null };
};
const tempDirs: string[] = [];

const createMinGitFixture = (version = '2.55.0.3-1'): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-setup-mingit-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'cmd'), { recursive: true });
  mkdirSync(path.join(root, 'etc'), { recursive: true });
  writeFileSync(path.join(root, 'cmd', 'git.exe'), 'git');
  writeFileSync(
    path.join(root, 'etc', 'package-versions.txt'),
    `mingw-w64-x86_64-git ${version}\n`,
  );
  return root;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('MinGit setup validation', () => {
  it('accepts the pinned MinGit package version on cross-platform build hosts', () => {
    const root = createMinGitFixture();

    const result = validatePreparedMinGit(root, { platform: 'linux' });

    expect(result).toEqual({
      ok: true,
      gitPath: path.join(root, 'cmd', 'git.exe'),
      reason: null,
    });
  });

  it('rejects an archive containing a different Git version', () => {
    const root = createMinGitFixture('2.47.1-1');

    const result = validatePreparedMinGit(root, { platform: 'linux' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not identify MinGit 2.55.0.3');
  });

  it('rejects incomplete MinGit layouts', () => {
    const root = createMinGitFixture();
    rmSync(path.join(root, 'etc', 'package-versions.txt'));

    const result = validatePreparedMinGit(root, { platform: 'linux' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('version manifest is missing');
  });
});
