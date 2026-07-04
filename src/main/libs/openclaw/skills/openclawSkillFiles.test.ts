import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import {
  __openClawSkillFilesTestUtils,
  OpenClawSkillFiles,
} from './openclawSkillFiles';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-skill-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes the frontmatter name into a safe skill id', () => {
  expect(__openClawSkillFilesTestUtils.normalizeSkillId('My Useful Skill')).toBe(
    'my-useful-skill',
  );
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

test('deletes only a direct child of the managed skills directory', () => {
  const managed = makeTempDir();
  const skillDir = path.join(managed, 'demo');
  fs.mkdirSync(skillDir);

  const files = new OpenClawSkillFiles(managed);
  files.delete('demo');

  expect(fs.existsSync(skillDir)).toBe(false);
  expect(() => files.delete('../outside')).toThrow('Invalid skill id');
});
