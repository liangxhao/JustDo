import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { syncDocChannels, syncGatewayConfigChannels } =
  require('../scripts/sync-openclaw-runtime-resources.cjs') as {
    syncDocChannels: (
      repoRoot: string,
      runtimeRoot: string,
      label: string,
    ) => {
      sourceDir: string;
      targetDir: string;
      copiedFiles: number;
    };
    syncGatewayConfigChannels: (
      repoRoot: string,
      runtimeRoot: string,
      label: string,
    ) => {
      sourceFile: string;
      targetFile: string;
    };
  };

test('replaces OpenClaw doc channels and removes stale target files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const sourceDir = path.join(repoRoot, 'resources', 'docs', 'channels');
  const targetDir = path.join(runtimeRoot, 'docs', 'channels');
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.md'), 'replacement', 'utf8');
    fs.writeFileSync(path.join(sourceDir, 'nested', 'guide.md'), 'guide', 'utf8');
    fs.mkdirSync(path.join(targetDir, 'stale'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'obsolete.md'), 'obsolete', 'utf8');
    fs.writeFileSync(path.join(targetDir, 'stale', 'old.md'), 'old', 'utf8');
    const result = syncDocChannels(repoRoot, runtimeRoot, 'test');

    expect(result).toEqual({ sourceDir, targetDir, copiedFiles: 2 });
    expect(fs.readFileSync(path.join(targetDir, 'index.md'), 'utf8')).toBe('replacement');
    expect(fs.readFileSync(path.join(targetDir, 'nested', 'guide.md'), 'utf8')).toBe('guide');
    expect(fs.existsSync(path.join(targetDir, 'obsolete.md'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'stale'))).toBe(false);
  } finally {
    logSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('replaces the OpenClaw gateway channel config document', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const sourceFile = path.join(repoRoot, 'resources', 'docs', 'gateway', 'config-channels.md');
  const targetFile = path.join(runtimeRoot, 'docs', 'gateway', 'config-channels.md');
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, 'replacement', 'utf8');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, 'original', 'utf8');

    const result = syncGatewayConfigChannels(repoRoot, runtimeRoot, 'test');

    expect(result).toEqual({ sourceFile, targetFile });
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('replacement');
  } finally {
    logSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
