import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ZipFile } from 'yazl';

import { t } from '../../core/i18n';
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
  vi.restoreAllMocks();
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

test.each(['EPERM', 'ENOSPC'])(
  'a later copy failure %s leaves no installed Hook and allows retry',
  async code => {
    const source = path.join(root, 'source');
    const installed = path.join(managed, 'existing-hook');
    createHook(source);
    fs.writeFileSync(path.join(source, 'payload.txt'), 'Hook companion');
    createHook(installed, 'existing-hook');
    const originalHandler = fs.readFileSync(path.join(installed, 'handler.js'), 'utf8');
    const copyFile = fs.copyFileSync;
    let copied = 0;
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      copied += 1;
      if (copied === 3) {
        throw Object.assign(new Error('A later Hook file could not be copied'), {
          code,
          syscall: 'copyfile',
        });
      }
      copyFile(from, to, mode);
    });
    const files = new OpenClawHookFiles(managed);

    const failed = await files.importPath(source);

    expect(failed.success).toBe(false);
    expect(failed.error).toContain('A later Hook file could not be copied');
    expect(copied).toBe(3);
    expect(fs.existsSync(path.join(managed, 'demo-hook'))).toBe(false);
    expect(fs.readFileSync(path.join(installed, 'handler.js'), 'utf8')).toBe(originalHandler);
    expect(fs.readdirSync(root).some(name => name.startsWith('.hook-stage-'))).toBe(false);

    copy.mockRestore();
    await expect(files.importPath(source)).resolves.toEqual({
      success: true,
      hookId: 'demo-hook',
    });
    expect(fs.readFileSync(path.join(managed, 'demo-hook', 'payload.txt'), 'utf8')).toBe(
      'Hook companion',
    );
  },
);

test('validates the copied Hook identity before publishing the managed directory', async () => {
  const source = path.join(root, 'source');
  createHook(source);
  const copyFile = fs.copyFileSync;
  vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
    copyFile(from, to, mode);
    if (path.basename(String(from)) === 'HOOK.md') {
      fs.writeFileSync(to, '---\nname: unexpected-hook\n---\n');
    }
  });

  const result = await new OpenClawHookFiles(managed).importPath(source);

  expect(result.success).toBe(false);
  expect(fs.existsSync(path.join(managed, 'demo-hook'))).toBe(false);
  expect(fs.existsSync(path.join(managed, 'unexpected-hook'))).toBe(false);
  expect(fs.readdirSync(root).some(name => name.startsWith('.hook-stage-'))).toBe(false);
});

test('rejects a directory link introduced during staging without publishing or touching its target', async () => {
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside');
  createHook(source);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'kept.txt'), 'Outside data');
  const copyFile = fs.copyFileSync;
  let injected = false;
  vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
    copyFile(from, to, mode);
    if (!injected) {
      injected = true;
      fs.symlinkSync(outside, path.join(path.dirname(String(to)), 'injected-link'), 'junction');
    }
  });

  const result = await new OpenClawHookFiles(managed).importPath(source);

  expect(result.success).toBe(false);
  expect(result.error).toContain('symbolic links');
  expect(fs.existsSync(path.join(managed, 'demo-hook'))).toBe(false);
  expect(fs.readFileSync(path.join(outside, 'kept.txt'), 'utf8')).toBe('Outside data');
});

test('rejects an existing Hook without copying or replacing its files', async () => {
  const source = path.join(root, 'source');
  const installed = path.join(managed, 'demo-hook');
  createHook(source);
  createHook(installed);
  fs.writeFileSync(path.join(installed, 'handler.js'), 'Original installed handler');
  const copy = vi.spyOn(fs, 'copyFileSync');

  const result = await new OpenClawHookFiles(managed).importPath(source);

  expect(result.success).toBe(false);
  expect(result.error).toBe(t('hookAlreadyInstalled', { hookId: 'demo-hook' }));
  expect(copy).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(installed, 'handler.js'), 'utf8')).toBe(
    'Original installed handler',
  );
});

test.each(['hook', 'empty-directory', 'directory-link'])(
  'does not replace a same-ID %s that appears during staging',
  async kind => {
    const source = path.join(root, 'source');
    const target = path.join(managed, 'demo-hook');
    const outside = path.join(root, 'outside');
    createHook(source);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'kept.txt'), 'Outside data');
    const copyFile = fs.copyFileSync;
    let injected = false;
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      copyFile(from, to, mode);
      if (!injected) {
        injected = true;
        if (kind === 'hook') {
          createHook(target);
          fs.writeFileSync(path.join(target, 'handler.js'), 'Other installation');
        } else if (kind === 'empty-directory') {
          fs.mkdirSync(target);
        } else {
          fs.symlinkSync(outside, target, 'junction');
        }
      }
    });
    const files = new OpenClawHookFiles(managed);

    const result = await files.importPath(source);

    expect(result.success).toBe(false);
    expect(result.error).toBe(t('hookAlreadyInstalled', { hookId: 'demo-hook' }));
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(kind === 'directory-link');
    if (kind === 'hook') {
      expect(fs.readFileSync(path.join(target, 'handler.js'), 'utf8')).toBe('Other installation');
    } else if (kind === 'empty-directory') {
      expect(fs.readdirSync(target)).toEqual([]);
    }
    expect(fs.readFileSync(path.join(outside, 'kept.txt'), 'utf8')).toBe('Outside data');
    expect(fs.readdirSync(root).some(name => name.startsWith('.hook-stage-'))).toBe(false);

    copy.mockRestore();
    if (kind === 'directory-link') fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true });
    await expect(files.importPath(source)).resolves.toEqual({
      success: true,
      hookId: 'demo-hook',
    });
  },
);

test('keeps another completed installation if it appears at the native publish call', async () => {
  const source = path.join(root, 'source');
  const target = path.join(managed, 'demo-hook');
  createHook(source);
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (path.basename(String(from)) === 'next' && String(to) === target) {
      createHook(target);
      fs.writeFileSync(path.join(target, 'handler.js'), 'Concurrent installed handler');
    }
    rename(from, to);
  });

  const result = await new OpenClawHookFiles(managed).importPath(source);

  expect(result.success).toBe(false);
  expect(result.error).toBe(t('hookAlreadyInstalled', { hookId: 'demo-hook' }));
  expect(fs.readFileSync(path.join(target, 'handler.js'), 'utf8')).toBe(
    'Concurrent installed handler',
  );
  expect(fs.readdirSync(root).some(name => name.startsWith('.hook-stage-'))).toBe(false);
});

test('requires both Hook metadata and a supported handler entrypoint', async () => {
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'HOOK.md'), '---\nname: incomplete\n---\n');

  const result = await new OpenClawHookFiles(managed).importPath(source);

  expect(result.success).toBe(false);
  expect(result.error).toContain('handler.ts');
});

test('accepts the latest TypeScript handler entrypoint', async () => {
  const source = path.join(root, 'source');
  createHook(source, 'typescript-hook');
  fs.renameSync(path.join(source, 'handler.js'), path.join(source, 'handler.ts'));

  await expect(new OpenClawHookFiles(managed).importPath(source)).resolves.toEqual({
    success: true,
    hookId: 'typescript-hook',
  });
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

test('can roll back an atomically staged Hook deletion', () => {
  const hookDir = path.join(managed, 'custom-hook');
  createHook(hookDir, 'custom-hook');
  const staged = new OpenClawHookFiles(managed).stageDeleteDirectory(hookDir);

  expect(fs.existsSync(hookDir)).toBe(false);
  staged.rollback();
  expect(fs.existsSync(path.join(hookDir, 'HOOK.md'))).toBe(true);
});
