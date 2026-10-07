import { expect, test } from 'vitest';

import { getMissingRequirementCount, getMissingSkillDependencies } from './skillRequirements';

test('does not report missing requirements for an empty Gateway missing object', () => {
  expect(getMissingRequirementCount({ bins: [], env: [], config: [], os: [] })).toBe(0);
});

test('counts every Gateway requirement category', () => {
  expect(
    getMissingRequirementCount({
      bins: ['git'],
      anyBins: ['claude', 'codex', 'opencode'],
      env: ['API_KEY'],
      config: ['tools.enabled'],
      os: ['darwin'],
    }),
  ).toBe(5);
});

test('leaves a missing enable requirement to the skill switch', () => {
  const missing = { bins: [], env: [], config: ['skills.entries.coding-agent.enabled'], os: [] };
  const dependencies = getMissingSkillDependencies({ id: 'coding-agent', missing });

  expect(getMissingRequirementCount(dependencies)).toBe(0);
  expect(missing.config).toEqual(['skills.entries.coding-agent.enabled']);
});

test('retains real dependencies and other skill enable requirements', () => {
  expect(
    getMissingSkillDependencies({
      id: 'coding-agent',
      missing: {
        bins: ['codex'],
        env: ['API_KEY'],
        os: ['linux'],
        config: [
          'skills.entries.coding-agent.enabled',
          'tools.exec.enabled',
          'skills.entries.other.enabled',
        ],
      },
    }),
  ).toEqual({
    bins: ['codex'],
    env: ['API_KEY'],
    os: ['linux'],
    config: ['tools.exec.enabled', 'skills.entries.other.enabled'],
  });
});

test('counts alternative tools after hiding the skill enable requirement', () => {
  const dependencies = getMissingSkillDependencies({
    id: 'coding-agent',
    missing: {
      bins: [],
      anyBins: ['claude', 'codex', 'opencode'],
      env: [],
      config: ['skills.entries.coding-agent.enabled'],
      os: [],
    },
  });

  expect(dependencies?.config).toEqual([]);
  expect(dependencies?.anyBins).toEqual(['claude', 'codex', 'opencode']);
  expect(getMissingRequirementCount(dependencies)).toBe(1);
});
