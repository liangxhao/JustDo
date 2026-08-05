import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ZipFile } from 'yazl';

import { setLanguage } from '../../core/i18n';
import { __openClawSkillFilesTestUtils, OpenClawSkillFiles } from './openclawSkillFiles';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-skill-test-'));
  tempDirs.push(dir);
  return dir;
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
  setLanguage('en');
});

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage('zh');
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts common skill names that are safe directory names on Windows', () => {
  expect(__openClawSkillFilesTestUtils.validateSkillName('import-smoke-test')).toEqual({
    skillId: 'import-smoke-test',
  });
  expect(__openClawSkillFilesTestUtils.validateSkillName('My Useful Skill (v2)_beta')).toEqual({
    skillId: 'My Useful Skill (v2)_beta',
  });
  expect(__openClawSkillFilesTestUtils.validateSkillName('node.js tools')).toEqual({
    skillId: 'node.js tools',
  });
  expect(__openClawSkillFilesTestUtils.validateSkillName('../').error).toContain('1-64 characters');
  expect(__openClawSkillFilesTestUtils.validateSkillName('trailing-space ').error).toContain(
    '1-64 characters',
  );
  expect(__openClawSkillFilesTestUtils.validateSkillName(' leading-space').error).toContain(
    '1-64 characters',
  );
  expect(__openClawSkillFilesTestUtils.validateSkillName('.hidden-skill').error).toContain(
    '1-64 characters',
  );
  expect(__openClawSkillFilesTestUtils.validateSkillName('skill/name').error).toContain(
    '1-64 characters',
  );
  expect(__openClawSkillFilesTestUtils.validateSkillName('skill\\name').error).toContain(
    '1-64 characters',
  );
  expect(__openClawSkillFilesTestUtils.validateSkillName('skill:name').error).toContain(
    '1-64 characters',
  );
  expect(__openClawSkillFilesTestUtils.validateSkillName('con').error).toContain(
    'Windows reserved',
  );
  expect(__openClawSkillFilesTestUtils.validateSkillName('CON.txt').error).toContain(
    'Windows reserved',
  );
  expect(__openClawSkillFilesTestUtils.validateSkillName('a'.repeat(65)).error).toContain(
    '1-64 characters',
  );
});

test('imports a skill directory into the OpenClaw managed directory', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: linked-skill\ndescription: demo\n---\n',
  );

  const result = new OpenClawSkillFiles(managed).importDirectory(source);

  expect(result).toEqual({ success: true, skillId: 'linked-skill' });
  expect(fs.existsSync(path.join(managed, 'linked-skill', 'SKILL.md'))).toBe(true);
});

test('rejects an invalid skill name before creating its managed directory', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: Invalid/Skill\ndescription: demo\n---\n',
  );

  const result = new OpenClawSkillFiles(managed).importDirectory(source);

  expect(result.success).toBe(false);
  expect(result.error).toContain('letters, numbers, spaces');
  expect(fs.readdirSync(managed)).toEqual([]);
});

test('rejects a Windows reserved skill name before creating its managed directory', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: con\ndescription: demo\n---\n');

  const result = new OpenClawSkillFiles(managed).importDirectory(source);

  expect(result.success).toBe(false);
  expect(result.error).toContain('Windows reserved directory name');
  expect(fs.readdirSync(managed)).toEqual([]);
});

test('imports a skill whose name starts with import-', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: import-smoke-test\ndescription: demo\n---\n',
  );

  const result = new OpenClawSkillFiles(managed).importDirectory(source);

  expect(result).toEqual({ success: true, skillId: 'import-smoke-test' });
  expect(fs.existsSync(path.join(managed, 'import-smoke-test', 'SKILL.md'))).toBe(true);
});

