// Skill type definition - extended with Gateway fields
export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean; // Whether visible in popover (from Gateway disabled state)
  isOfficial: boolean; // "官方" badge (bundled)
  isBuiltIn: boolean; // Bundled with app, cannot be deleted
  updatedAt: number; // Timestamp
  prompt: string; // System prompt content (empty for Gateway skills)
  skillPath: string; // Absolute path to SKILL.md
  version?: string; // Skill version from SKILL.md frontmatter
  // Gateway extended fields
  source?: SkillSource;
  eligible?: boolean; // Can be used right now (requirements met)
  missing?: SkillMissing; // Missing requirements (bins, env, config, os)
  install?: SkillInstallOption[]; // Install options for missing requirements
  emoji?: string;
  homepage?: string;
}

export type SkillSource =
  | 'workspace'
  | 'openclaw-workspace'
  | 'agents-project'
  | 'agents-skills-project'
  | 'agents-personal'
  | 'agents-skills-personal'
  | 'managed'
  | 'openclaw-managed'
  | 'openclaw-bundled'
  | 'extra-dir'
  | 'openclaw-extra'
  | 'unknown';

export interface SkillMissing {
  bins: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface SkillInstallOption {
  id: string;
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download' | 'script';
  label: string;
  bins?: string[];
  formula?: string;
  url?: string;
  hint?: string;
  optional?: boolean;
}
