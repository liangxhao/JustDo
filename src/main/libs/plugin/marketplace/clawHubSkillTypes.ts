/**
 * ClawHub skill search result from the Gateway marketplace RPC.
 */
export interface ClawHubSkillSearchResult {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  homepage?: string;
}

/**
 * ClawHub skill detail from the Gateway marketplace RPC.
 */
export interface ClawHubSkillDetail {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  homepage?: string;
  readme?: string;
  install?: {
    requires?: {
      bins?: string[];
      env?: string[];
    };
  };
}
