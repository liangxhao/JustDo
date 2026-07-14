export const PluginKind = {
  EXTENSION: 'extension',
  SKILL: 'skill',
  MCP: 'mcp',
} as const;

export type PluginKind = (typeof PluginKind)[keyof typeof PluginKind];

export const MarketplaceSourceId = {
  DEFAULT: 'default',
} as const;

export interface MarketplaceSource {
  id: string;
  name: string;
  endpoint?: string;
  supportedKinds: PluginKind[];
}

export interface MarketplacePlugin {
  id: string;
  kind: PluginKind;
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  homepage?: string;
  sourceId: string;
}

export interface MarketplacePluginDetail extends MarketplacePlugin {
  readme?: string;
  requirements?: {
    bins?: string[];
    env?: string[];
  };
}

export interface MarketplaceQuery {
  kind: PluginKind;
  query?: string;
  limit?: number;
}

export interface MarketplaceInstallRequest {
  sourceId: string;
  pluginId: string;
  kind: PluginKind;
  version?: string;
  force?: boolean;
}

export interface MarketplaceDetailRequest {
  sourceId: string;
  pluginId: string;
  kind: PluginKind;
}
