import type { Skill, SkillMissing } from '@/features/plugins/skills/skill';

export const getMissingSkillDependencies = (
  skill: Pick<Skill, 'id' | 'missing'>,
): SkillMissing | undefined =>
  skill.missing
    ? {
        ...skill.missing,
        // The skill's own enable requirement is represented by its switch.
        config: skill.missing.config.filter(path => path !== `skills.entries.${skill.id}.enabled`),
      }
    : undefined;

export const getMissingRequirementCount = (missing?: SkillMissing): number =>
  missing
    ? missing.bins.length +
      (missing.anyBins?.length ? 1 : 0) +
      missing.env.length +
      missing.config.length +
      missing.os.length
    : 0;
