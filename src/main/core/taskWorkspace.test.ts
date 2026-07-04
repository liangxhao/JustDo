import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { resolveTaskWorkingDirectory } from './taskWorkspace';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveTaskWorkingDirectory', () => {
  test('creates and returns a missing workspace directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-workspace-'));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, 'nested', 'project');

    expect(resolveTaskWorkingDirectory(workspace)).toBe(path.resolve(workspace));
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
  });

  test('rejects a path that points to a file', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-workspace-'));
    temporaryDirectories.push(parent);
    const filePath = path.join(parent, 'file.txt');
    fs.writeFileSync(filePath, '');

    expect(() => resolveTaskWorkingDirectory(filePath)).toThrow(
      `Selected workspace is not a directory: ${path.resolve(filePath)}`,
    );
  });
});
