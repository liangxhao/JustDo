import { Skill, SkillSource } from '../../types/skill';

export const SkillGroupId = {
  WORKSPACE: 'workspace',
  AGENTS_PROJECT: 'agents-project',
  AGENTS_PERSONAL: 'agents-personal',
  MANAGED: 'managed',
  BUNDLED: 'openclaw-bundled',
  EXTRA: 'extra-dir',
  UNKNOWN: 'unknown',
} as const;

export type SkillGroupId = (typeof SkillGroupId)[keyof typeof SkillGroupId];

export interface SkillGroup {
  id: SkillGroupId;
  priority?: number;
  skills: Skill[];
}

const sourceToGroup: Record<SkillSource, SkillGroupId> = {
  workspace: SkillGroupId.WORKSPACE,
  'openclaw-workspace': SkillGroupId.WORKSPACE,
  'agents-project': SkillGroupId.AGENTS_PROJECT,
  'agents-skills-project': SkillGroupId.AGENTS_PROJECT,
  'agents-personal': SkillGroupId.AGENTS_PERSONAL,
  'agents-skills-personal': SkillGroupId.AGENTS_PERSONAL,
  managed: SkillGroupId.MANAGED,
  'openclaw-managed': SkillGroupId.MANAGED,
  'openclaw-bundled': SkillGroupId.BUNDLED,
  'extra-dir': SkillGroupId.EXTRA,
  'openclaw-extra': SkillGroupId.EXTRA,
  unknown: SkillGroupId.UNKNOWN,
};

// OpenClaw precedence is extra < bundled < managed < personal < project < workspace.
// Present the most specific, highest-priority layer first.
const groupOrder: SkillGroupId[] = [
  SkillGroupId.WORKSPACE,
  SkillGroupId.AGENTS_PROJECT,
  SkillGroupId.AGENTS_PERSONAL,
  SkillGroupId.MANAGED,
  SkillGroupId.BUNDLED,
  SkillGroupId.EXTRA,
  SkillGroupId.UNKNOWN,
];

const groupPriority: Partial<Record<SkillGroupId, number>> = {
  [SkillGroupId.WORKSPACE]: 6,
  [SkillGroupId.AGENTS_PROJECT]: 5,
  [SkillGroupId.AGENTS_PERSONAL]: 4,
  [SkillGroupId.MANAGED]: 3,
  [SkillGroupId.BUNDLED]: 2,
  [SkillGroupId.EXTRA]: 1,
};

export const groupSkillsBySource = (skills: Skill[]): SkillGroup[] => {
  const groups = new Map<SkillGroupId, Skill[]>();

  for (const skill of skills) {
    const groupId = sourceToGroup[skill.source ?? 'unknown'] ?? SkillGroupId.UNKNOWN;
    groups.set(groupId, [...(groups.get(groupId) ?? []), skill]);
  }

  return groupOrder.flatMap(id => {
    const groupedSkills = groups.get(id);
    return groupedSkills ? [{ id, priority: groupPriority[id], skills: groupedSkills }] : [];
  });
};
