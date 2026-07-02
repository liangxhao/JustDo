import type {
  MarketplaceInstallOptions,
  MarketplaceInstallResult,
  MarketplaceSearchOptions,
  MarketplaceSkillDetail,
  MarketplaceSkillSummary,
  SkillMarketplaceProvider,
} from './types';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

export class SkillMarketplaceService {
  constructor(private readonly provider: SkillMarketplaceProvider) {}

  search(options: MarketplaceSearchOptions = {}): Promise<MarketplaceSkillSummary[]> {
    const query = options.query?.trim() || undefined;
    const limit = Math.min(Math.max(options.limit || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    return this.provider.search({ query, limit });
  }

  getDetail(slug: string): Promise<MarketplaceSkillDetail | null> {
    return this.provider.getDetail(this.requireSlug(slug));
  }

  install(options: MarketplaceInstallOptions): Promise<MarketplaceInstallResult> {
    return this.provider.install({
      ...options,
      slug: this.requireSlug(options.slug),
      version: options.version?.trim() || undefined,
    });
  }

  private requireSlug(slug: string): string {
    const normalized = slug.trim();
    if (!normalized) {
      throw new Error('Skill slug is required');
    }
    return normalized;
  }
}
