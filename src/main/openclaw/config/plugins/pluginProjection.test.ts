import { describe, expect, test } from 'vitest';

import { sanitizeOpenClawV2026_10_6Config } from '../configCompatibility';
import { mergeOpenClawSkillConfig } from './pluginProjection';

describe('current Workshop config projection', () => {
  test.each(['auto', 'off'])('prunes retired proposal fields while preserving %s', mode => {
    const workshop = Object.freeze({
      approvalPolicy: 'pending', maxPending: 25, maxSkillBytes: 60_000,
      autonomous: Object.freeze({ mode }),
    });
    const skills = Object.freeze({
      workshop,
      entries: Object.freeze({ 'private-skill': Object.freeze({ enabled: false }) }),
      load: Object.freeze({ extraDirs: ['C:/private-skills'], watch: false }),
    });
    const expected = {
      ...skills, workshop: { maxSkillBytes: 60_000, autonomous: { mode } },
    };

    expect(mergeOpenClawSkillConfig(skills, {})).toEqual(expected);
    expect(sanitizeOpenClawV2026_10_6Config({ skills }).skills).toEqual(expected);
    expect(workshop).toHaveProperty('approvalPolicy', 'pending');
    expect(workshop).toHaveProperty('maxPending', 25);
  });

  test('also removes retired fields supplied by a managed skill projection', () => {
    expect(mergeOpenClawSkillConfig({}, {
      workshop: { approvalPolicy: 'auto', maxPending: 10, maxSkillBytes: 45_000 },
    })).toEqual({ workshop: { autonomous: { mode: 'off' }, maxSkillBytes: 45_000 } });
  });

  test('defaults an absent mode off without promoting a retired approval value', () => {
    expect(mergeOpenClawSkillConfig({ workshop: { approvalPolicy: 'auto' } }, {})).toEqual({
      workshop: { autonomous: { mode: 'off' } },
    });
    expect(sanitizeOpenClawV2026_10_6Config({
      skills: { workshop: { approvalPolicy: 'auto' } },
    }).skills).toEqual({ workshop: {} });
  });

  test('does not translate invalid modes or strip unknown operator fields to pass native validation', () => {
    const workshop = { approvalPolicy: 'pending', autonomous: { mode: 'propose' }, operatorOption: true };
    const expected = { autonomous: { mode: 'propose' }, operatorOption: true };
    expect(mergeOpenClawSkillConfig({ workshop }, {})).toEqual({ workshop: expected });
    expect(sanitizeOpenClawV2026_10_6Config({ skills: { workshop } }).skills)
      .toEqual({ workshop: expected });
  });

  test.each([null, 'invalid', []])('leaves malformed workshop input visible to the native validator: %j', workshop => {
    expect(sanitizeOpenClawV2026_10_6Config({ skills: { workshop } }).skills)
      .toEqual({ workshop });
  });

  test('preserves unrelated preferences, plugin switches and permissions and is idempotent', () => {
    const config = {
      skills: { workshop: { approvalPolicy: 'pending', autonomous: { mode: 'off' } },
        entries: { 'private-skill': { enabled: false } } },
      plugins: { entries: { 'agent-team': { enabled: false }, 'swarm-workflow': { enabled: false } } },
      tools: { deny: ['web_search'], fs: { workspaceOnly: true } },
      cron: { skipMissedJobs: false },
    };
    const cleaned = sanitizeOpenClawV2026_10_6Config(config);
    expect(cleaned.skills).toEqual({
      workshop: { autonomous: { mode: 'off' } }, entries: config.skills.entries,
    });
    expect(cleaned.plugins).toBe(config.plugins);
    expect(cleaned.tools).toEqual(config.tools);
    expect(cleaned.cron).toBe(config.cron);
    expect(sanitizeOpenClawV2026_10_6Config(cleaned)).toEqual(cleaned);
  });
});
