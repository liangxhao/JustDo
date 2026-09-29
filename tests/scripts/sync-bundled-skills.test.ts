import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const {
  syncBundledSkills,
  readBundledSkillConfig,
} = require('../../scripts/runtime/sync-bundled-skills.cjs');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-bundled-skills-'));
  roots.push(root);
  const runtimeRoot = path.join(root, 'runtime');
  const manifest = {
    version: 2,
    skills: [
      { id: 'custom-skill', enabled: true },
      { id: 'disabled-skill', enabled: false },
    ],
    openclaw: { skills: ['coding-agent'], custodianSkills: ['diagnose-gateway'] },
  };
  const writeSkill = (relative: string, content: string) => {
    const dir = path.join(root, relative);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  };
  writeSkill('resources/skills/custom-skill', 'custom');
  writeSkill('runtime/skills/coding-agent', 'upstream coding');
  writeSkill('runtime/skills/unwanted', 'unwanted');
  writeSkill('runtime/custodian-skills/diagnose-gateway', 'upstream diagnosis');
  writeSkill('runtime/custodian-skills/configure-channel', 'unwanted custodian');
  const save = () =>
    fs.writeFileSync(path.join(root, 'resources/builtin-skills.json'), JSON.stringify(manifest));
  save();
  return { root, runtimeRoot, manifest, save };
}

test('keeps selected upstream skills in their native scopes across repeated packaging syncs', () => {
  const { root, runtimeRoot } = fixture();
  syncBundledSkills(root, runtimeRoot, 'test');
  fs.writeFileSync(path.join(runtimeRoot, 'skills/custom-skill/obsolete.txt'), 'obsolete');
  syncBundledSkills(root, runtimeRoot, 'test');
  expect(fs.readdirSync(path.join(runtimeRoot, 'skills')).sort()).toEqual([
    'coding-agent',
    'custom-skill',
  ]);
  expect(fs.readdirSync(path.join(runtimeRoot, 'custodian-skills'))).toEqual(['diagnose-gateway']);
  expect(fs.readFileSync(path.join(runtimeRoot, 'skills/coding-agent/SKILL.md'), 'utf8')).toBe(
    'upstream coding',
  );
  expect(
    fs.readFileSync(path.join(runtimeRoot, 'custodian-skills/diagnose-gateway/SKILL.md'), 'utf8'),
  ).toBe('upstream diagnosis');
  expect(fs.readFileSync(path.join(runtimeRoot, 'skills/custom-skill/SKILL.md'), 'utf8')).toBe(
    'custom',
  );
  expect(fs.existsSync(path.join(runtimeRoot, 'skills/custom-skill/obsolete.txt'))).toBe(false);
  expect(readBundledSkillConfig(root).runtimeSkillPaths).toEqual([
    'skills/custom-skill',
    'skills/coding-agent',
    'custodian-skills/diagnose-gateway',
  ]);
});

test('fails before pruning when a selected upstream skill is absent', () => {
  const { root, runtimeRoot } = fixture();
  fs.unlinkSync(path.join(runtimeRoot, 'skills/coding-agent/SKILL.md'));
  expect(() => syncBundledSkills(root, runtimeRoot)).toThrow('locked pristine OpenClaw package');
  expect(fs.existsSync(path.join(runtimeRoot, 'skills/unwanted/SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(runtimeRoot, 'custodian-skills/configure-channel/SKILL.md'))).toBe(
    true,
  );
});

test('empty upstream allowlists remove both upstream libraries', () => {
  const { root, runtimeRoot, manifest, save } = fixture();
  manifest.openclaw.skills = [];
  manifest.openclaw.custodianSkills = [];
  save();
  syncBundledSkills(root, runtimeRoot);
  expect(fs.readdirSync(path.join(runtimeRoot, 'skills'))).toEqual(['custom-skill']);
  expect(fs.readdirSync(path.join(runtimeRoot, 'custodian-skills'))).toEqual([]);
});

test.each(['../outside', 'coding-agent', 'custom-skill'])(
  'rejects unsafe or duplicate selected skill %s before mutation',
  id => {
    const { root, runtimeRoot, manifest, save } = fixture();
    manifest.openclaw.skills.push(id);
    save();
    expect(() => syncBundledSkills(root, runtimeRoot)).toThrow('Invalid bundled skill manifest');
    expect(fs.existsSync(path.join(runtimeRoot, 'skills/unwanted/SKILL.md'))).toBe(true);
  },
);
