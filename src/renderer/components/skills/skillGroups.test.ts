import { expect, test } from 'vitest';

import { Skill } from '../../types/skill';
import { groupSkillsBySource, SkillGroupId } from './skillGroups';

const createSkill = (id: string, source: Skill['source']): Skill => ({
  id,
  name: id,
  description: '',
  enabled: true,
  isOfficial: false,
  isBuiltIn: false,
  updatedAt: 0,
  prompt: '',
  skillPath: '',
  source,
});

test('groups skills in descending OpenClaw precedence order', () => {
  const groups = groupSkillsBySource([
    createSkill('extra', 'openclaw-extra'),
    createSkill('managed', 'managed'),
    createSkill('workspace', 'workspace'),
    createSkill('personal', 'agents-skills-personal'),
  ]);

  expect(groups.map(group => group.id)).toEqual([
    SkillGroupId.WORKSPACE,
    SkillGroupId.AGENTS_PERSONAL,
    SkillGroupId.MANAGED,
    SkillGroupId.EXTRA,
  ]);
});

test('puts missing and unrecognized sources in the unknown group', () => {
  const groups = groupSkillsBySource([
    createSkill('missing', undefined),
    createSkill('future', 'future-source' as Skill['source']),
  ]);

  expect(groups).toHaveLength(1);
  expect(groups[0].id).toBe(SkillGroupId.UNKNOWN);
  expect(groups[0].skills.map(skill => skill.id)).toEqual(['missing', 'future']);
});
