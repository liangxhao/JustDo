export const PluginKind = {
  EXTENSION: 'extension',
  SKILL: 'skill',
  MCP: 'mcp',
  HOOK: 'hook',
} as const;

export type PluginKind = (typeof PluginKind)[keyof typeof PluginKind];

export const MarketplaceErrorCode = {
  INVALID_REQUEST: 'invalid-request',
  SOURCE_NOT_FOUND: 'source-not-found',
  UNSUPPORTED_KIND: 'unsupported-kind',
  PROVIDER_FAILURE: 'provider-failure',
  INVALID_RESPONSE: 'invalid-response',
  INTERNAL: 'internal',
} as const;

export type MarketplaceErrorCode = (typeof MarketplaceErrorCode)[keyof typeof MarketplaceErrorCode];

export interface MarketplaceSource {
  id: string;
  name: string;
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
  iconUrl?: string;
  sourceId: string;
  installState?: MarketplaceInstallState;
  installedVersion?: string;
}

export const MarketplaceInstallState = {
  AVAILABLE: 'available',
  INSTALLED: 'installed',
  UPDATE_AVAILABLE: 'update-available',
  UNAVAILABLE: 'unavailable',
} as const;

export type MarketplaceInstallState =
  (typeof MarketplaceInstallState)[keyof typeof MarketplaceInstallState];

export const MarketplaceInstallOperation = {
  INSTALL: 'install',
  UPDATE: 'update',
} as const;

export type MarketplaceInstallOperation =
  (typeof MarketplaceInstallOperation)[keyof typeof MarketplaceInstallOperation];

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
  cursor?: string;
  sourceId?: string;
}

export interface MarketplaceSearchResult {
  items: MarketplacePlugin[];
  nextCursor?: string;
}

export interface MarketplaceInstallRequest {
  sourceId: string;
  pluginId: string;
  kind: PluginKind;
  version?: string;
  operation?: MarketplaceInstallOperation;
}

export interface MarketplaceDetailRequest {
  sourceId: string;
  pluginId: string;
  kind: PluginKind;
}

export const MarketplaceIpc = {
  ListSources: 'plugins:marketplace:listSources',
  Search: 'plugins:marketplace:search',
  Detail: 'plugins:marketplace:detail',
  Install: 'plugins:marketplace:install',
} as const;

export interface MarketplaceSearchResponse {
  success: boolean;
  result?: MarketplaceSearchResult;
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceDetailResponse {
  success: boolean;
  detail?: MarketplacePluginDetail | null;
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceInstallResponse {
  success: boolean;
  pluginId?: string;
  restartRequired?: boolean;
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceSourcesResponse {
  success: boolean;
  sources?: MarketplaceSource[];
  error?: string;
  errorCode?: MarketplaceErrorCode;
}
