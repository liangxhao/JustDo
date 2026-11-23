import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { PluginHubScope } from '../../../shared/plugins/management';
import type { GatewaySkillEntry } from '../../engine/types';
import { resolveSkillOwnership } from './openclawSkillOwnership';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createPluginSkill = (baseDir: string): GatewaySkillEntry => ({
  name: 'Browser automation',
  description: 'Control browser pages.',
  source: 'openclaw-extra',
  bundled: false,
  filePath: path.join(baseDir, 'SKILL.md'),
  baseDir,
  skillKey: 'browser-automation',
  always: false,
  eligible: true,
  disabled: false,
  blockedByAllowlist: false,
  missing: { bins: [], env: [], config: [], os: [] },
  install: [],
  configChecks: [],
});

test('groups a skill from a bundled extension as system-owned', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-skill-owner-'));
  temporaryDirectories.push(fixtureRoot);
  const realRuntimeRoot = path.join(fixtureRoot, 'runtime-cache');
  const runtimeRoot = path.join(fixtureRoot, 'runtime-current');
  const skillDir = path.join(
    realRuntimeRoot,
    'dist',
    'extensions',
    'browser',
    'skills',
    'browser-automation',
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, '..', '..', 'openclaw.plugin.json'), '{"id":"native-browser"}');
  fs.symlinkSync(realRuntimeRoot, runtimeRoot, 'junction');
  const publishedSkillDir = path.join(fixtureRoot, 'state', 'plugin-skills', 'browser-automation');
  fs.mkdirSync(path.dirname(publishedSkillDir), { recursive: true });
  fs.symlinkSync(skillDir, publishedSkillDir, 'junction');

  expect(
    resolveSkillOwnership(createPluginSkill(publishedSkillDir), {
      getRuntimeRoot: () => runtimeRoot,
    }),
  ).toEqual({
    scope: PluginHubScope.EXTENSION,
    ownershipScope: PluginHubScope.SYSTEM,
    extensionId: 'native-browser',
  });
});

test('keeps a skill from a user extension in the user-owned group', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-skill-owner-'));
  temporaryDirectories.push(fixtureRoot);
  const skillDir = path.join(fixtureRoot, 'state', 'extensions', 'custom', 'skills', 'example');
  fs.mkdirSync(skillDir, { recursive: true });
  const publishedSkillDir = path.join(fixtureRoot, 'state', 'plugin-skills', 'example');
  fs.mkdirSync(path.dirname(publishedSkillDir), { recursive: true });
  fs.symlinkSync(skillDir, publishedSkillDir, 'junction');

  expect(
    resolveSkillOwnership(createPluginSkill(publishedSkillDir), {
      getRuntimeRoot: () => path.join(fixtureRoot, 'runtime'),
    }),
  ).toEqual({
    scope: PluginHubScope.EXTENSION,
    ownershipScope: PluginHubScope.PERSONAL,
  });
});

test('resolves the source of a workspace skill published from a bundle extension', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-source-'));
  temporaryDirectories.push(fixtureRoot);
  const stateDir = path.join(fixtureRoot, 'state');
  const pluginRoot = path.join(fixtureRoot, 'project', '.openclaw', 'extensions', 'bundle');
  const skillDir = path.join(pluginRoot, 'skills', 'example');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'));
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"Bundle Tools"}');
  const publishedSkillDir = path.join(stateDir, 'plugin-skills', 'example');
  fs.mkdirSync(path.dirname(publishedSkillDir), { recursive: true });
  fs.symlinkSync(skillDir, publishedSkillDir, 'junction');
  expect(resolveSkillOwnership(createPluginSkill(publishedSkillDir)).extensionId).toBe('bundle-tools');
});
