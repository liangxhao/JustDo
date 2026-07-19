import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ZipFile } from 'yazl';

import { OpenClawHookFiles } from './openclawHookFiles';

let root: string;
let managed: string;

const createHook = (directory: string, name = 'demo-hook'): void => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'HOOK.md'),
    `---\nname: ${name}\ndescription: Demo Hook\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n`,
  );
  fs.writeFileSync(path.join(directory, 'handler.js'), 'export default async () => {};\n');
};

const writeZip = async (zipPath: string, entries: Record<string, string>): Promise<void> => {
  const zip = new ZipFile();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.addBuffer(Buffer.from(content), entryPath);
  }
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(fs.createWriteStream(zipPath)).on('close', resolve).on('error', reject);
    zip.end();
  });
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-hook-files-test-'));
  managed = path.join(root, 'managed');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('imports a valid Hook folder into the managed directory', async () => {
  const source = path.join(root, 'source');
  createHook(source);

  await expect(new OpenClawHookFiles(managed).importPath(source)).resolves.toEqual({
    success: true,
    hookId: 'demo-hook',
  });
  expect(fs.existsSync(path.join(managed, 'demo-hook', 'HOOK.md'))).toBe(true);
  expect(fs.existsSync(path.join(managed, 'demo-hook', 'handler.js'))).toBe(true);
});

test('requires both Hook metadata and a runnable JavaScript handler', async () => {
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'HOOK.md'), '---\nname: incomplete\n---\n');

  const result = await new OpenClawHookFiles(managed).importPath(source);

  expect(result.success).toBe(false);
  expect(result.error).toContain('handler.js');
});

test('imports a zipped Hook package with one wrapper directory', async () => {
  const archivePath = path.join(root, 'demo-hook.zip');
  await writeZip(archivePath, {
    'demo-hook/HOOK.md': '---\nname: zipped-hook\ndescription: Demo\n---\n',
    'demo-hook/handler.js': 'export default async () => {};\n',
  });

  const result = await new OpenClawHookFiles(managed).importPath(archivePath);

  expect(result).toEqual({ success: true, hookId: 'zipped-hook' });
  expect(fs.existsSync(path.join(managed, 'zipped-hook', 'handler.js'))).toBe(true);
});

test('rejects an imported Hook that conflicts with a built-in Hook', async () => {
  const source = path.join(root, 'source');
  createHook(source, 'session-memory');

  const result = await new OpenClawHookFiles(managed, new Set(['session-memory'])).importPath(
    source,
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain('built-in Hook');
  expect(fs.existsSync(path.join(managed, 'session-memory'))).toBe(false);
});

test('deletes only a Hook inside the managed Hook directory', async () => {
  const hookDir = path.join(managed, 'custom-hook');
  createHook(hookDir, 'custom-hook');
  const files = new OpenClawHookFiles(managed);

  files.deleteDirectory(hookDir);

  expect(fs.existsSync(hookDir)).toBe(false);
  expect(() => files.deleteDirectory(path.join(root, 'outside'))).toThrow('Invalid Hook directory');
});
