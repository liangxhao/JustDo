import { ipcMain } from 'electron';

import {
  type OpenClawCompactionDetailLookup,
  OpenClawHistoryIpc,
  type OpenClawPagedHistoryParams,
  type OpenClawPagedHistoryResult,
} from '../../../shared/openclaw/historyIpc';
import {
  parseChatHistoryResultV2026_8_2,
  parseHistoryDetailsResultV2026_8_2,
} from '../../engine/openclaw/wire/v2026_8_2';

export type OpenClawToolInputLookup = Record<string, { name?: string; input: unknown }>;

type OpenClawHistoryHandlerDependencies = {
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
};

const DEFAULT_HISTORY_PAGE_LIMIT = 250;
const MAX_HISTORY_PAGE_LIMIT = 500;
const MAX_DETAIL_IDS = 250;
const MAX_DETAIL_ID_LENGTH = 256;
const OFFSET_CURSOR_PREFIX = 'offset:';

const normalizeSessionKey = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeHistoryPageLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HISTORY_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_PAGE_LIMIT, Math.floor(value)));
};

export const encodeHistoryOffsetCursor = (offset: number): string =>
  `${OFFSET_CURSOR_PREFIX}${offset}`;

export const decodeHistoryOffsetCursor = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.startsWith(OFFSET_CURSOR_PREFIX)) {
    throw new Error('Invalid history cursor');
  }
  const offset = Number(value.slice(OFFSET_CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history cursor');
  return offset;
};

export const normalizeDetailIds = (
  value: unknown,
  label: string,
): { ids: string[]; error?: string } => {
  const rawIds = Array.isArray(value) ? value : [];
  if (rawIds.length > MAX_DETAIL_IDS) return { ids: [], error: `Too many ${label} IDs` };
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
  parseHistoryDetailsResultV2026_8_2(
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

  ipcMain.handle(
    OpenClawHistoryIpc.GetPagedHistory,
    async (
      _event,
      params: Partial<OpenClawPagedHistoryParams>,
    ): Promise<OpenClawPagedHistoryResult> => {
      try {
        const sessionKey = normalizeSessionKey(params?.sessionKey);
        if (!sessionKey) return { success: false, error: 'Missing session key' };
        const limit = normalizeHistoryPageLimit(params?.limit);
        const offset = decodeHistoryOffsetCursor(params?.cursor);
        const page = parseChatHistoryResultV2026_8_2(
          await dependencies.requestGateway('chat.history', {
            sessionKey,
            limit,
            ...(offset !== undefined ? { offset } : {}),
          }),
        );
        return {
          success: true,
          messages: page.messages,
          hasMore: page.hasMore,
          ...(page.hasMore && page.nextOffset !== undefined
            ? { nextCursor: encodeHistoryOffsetCursor(page.nextOffset) }
            : {}),
        };
      } catch (error) {
        const message = publicError(error);
        console.warn('[OpenClawHistory] failed to load paged history:', message);
        return { success: false, error: message };
      }
    },
  );
};
