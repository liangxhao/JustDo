import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { cpRecursiveSync } from './fsCompat';

const roots: string[] = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-copy-test-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.runIf(process.platform === 'win32')(
  'preserves a skill folder directory junction without ordinary symlink privileges',
  () => {
    const root = makeRoot();
    const source = path.join(root, 'source');
    const shared = path.join(root, 'dependency');
    const destination = path.join(root, 'installed');
    fs.mkdirSync(source);
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# Sample skill');
    fs.writeFileSync(path.join(shared, 'dependency.js'), 'export const value = 1;');
    fs.symlinkSync(shared, path.join(source, 'dependency'), 'junction');
    const symlink = fs.symlinkSync.bind(fs);
    vi.spyOn(fs, 'symlinkSync').mockImplementation((target, link, type) => {
      if (type !== 'junction') {
        throw Object.assign(new Error('Ordinary symlink privileges unavailable'), {
          code: 'EPERM',
        });
      }
      return symlink(target, link, type);
    });

    cpRecursiveSync(source, destination, { force: true });

    expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).toBe('# Sample skill');
    expect(fs.lstatSync(path.join(destination, 'dependency')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(destination, 'dependency'))).toBe(fs.realpathSync(shared));
    fs.unlinkSync(path.join(destination, 'dependency'));
    expect(fs.readFileSync(path.join(shared, 'dependency.js'), 'utf8')).toBe(
      'export const value = 1;',
    );
  },
);

test.each([
  { platform: 'linux', target: '/absolute/dependency', directory: true, exists: true },
  { platform: 'win32', target: '../dependency', directory: true, exists: true },
  { platform: 'win32', target: 'C:\\dependency.js', directory: false, exists: true },
  { platform: 'win32', target: 'C:\\missing', directory: false, exists: false },
])('keeps existing link semantics for $platform $target', fixture => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(fixture.platform as NodeJS.Platform);
  vi.spyOn(fs, 'lstatSync').mockReturnValue({
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => true,
  } as fs.Stats);
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  vi.spyOn(fs, 'readlinkSync').mockReturnValue(fixture.target);
  const stat = vi
    .spyOn(fs, 'statSync')
    .mockReturnValue(
      fixture.exists ? ({ isDirectory: () => fixture.directory } as fs.Stats) : undefined,
    );
  const symlink = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => undefined);

  cpRecursiveSync('source-link', 'destination-link');

  expect(symlink).toHaveBeenCalledExactlyOnceWith(fixture.target, 'destination-link', undefined);
  if (fixture.platform === 'linux' || !path.isAbsolute(fixture.target)) {
    expect(stat).not.toHaveBeenCalled();
  }
});
