import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
}));

import { resolveShellOpenPath } from './shell';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps an absolute attachment path unchanged', () => {
  const absolutePath = path.resolve('existing', 'report.pdf');

  expect(resolveShellOpenPath(absolutePath, path.resolve('workspace'))).toBe(absolutePath);
});

test('resolves an existing relative attachment path against the session working directory', () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-media-'));
  temporaryDirectories.push(workingDirectory);
  const relativePath = path.join('output', 'report.pdf');
  const absolutePath = path.join(workingDirectory, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, 'report');

  expect(resolveShellOpenPath(relativePath, workingDirectory)).toBe(absolutePath);
});

test('keeps a missing relative attachment path unchanged', () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-media-'));
  temporaryDirectories.push(workingDirectory);
  const relativePath = path.join('missing', 'report.pdf');

  expect(resolveShellOpenPath(relativePath, workingDirectory)).toBe(relativePath);
});
