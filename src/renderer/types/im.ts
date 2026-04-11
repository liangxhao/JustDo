/**
 * IM Gateway Types - Minimal Placeholder
 * Reserved for future IM platform integration
 */

// Platform identifiers for future IM channels
export type IMPlatform =
  | 'wechat'
  | 'wecom'
  | 'dingtalk'
  | 'feishu'
  | 'qq'
  | 'telegram'
  | 'discord'
  | 'popo';

// Placeholder config structure
export interface IMConfigPlaceholder {
  enabled: boolean;
}

// Default placeholder config
export const DEFAULT_IM_CONFIG: Record<IMPlatform, IMConfigPlaceholder> = {
  wechat: { enabled: false },
  wecom: { enabled: false },
  dingtalk: { enabled: false },
  feishu: { enabled: false },
  qq: { enabled: false },
  telegram: { enabled: false },
  discord: { enabled: false },
  popo: { enabled: false },
};
