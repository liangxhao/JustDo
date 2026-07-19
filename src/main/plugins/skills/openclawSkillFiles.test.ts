import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, expect, test } from 'vitest';
import { ZipFile } from 'yazl';

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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes the frontmatter name into a safe skill id', () => {
  expect(__openClawSkillFilesTestUtils.normalizeSkillId('My Useful Skill')).toBe('my-useful-skill');
  expect(__openClawSkillFilesTestUtils.normalizeSkillId('../')).toBeNull();
});

test('imports a skill directory into the OpenClaw managed directory', () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: Linked Skill\ndescription: demo\n---\n',
  );

  const result = new OpenClawSkillFiles(managed).importDirectory(source);

  expect(result).toEqual({ success: true, skillId: 'linked-skill' });
  expect(fs.existsSync(path.join(managed, 'linked-skill', 'SKILL.md'))).toBe(true);
});

test('imports a zipped skill with a single wrapper directory', async () => {
  const source = makeTempDir();
  const managed = makeTempDir();
  const archivePath = path.join(source, 'wrapped-skill.zip');
  await writeZip(archivePath, {
    'wrapped-skill/SKILL.md': '---\nname: Zipped Skill\ndescription: demo\n---\n',
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
    '---\nname: Tarred Skill\ndescription: demo\n---\n',
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
