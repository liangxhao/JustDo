import type { PluginOperationFeedback } from './pluginOperation';

export const PluginKind = {
  EXTENSION: 'extension',
  SKILL: 'skill',
  MCP: 'mcp',
  HOOK: 'hook',
} as const;

export type PluginKind = (typeof PluginKind)[keyof typeof PluginKind];

export const MarketplacePluginKind = {
  EXTENSION: PluginKind.EXTENSION,
  SKILL: PluginKind.SKILL,
  MCP: PluginKind.MCP,
} as const;

export type MarketplacePluginKind =
  (typeof MarketplacePluginKind)[keyof typeof MarketplacePluginKind];

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
  supportedKinds: MarketplacePluginKind[];
  /** Whether the provider can return metadata beyond the search result. */
  supportsDetail?: boolean;
  /** Whether the provider exposes a stable category catalog for this plugin kind. */
  supportsCategories?: boolean;
  supportsUpdates?: boolean;
}

export interface MarketplaceCategory {
  id: string;
  name: string;
}

export interface MarketplacePlugin {
  id: string;
  /** Runtime-owned id after installation, when it differs from the marketplace catalog id. */
  runtimeId?: string;
  kind: MarketplacePluginKind;
  name: string;
  description: string;
  version?: string;
  author?: string;
  /** Optional popularity signal supplied by the catalog. It is display-only. */
  downloadCount?: number;
  tags?: string[];
  /** Optional catalog category. Adapters should use the id returned by listCategories. */
  category?: MarketplaceCategory;
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
  kind: MarketplacePluginKind;
  query?: string;
  categoryId?: string;
  limit?: number;
  cursor?: string;
  sourceId?: string;
}

export interface MarketplaceCategoryRequest {
  sourceId: string;
  kind: MarketplacePluginKind;
}

export interface MarketplaceCategoriesResult {
  categories: MarketplaceCategory[];
}

export interface MarketplaceSearchResult {
  items: MarketplacePlugin[];
  nextCursor?: string;
}

export interface MarketplaceInstalledPlugin {
  /** Catalog id when known; otherwise the runtime id for legacy installations. */
  id: string;
  /** Runtime-owned id when it differs from the catalog id. */
  runtimeId?: string;
  version?: string;
}

/** Runtime inventory identity supplied for read-only registry reconciliation. */
export interface MarketplaceInventoryEntry {
  id: string;
  installPath?: string;
}

export interface MarketplaceResolveRequest {
  kind: MarketplacePluginKind;
  installed: MarketplaceInventoryEntry[];
}

export interface MarketplaceInstallationIdentity {
  runtimeId: string;
  sourceId: string;
  pluginId: string;
}

export interface MarketplaceResolveResponse {
  success: boolean;
  installations?: MarketplaceInstallationIdentity[];
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceUpdateCheckRequest {
  kind: MarketplacePluginKind;
  installed: MarketplaceInstalledPlugin[];
}

export interface MarketplaceUpdateCheckResult {
  updates: MarketplacePlugin[];
}

export interface MarketplaceInstallRequest {
  sourceId: string;
  pluginId: string;
  kind: MarketplacePluginKind;
  version?: string;
  operation?: MarketplaceInstallOperation;
}

export interface MarketplaceDetailRequest {
  sourceId: string;
  pluginId: string;
  kind: MarketplacePluginKind;
}

export const MarketplaceIpc = {
  ListSources: 'plugins:marketplace:listSources',
  ResolveInstalled: 'plugins:marketplace:resolveInstalled',
  ListCategories: 'plugins:marketplace:listCategories',
  Search: 'plugins:marketplace:search',
  CheckUpdates: 'plugins:marketplace:checkUpdates',
  Detail: 'plugins:marketplace:detail',
  Install: 'plugins:marketplace:install',
} as const;

export interface MarketplaceCategoriesResponse {
  success: boolean;
  result?: MarketplaceCategoriesResult;
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceSearchResponse {
  success: boolean;
  result?: MarketplaceSearchResult;
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceUpdateCheckResponse {
  success: boolean;
  result?: MarketplaceUpdateCheckResult;
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceDetailResponse {
  success: boolean;
  detail?: MarketplacePluginDetail | null;
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceInstallResponse extends PluginOperationFeedback {
  success: boolean;
  /** Installation persisted; an unsuccessful response still requires inventory reconciliation. */
  installationCommitted?: true;
  pluginId?: string;
  restartRequired?: boolean;
  failedStage?: import('./pluginOperation').PluginOperationStage;
  error?: string;
  errorCode?: MarketplaceErrorCode;
}

export interface MarketplaceSourcesResponse {
  success: boolean;
  sources?: MarketplaceSource[];
  error?: string;
  errorCode?: MarketplaceErrorCode;
}
