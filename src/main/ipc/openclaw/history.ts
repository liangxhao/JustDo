import { ipcMain } from 'electron';

import {
  OPENCLAW_HISTORY_DETAIL_MAX_IDS,
  type OpenClawCompactionDetailLookup,
  OpenClawHistoryIpc,
} from '../../../shared/openclaw/historyIpc';
import { parseHistoryDetailsResultV2026_9_2 } from '../../engine/openclaw/wire/v2026_9_2';

export type OpenClawToolInputLookup = Record<string, { name?: string; input: unknown }>;

type OpenClawHistoryHandlerDependencies = {
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
};

const MAX_DETAIL_ID_LENGTH = 256;

const normalizeSessionKey = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export const normalizeDetailIds = (
  value: unknown,
  label: string,
): { ids: string[]; error?: string } => {
  const rawIds = Array.isArray(value) ? value : [];
  if (rawIds.length > OPENCLAW_HISTORY_DETAIL_MAX_IDS) {
    return { ids: [], error: `Too many ${label} IDs` };
  }
  const ids = new Set<string>();
  for (const rawId of rawIds) {
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (!id) continue;
    if (id.length > MAX_DETAIL_ID_LENGTH) return { ids: [], error: `${label} ID is too long` };
    ids.add(id);
  }
  return { ids: [...ids] };
};

const publicError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"']+/g, '[path]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
};

const requestHistoryDetails = async (
  dependencies: OpenClawHistoryHandlerDependencies,
  params: {
    sessionKey: string;
    toolCallIds?: string[];
    compactionEntryIds?: string[];
  },
) =>
  parseHistoryDetailsResultV2026_9_2(
    await dependencies.requestGateway('justdoRuntimeBridge.historyDetails', params),
  );

export const registerOpenClawHistoryHandlers = (
  dependencies: OpenClawHistoryHandlerDependencies,
): void => {
  ipcMain.handle(
    OpenClawHistoryIpc.GetToolInputs,
    async (
      _event,
      params: { sessionKey?: unknown; toolCallIds?: unknown },
    ): Promise<{ success: boolean; inputs?: OpenClawToolInputLookup; error?: string }> => {
      try {
        const normalized = normalizeDetailIds(params?.toolCallIds, 'tool call');
        if (normalized.error) return { success: false, error: normalized.error };
        if (normalized.ids.length === 0) return { success: true, inputs: {} };
        const sessionKey = normalizeSessionKey(params?.sessionKey);
        if (!sessionKey) return { success: false, error: 'Missing session key' };
        const details = await requestHistoryDetails(dependencies, {
          sessionKey,
          toolCallIds: normalized.ids,
        });
        return { success: true, inputs: details.toolInputs };
      } catch (error) {
        const message = publicError(error);
        console.warn('[OpenClawHistory] failed to hydrate tool inputs:', message);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    OpenClawHistoryIpc.GetCompactionDetails,
    async (
      _event,
      params: { sessionKey?: unknown; entryIds?: unknown },
    ): Promise<{
      success: boolean;
      details?: OpenClawCompactionDetailLookup;
      error?: string;
    }> => {
      try {
        const normalized = normalizeDetailIds(params?.entryIds, 'compaction entry');
        if (normalized.error) return { success: false, error: normalized.error };
        if (normalized.ids.length === 0) return { success: true, details: {} };
        const sessionKey = normalizeSessionKey(params?.sessionKey);
        if (!sessionKey) return { success: false, error: 'Missing session key' };
        const details = await requestHistoryDetails(dependencies, {
          sessionKey,
          compactionEntryIds: normalized.ids,
        });
        return { success: true, details: details.compactionDetails };
      } catch (error) {
        const message = publicError(error);
        console.warn('[OpenClawHistory] failed to hydrate compaction details:', message);
        return { success: false, error: message };
      }
    },
  );

};
