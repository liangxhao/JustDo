export const SkillMarketplaceProviderKind = {
  OPENCLAW_GATEWAY: 'openclaw-gateway',
} as const;

export type SkillMarketplaceProviderKind =
  (typeof SkillMarketplaceProviderKind)[keyof typeof SkillMarketplaceProviderKind];

export interface MarketplaceSearchOptions {
  query?: string;
  limit?: number;
}

export interface MarketplaceSkillSummary {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  homepage?: string;
}

export interface MarketplaceSkillDetail extends MarketplaceSkillSummary {
  readme?: string;
  install?: {
    requires?: {
      bins?: string[];
      env?: string[];
    };
  };
}

export interface MarketplaceInstallOptions {
  slug: string;
  version?: string;
  force?: boolean;
}

export interface MarketplaceInstallResult {
  success: boolean;
  error?: string;
}

/**
 * The only contract a public or private skill marketplace integration must implement.
 * Provider-specific DTOs, authentication and transport must stay behind this boundary.
 */
export interface SkillMarketplaceProvider {
  readonly kind: SkillMarketplaceProviderKind | string;
  search(options: MarketplaceSearchOptions): Promise<MarketplaceSkillSummary[]>;
  getDetail(slug: string): Promise<MarketplaceSkillDetail | null>;
  install(options: MarketplaceInstallOptions): Promise<MarketplaceInstallResult>;
}