test('replaces an imported skill with the same name and removes files from the old version', () => {
  const oldSource = makeTempDir();
  const newSource = makeTempDir();
  const managed = makeTempDir();
  fs.writeFileSync(
    path.join(oldSource, 'SKILL.md'),
    '---\nname: replaceable-skill\ndescription: old\n---\n',
  );
  fs.writeFileSync(path.join(oldSource, 'obsolete.md'), 'old version only');
  fs.writeFileSync(
    path.join(newSource, 'SKILL.md'),
    '---\nname: replaceable-skill\ndescription: new\n---\n',
  );
  fs.writeFileSync(path.join(newSource, 'current.md'), 'new version only');
  const files = new OpenClawSkillFiles(managed);

  expect(files.importDirectory(oldSource)).toEqual({
    success: true,
    skillId: 'replaceable-skill',
  });
  const result = files.importDirectory(newSource);

  const installedDir = path.join(managed, 'replaceable-skill');
  expect(result).toEqual({ success: true, skillId: 'replaceable-skill' });
  expect(fs.readFileSync(path.join(installedDir, 'SKILL.md'), 'utf8')).toContain(
    'description: new',
  );
  expect(fs.readFileSync(path.join(installedDir, 'current.md'), 'utf8')).toBe('new version only');
  expect(fs.existsSync(path.join(installedDir, 'obsolete.md'))).toBe(false);
});

test('retries a transient permission error while replacing an imported skill', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  const target = path.join(managed, 'replaceable-skill');
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: replaceable-skill\ndescription: new\n---\n',
  );
  fs.mkdirSync(target);
  fs.writeFileSync(
    path.join(target, 'SKILL.md'),
    '---\nname: replaceable-skill\ndescription: old\n---\n',
  );
  const renameSync = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('directory temporarily locked'), { code: 'EPERM' });
    })
    .mockImplementation(renameSync);

  const result = new OpenClawSkillFiles(managed).importDirectory(source);

  expect(result).toEqual({ success: true, skillId: 'replaceable-skill' });
  expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('description: new');
  expect(fs.renameSync).toHaveBeenCalledTimes(3);
});

