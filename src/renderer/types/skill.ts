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

// ClawHub marketplace types
export interface ClawHubSkill {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  homepage?: string;
}

export interface ClawHubSkillDetail extends ClawHubSkill {
  readme?: string;
  install?: {
    requires?: {
      bins?: string[];
      env?: string[];
    };
  };
}

// Legacy types (kept for compatibility)
export type LocalizedText = { en: string; zh: string };

export interface MarketTag {
  id: string;
  en: string;
  zh: string;
}

export interface LocalSkillInfo {
  id: string;
  name: string;
  description: string | LocalizedText;
  version: string;
}

export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string | LocalizedText;
  tags?: string[];
  url: string; // Download URL (.zip)
  version: string;
  source: {
    from: string; // e.g. "Github"
    url: string; // Source repo URL
    author?: string; // Author name
  };
}
