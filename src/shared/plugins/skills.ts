export type OpenClawSkillSource =
  | 'openclaw-workspace'
  | 'agents-skills-project'
  | 'agents-skills-personal'
  | 'openclaw-managed'
  | 'openclaw-bundled'
  | 'openclaw-extra'
  | 'unknown';

export const USER_OWNED_SKILL_SOURCES = [
  'openclaw-workspace',
  'agents-skills-project',
  'agents-skills-personal',
  'openclaw-managed',
] as const satisfies readonly OpenClawSkillSource[];

const userOwnedSkillSources = new Set<unknown>(USER_OWNED_SKILL_SOURCES);

export const isUserOwnedSkillSource = (
  source: unknown,
): source is (typeof USER_OWNED_SKILL_SOURCES)[number] => userOwnedSkillSources.has(source);
