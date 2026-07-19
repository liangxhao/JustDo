import { ipcMain } from 'electron';

import {
  type MarketplaceDetailResponse,
  MarketplaceErrorCode,
  MarketplaceInstallOperation,
  type MarketplaceInstallRequest,
  type MarketplaceInstallResponse,
  MarketplaceIpc,
  type MarketplaceQuery,
  type MarketplaceSearchResponse,
  type MarketplaceSourcesResponse,
  PluginKind,
} from '../../../shared/plugins/marketplace';
import type { PluginManager } from '../../plugins';
import { MarketplaceError } from '../../plugins/marketplace/types';

const pluginKinds = new Set<string>(Object.values(PluginKind));
const installOperations = new Set<string>(Object.values(MarketplaceInstallOperation));

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketplaceError(
      MarketplaceErrorCode.INVALID_REQUEST,
      'Marketplace request must be an object',
    );
  }
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, field: string, maxLength = 256): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MarketplaceError(
      MarketplaceErrorCode.INVALID_REQUEST,
      `Marketplace ${field} is required`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new MarketplaceError(
      MarketplaceErrorCode.INVALID_REQUEST,
      `Marketplace ${field} is too long`,
    );
  }
  return normalized;
};

const optionalString = (
  value: unknown,
  field: string,
  maxLength = 256,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new MarketplaceError(
      MarketplaceErrorCode.INVALID_REQUEST,
      `Marketplace ${field} must be a string`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new MarketplaceError(
      MarketplaceErrorCode.INVALID_REQUEST,
      `Marketplace ${field} is too long`,
    );
  }
  return normalized || undefined;
};

const requireKind = (kind: unknown): MarketplaceQuery['kind'] => {
  if (typeof kind !== 'string' || !pluginKinds.has(kind)) {
    throw new MarketplaceError(
      MarketplaceErrorCode.UNSUPPORTED_KIND,
      'Unsupported marketplace plugin kind',
    );
  }
  return kind as MarketplaceQuery['kind'];
};

const optionalLimit = (limit: unknown): number | undefined => {
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new MarketplaceError(
      MarketplaceErrorCode.INVALID_REQUEST,
      'Marketplace limit must be a number',
    );
  }
  return limit;
};

const optionalOperation = (operation: unknown): MarketplaceInstallRequest['operation'] => {
  if (operation === undefined) return undefined;
  if (typeof operation !== 'string' || !installOperations.has(operation)) {
    throw new MarketplaceError(
      MarketplaceErrorCode.INVALID_REQUEST,
      'Unsupported marketplace install operation',
    );
  }
  return operation as MarketplaceInstallRequest['operation'];
};

const publicError = (
  error: unknown,
): { error: string; errorCode: (typeof MarketplaceErrorCode)[keyof typeof MarketplaceErrorCode] } => {
  if (error instanceof MarketplaceError) {
    return { error: error.message, errorCode: error.code };
  }
  return {
    error: 'Marketplace request failed',
    errorCode: MarketplaceErrorCode.INTERNAL,
  };
};

const logError = (operation: string, error: unknown): void => {
  const safe = publicError(error);
  console.error(`[PluginMarketplace] ${operation} failed:`, safe.errorCode, safe.error);
};

export const registerMarketplaceHandlers = (pluginManager: PluginManager): void => {
  ipcMain.handle(
    MarketplaceIpc.ListSources,
    async (_event, kind?: unknown): Promise<MarketplaceSourcesResponse> => {
      try {
        return {
          success: true,
          sources: pluginManager.listMarketplaceSources(
            kind === undefined ? undefined : requireKind(kind),
          ),
        };
      } catch (error) {
        logError('list sources', error);
        return { success: false, ...publicError(error) };
      }
    },
  );

  ipcMain.handle(
    MarketplaceIpc.Search,
    async (_event, query: unknown): Promise<MarketplaceSearchResponse> => {
      try {
        const input = requireRecord(query);
        const result = await pluginManager.searchMarketplace({
          kind: requireKind(input.kind),
          query: optionalString(input.query, 'query', 500),
          limit: optionalLimit(input.limit),
          cursor: optionalString(input.cursor, 'cursor', 4096),
          sourceId: optionalString(input.sourceId, 'source id'),
        });
        return { success: true, result };
      } catch (error) {
        logError('search', error);
        return { success: false, ...publicError(error) };
      }
    },
  );

  ipcMain.handle(
    MarketplaceIpc.Detail,
    async (_event, request: unknown): Promise<MarketplaceDetailResponse> => {
      try {
        const input = requireRecord(request);
        const detail = await pluginManager.getMarketplaceDetail({
          sourceId: requireString(input.sourceId, 'source id'),
          pluginId: requireString(input.pluginId, 'plugin id'),
          kind: requireKind(input.kind),
        });
        return { success: true, detail };
      } catch (error) {
        logError('detail', error);
        return { success: false, ...publicError(error) };
      }
    },
  );

  ipcMain.handle(
    MarketplaceIpc.Install,
    async (_event, request: unknown): Promise<MarketplaceInstallResponse> => {
      try {
        const input = requireRecord(request);
        const result = await pluginManager.installFromMarketplace({
          sourceId: requireString(input.sourceId, 'source id'),
          pluginId: requireString(input.pluginId, 'plugin id'),
          kind: requireKind(input.kind),
          version: optionalString(input.version, 'version', 128),
          operation: optionalOperation(input.operation),
        });
        return result;
      } catch (error) {
        logError('install', error);
        return { success: false, ...publicError(error) };
      }
    },
  );
};
