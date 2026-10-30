import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { inspectOpenClawExtensionDirectory } from '../../../plugins/extensions/openclawLocalExtensions';
import { projectManagedOpenClawBrowserConfig } from '../configCompatibility';
import {
  applyDefaultOpenClawPluginEntries,
  buildDefaultOpenClawPluginEntries,
  mergeOpenClawPluginConfig,
  mergeOpenClawSkillConfig,
} from './pluginProjection';

test('removes an absent optional app plugin without changing other plugin choices or permissions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'optional-plugin-config-'));
  try {
    for (const id of ['runtime-services', 'swarm-workflow', 'private-plugin']) {
      const directory = path.join(root, id);
      mkdirSync(directory);
      writeFileSync(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id }));
    }
    const inventory = inspectOpenClawExtensionDirectory(root);
    expect(inventory.complete).toBe(true);
    expect(inventory.ids).not.toContain('agent-team');
    const existing = {
      plugins: {
        enabled: true,
        load: { paths: [root] },
        entries: {
          'agent-team': { enabled: true, config: { availableAgentIds: ['retired'] } },
          'runtime-services': {
            enabled: true,
            hooks: { allowConversationAccess: true, allowPromptInjection: false },
          },
          'swarm-workflow': { enabled: false, config: { limit: 4 } },
          'private-plugin': { enabled: false, config: { endpoint: 'http://internal.example' } },
        },
        installs: { 'agent-team': { source: 'path' }, 'private-plugin': { source: 'path' } },
        allow: ['agent-team', 'runtime-services', 'swarm-workflow', 'private-plugin'],
        deny: ['agent-team', 'private-plugin'],
        slots: { contextEngine: 'legacy' },
      },
      skills: {
        entries: { 'agent-team': { enabled: false }, 'private-skill': { enabled: false } },
        workshop: { autonomous: { mode: 'off' } },
      },
      tools: { deny: ['web_search'], fs: { workspaceOnly: true } },
    };
    const before = structuredClone(existing);
    const defaults = buildDefaultOpenClawPluginEntries(id => inventory.ids.includes(id), {
      'agent-team': { defaultEnabled: true, userToggleable: true },
      'swarm-workflow': { defaultEnabled: false, userToggleable: true },
    });
    expect(defaults).not.toHaveProperty('agent-team');

    const projected = {
      ...existing,
      plugins: mergeOpenClawPluginConfig(
        applyDefaultOpenClawPluginEntries(existing.plugins, defaults),
        { 'runtime-services': { enabled: true }, 'swarm-workflow': { config: { limit: 4 } } },
        Object.keys(defaults),
        inventory.ids,
        ['swarm-workflow'],
      ),
      skills: mergeOpenClawSkillConfig(existing.skills, {}),
    };

    expect(projected.plugins).toEqual({
      ...existing.plugins,
      entries: {
        'runtime-services': existing.plugins.entries['runtime-services'],
        'swarm-workflow': existing.plugins.entries['swarm-workflow'],
        'private-plugin': existing.plugins.entries['private-plugin'],
      },
      installs: { 'private-plugin': { source: 'path' } },
      allow: ['runtime-services', 'swarm-workflow', 'private-plugin'],
      deny: ['private-plugin'],
    });
    expect(projected.skills).toEqual(existing.skills);
    expect(projected.tools).toBe(existing.tools);
    expect(existing).toEqual(before);
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^optional-plugin-config-/u);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('current Workshop config projection', () => {
  test.each(['auto', 'off'])('preserves explicit %s mode and current skill preferences', mode => {
    const workshop = Object.freeze({
      maxSkillBytes: 60_000,
      autonomous: Object.freeze({ mode }),
    });
    const skills = Object.freeze({
      workshop,
      entries: Object.freeze({ 'private-skill': Object.freeze({ enabled: false }) }),
      load: Object.freeze({ extraDirs: ['C:/private-skills'], watch: false }),
    });

    expect(mergeOpenClawSkillConfig(skills, {})).toEqual(skills);
    expect(projectManagedOpenClawBrowserConfig({ skills }).skills).toBe(skills);
  });

  test('defaults an absent automation mode off without losing current preferences', () => {
    expect(mergeOpenClawSkillConfig({ workshop: { maxSkillBytes: 45_000 } }, {})).toEqual({
      workshop: { autonomous: { mode: 'off' }, maxSkillBytes: 45_000 },
    });
  });

  test('leaves invalid modes and unknown operator fields visible to native validation', () => {
    const workshop = { autonomous: { mode: 'invalid' }, operatorOption: true };
    expect(mergeOpenClawSkillConfig({ workshop }, {})).toEqual({ workshop });
    expect(projectManagedOpenClawBrowserConfig({ skills: { workshop } }).skills)
      .toEqual({ workshop });
  });

  test.each([null, 'invalid', []])('does not change unrelated malformed config: %j', workshop => {
    expect(projectManagedOpenClawBrowserConfig({ skills: { workshop } }).skills)
      .toEqual({ workshop });
  });

  test('preserves unrelated preferences, plugin switches and permissions and is idempotent', () => {
    const config = {
      skills: { workshop: { autonomous: { mode: 'off' } },
        entries: { 'private-skill': { enabled: false } } },
      plugins: { entries: { 'agent-team': { enabled: false }, 'swarm-workflow': { enabled: false } } },
      tools: { deny: ['web_search'], fs: { workspaceOnly: true } },
      cron: { skipMissedJobs: false },
    };
    const projected = projectManagedOpenClawBrowserConfig(config);
    expect(projected.skills).toBe(config.skills);
    expect(projected.plugins).toBe(config.plugins);
    expect(projected.tools).toBe(config.tools);
    expect(projected.cron).toBe(config.cron);
    expect(projectManagedOpenClawBrowserConfig(projected)).toEqual(projected);
  });
});