test('can delete a skill after importing it', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  const skillId = 'Deletable Skill (v2)_beta';
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: demo\n---\n`,
  );
  const files = new OpenClawSkillFiles(managed);

  expect(files.importDirectory(source)).toEqual({ success: true, skillId });
  files.delete(skillId);

  expect(fs.existsSync(path.join(managed, skillId))).toBe(false);
});

test('repairs inherited Windows ACLs before retrying quarantined file cleanup', () => {
  const managed = makeTempDir();
  const skillDir = path.join(managed, 'permission-blocked-skill');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: permission-blocked-skill\ndescription: demo\n---\n',
  );
  const rmSync = fs.rmSync.bind(fs);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(fs, 'rmSync')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    })
    .mockImplementation(rmSync);
  vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
    pid: 1,
    output: [],
    stdout: null,
    stderr: null,
    status: 0,
    signal: null,
  });

  new OpenClawSkillFiles(managed).delete('permission-blocked-skill');

  expect(childProcess.spawnSync).toHaveBeenCalledWith(
    expect.stringMatching(/[\\/]icacls\.exe$|^icacls\.exe$/),
    [expect.stringContaining('.justdo-skill-trash'), '/reset', '/T', '/C', '/Q', '/L'],
    expect.objectContaining({ windowsHide: true, stdio: 'ignore' }),
  );
  expect(fs.rmSync).toHaveBeenCalledTimes(2);
  expect(fs.existsSync(skillDir)).toBe(false);
});

test('reports success after moving a skill out of the scan root even if cleanup remains blocked', () => {
  const root = makeTempDir();
  const managed = path.join(root, 'state', 'skills');
  const skillDir = path.join(managed, 'locked-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: locked-skill\n---\n');
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(fs, 'rmSync').mockImplementation(target => {
    if (target.toString().includes('.justdo-skill-trash')) {
      throw Object.assign(new Error('scanner still holds a quarantined file'), { code: 'EPERM' });
    }
  });
  vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
    pid: 1,
    output: [],
    stdout: null,
    stderr: null,
    status: 0,
    signal: null,
  });

  new OpenClawSkillFiles(managed).deleteDirectory(skillDir);

  expect(fs.existsSync(skillDir)).toBe(false);
  expect(fs.existsSync(path.join(managed, 'locked-skill'))).toBe(false);
});

test('does not leave a partial managed skill when copying fails', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: interrupted-skill\ndescription: demo\n---\n',
  );
  const copyError = Object.assign(new Error('copy blocked'), { code: 'EPERM' });
  vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
    throw copyError;
  });

  const result = new OpenClawSkillFiles(managed).importDirectory(source);

  expect(result.success).toBe(false);
  expect(result.error).toContain('Cannot access the skill directory');
  expect(fs.existsSync(path.join(managed, 'interrupted-skill'))).toBe(false);
});

test('restores the previous skill when installing its replacement fails', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  const target = path.join(managed, 'replaceable-skill');
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: replaceable-skill\ndescription: new\n---\n',
  );
  fs.mkdirSync(target);
  fs.writeFileSync(
    path.join(target, 'SKILL.md'),
    '---\nname: replaceable-skill\ndescription: old\n---\n',
  );
  const renameSync = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
    if (path.basename(oldPath.toString()) === 'skill' && newPath.toString() === target) {
      throw Object.assign(new Error('rename blocked'), { code: 'EPERM' });
    }
    renameSync(oldPath, newPath);
  });

  const result = new OpenClawSkillFiles(managed).importDirectory(source);

  expect(result.success).toBe(false);
  expect(result.error).toContain('Cannot access the skill directory');
  expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('description: old');
});

test('imports a zipped skill with a single wrapper directory', async () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  const archivePath = path.join(source, 'wrapped-skill.zip');
  await writeZip(archivePath, {
    'wrapped-skill/SKILL.md': '---\nname: zipped-skill\ndescription: demo\n---\n',
    'wrapped-skill/references/example.md': 'example',
  });

  const result = await new OpenClawSkillFiles(managed).importPath(archivePath);

  expect(result).toEqual({ success: true, skillId: 'zipped-skill' });
  expect(
    fs.readFileSync(path.join(managed, 'zipped-skill', 'references', 'example.md'), 'utf8'),
  ).toBe('example');
});

test('imports a gzipped tar skill archive', async () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  const skillDir = path.join(source, 'tarred-skill');
  const archivePath = path.join(source, 'tarred-skill.tar.gz');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: tarred-skill\ndescription: demo\n---\n',
  );
  await tar.create({ cwd: source, file: archivePath, gzip: true }, ['tarred-skill']);

  const result = await new OpenClawSkillFiles(managed).importPath(archivePath);

  expect(result).toEqual({ success: true, skillId: 'tarred-skill' });
  expect(fs.existsSync(path.join(managed, 'tarred-skill', 'SKILL.md'))).toBe(true);
});

test('rejects unsupported archive formats', async () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  const archivePath = path.join(source, 'skill.rar');
  fs.writeFileSync(archivePath, 'not an archive');

  const result = await new OpenClawSkillFiles(managed).importPath(archivePath);

  expect(result.success).toBe(false);
  expect(result.error).toContain('supported archive');
});

test('deletes a user-owned skill directory outside the managed skill root', () => {
  const root = makeTempDir();
  const managed = path.join(root, 'managed', 'skills');
  const skillDir = path.join(root, 'workspace', 'skills', 'project-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: project-skill\n---\n');
  const files = new OpenClawSkillFiles(managed);

  files.deleteDirectory(skillDir);

  expect(fs.existsSync(skillDir)).toBe(false);
  expect(() => files.deleteDirectory(path.join(root, 'workspace'))).toThrow(
    'Only user-owned skill directories can be deleted',
  );
});

test('deletes only a direct child of the managed skills directory', () => {
  const managed = makeTempDir();
  const skillDir = path.join(managed, 'demo');
  fs.mkdirSync(skillDir);

  const files = new OpenClawSkillFiles(managed);
  files.delete('demo');

  expect(fs.existsSync(skillDir)).toBe(false);
  expect(() => files.delete('../outside')).toThrow('Invalid skill id');
});
