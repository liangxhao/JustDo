import { PluginActionReason, PluginHubScope } from '@shared/plugins/management';
import { expect, test } from 'vitest';

import { Skill } from '@/features/plugins/skills/skill';
import {
  canDeleteSkill,
  groupSkillsBySource,
  SkillGroupId,
} from '@/features/plugins/skills/skillGroups';

// Fixed Main response fixtures; Renderer tests do not recalculate management policy.
const personalMetadata: Pick<Skill, 'scope' | 'ownershipScope' | 'management'> = {
  scope: PluginHubScope.PERSONAL,
  ownershipScope: PluginHubScope.PERSONAL,
  management: {
    enable: { allowed: true },
    disable: { allowed: true },
    remove: { allowed: true },
    configure: { allowed: false, reason: PluginActionReason.UNSUPPORTED },
    revealInFolder: { allowed: false, reason: PluginActionReason.UNSUPPORTED },
  },
};
const projectMetadata = {
  ...personalMetadata,
  scope: PluginHubScope.PROJECT,
  ownershipScope: PluginHubScope.PROJECT,
};
const otherMetadata = {
  ...personalMetadata,
  scope: PluginHubScope.OTHER,
  ownershipScope: PluginHubScope.OTHER,
  management: {
    ...personalMetadata.management,
    remove: { allowed: false, reason: PluginActionReason.READ_ONLY_SOURCE },
  },
};

const createSkill = (
  id: string,
  source: Skill['source'],
  metadata: Pick<Skill, 'scope' | 'ownershipScope' | 'management'> = otherMetadata,
): Skill => ({
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
  ...metadata,
});

test('groups skills in descending OpenClaw precedence order', () => {
  const groups = groupSkillsBySource([
    createSkill('extra', 'openclaw-extra'),
    createSkill('managed', 'openclaw-managed', personalMetadata),
    createSkill('workspace', 'openclaw-workspace', projectMetadata),
    createSkill('personal', 'agents-skills-personal', personalMetadata),
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

test('allows deletion only for user-owned, non-built-in skills', () => {
  expect(canDeleteSkill(createSkill('managed', 'openclaw-managed', personalMetadata))).toBe(true);
  expect(canDeleteSkill(createSkill('workspace', 'openclaw-workspace', projectMetadata))).toBe(true);
  expect(canDeleteSkill(createSkill('project', 'agents-skills-project', projectMetadata))).toBe(true);
  expect(canDeleteSkill(createSkill('personal', 'agents-skills-personal', personalMetadata))).toBe(true);
  expect(canDeleteSkill(createSkill('extra', 'openclaw-extra'))).toBe(false);
  expect(canDeleteSkill({ ...createSkill('bundled', 'openclaw-managed', personalMetadata), isBuiltIn: true })).toBe(
    false,
  );
});
