import { describe, expect, test } from 'vitest';

import { projectManagedOpenClawBrowserConfig } from '../configCompatibility';
import { mergeOpenClawSkillConfig } from './pluginProjection';

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
