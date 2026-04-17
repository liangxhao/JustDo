/**
 * IM Gateway Types - Minimal Placeholder
 * Reserved for future IM platform integration
 */

// Platform identifiers for IM channels
export type IMPlatform = 'telegram' | 'discord';

// Placeholder config structure
export interface IMConfigPlaceholder {
  enabled: boolean;
}

// Default placeholder config
export const DEFAULT_IM_CONFIG: Record<IMPlatform, IMConfigPlaceholder> = {
  telegram: { enabled: false },
  discord: { enabled: false },
};