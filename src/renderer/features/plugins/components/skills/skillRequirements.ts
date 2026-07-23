import { SkillMissing } from '@/features/plugins/types/skill';

export const getMissingRequirementCount = (missing?: SkillMissing): number =>
  missing
    ? missing.bins.length + missing.env.length + missing.config.length + missing.os.length
    : 0;
