import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

import { OpenClawHistoryIpc } from '../../../shared/openclawHistoryIpc';

export type OpenClawToolInputLookup = Record<string, { name?: string; input: unknown }>;

type GatewayConnectionInfo = {
  port: number | null;
  token: string | null;
};

type PagedHistoryPage = {
  messages?: unknown[];
  hasMore?: boolean;
  nextCursor?: string;
};

export type OpenClawPagedHistoryResult = {
  success: boolean;
  messages?: unknown[];
  error?: string;
};

const HISTORY_PAGE_LIMIT = 1000;

class OpenClawHistoryRestError extends Error {
  constructor(readonly status: number) {
    super(`OpenClaw history REST returned ${status}`);
    this.name = 'OpenClawHistoryRestError';
  }
}

const isHistoryRestNotFound = (error: unknown): boolean =>
  error instanceof OpenClawHistoryRestError && error.status === 404;

const coerceToolInput = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const hasToolInput = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

const resolveToolInput = (record: Record<string, unknown>): unknown => {
  for (const value of [record.arguments, record.args, record.input, record.toolInput]) {
    const coerced = coerceToolInput(value);
    if (hasToolInput(coerced)) return coerced;
  }
  return coerceToolInput(record.partialArgs);
};

export const collectToolInputsFromValue = (
  value: unknown,
  targetIds: Set<string>,
  found: OpenClawToolInputLookup,
  depth = 0,
): void => {
  if (depth > 8 || targetIds.size === Object.keys(found).length) return;
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolInputsFromValue(item, targetIds, found, depth + 1);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const id = [
    record.id,
    record.toolCallId,
    record.tool_call_id,
    record.toolUseId,
    record.tool_use_id,
  ].find(item => typeof item === 'string' && targetIds.has(item)) as string | undefined;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  if (
    id &&
    !found[id] &&
    ['toolcall', 'tool_call', 'tooluse', 'tool_use', 'functioncall', 'function_call'].includes(type)
  ) {
    const input = resolveToolInput(record);
    if (hasToolInput(input)) {
      found[id] = {
        name: typeof record.name === 'string' ? record.name : undefined,
        input,
      };
    }
  }

  for (const key of ['message', 'data', 'messages', 'content']) {
    collectToolInputsFromValue(record[key], targetIds, found, depth + 1);
  }
};

const collectSessionJsonlFiles = (rootDir: string): string[] => {
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }
  return files;
};

const normalizeSessionKey = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const normalizeCursor = (value: unknown): string | undefined => {
  const cursor = typeof value === 'string' ? value.trim() : '';
  return cursor || undefined;
};

export const fetchPagedHistoryFromGateway = async (params: {
  sessionKey: string;
  port: number;
  token?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<unknown[]> => {
  const fetcher = params.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (params.token) headers.Authorization = `Bearer ${params.token}`;

  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let messages: unknown[] = [];
  do {
    const query = new URLSearchParams({ limit: String(HISTORY_PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    const url = `http://127.0.0.1:${params.port}/sessions/${encodeURIComponent(
      params.sessionKey,
    )}/history?${query}`;
    const response = await fetcher(url, { headers });
    if (!response.ok) {
      throw new OpenClawHistoryRestError(response.status);
    }
    const body = (await response.json()) as PagedHistoryPage;
    const pageMessages = Array.isArray(body.messages) ? body.messages : [];
    messages = cursor ? [...pageMessages, ...messages] : pageMessages;
    cursor = body.hasMore === true ? normalizeCursor(body.nextCursor) : undefined;
    if (cursor && seenCursors.has(cursor)) {
      console.warn('[OpenClawHistory] repeated paged history cursor:', cursor);
      break;
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  return messages;
};

export const registerOpenClawHistoryHandlers = (
  getStateDir: () => string,
  getGatewayConnectionInfo?: () => GatewayConnectionInfo,
): void => {
  ipcMain.handle(
    OpenClawHistoryIpc.GetToolInputs,
    async (
      _event,
      params: { sessionKey?: unknown; toolCallIds?: unknown },
    ): Promise<{ success: boolean; inputs?: OpenClawToolInputLookup; error?: string }> => {
      try {
        const toolCallIds = Array.isArray(params?.toolCallIds)
          ? params.toolCallIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : [];
        if (toolCallIds.length === 0) return { success: true, inputs: {} };

        const targetIds = new Set(toolCallIds);
        const found: OpenClawToolInputLookup = {};
        const sessionFiles = collectSessionJsonlFiles(path.join(getStateDir(), 'agents'));

        for (const filePath of sessionFiles) {
          if (Object.keys(found).length >= targetIds.size) break;
          let text: string;
          try {
            text = fs.readFileSync(filePath, 'utf-8');
          } catch {
            continue;
          }
          if (!toolCallIds.some(id => text.includes(id))) continue;
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim() || !toolCallIds.some(id => line.includes(id))) continue;
            try {
              collectToolInputsFromValue(JSON.parse(line), targetIds, found);
            } catch {
              continue;
            }
          }
        }
        return { success: true, inputs: found };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[OpenClawHistory] failed to hydrate tool inputs:', message);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    OpenClawHistoryIpc.GetPagedHistory,
    async (_event, params: { sessionKey?: unknown }): Promise<OpenClawPagedHistoryResult> => {
      try {
        const sessionKey = normalizeSessionKey(params?.sessionKey);
        if (!sessionKey) return { success: false, error: 'Missing session key' };
        const connection = getGatewayConnectionInfo?.();
        const port = connection?.port;
        if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
          return { success: false, error: 'Gateway port not available' };
        }

        const messages = await fetchPagedHistoryFromGateway({
          sessionKey,
          port,
          token: connection?.token ?? null,
        });
        return { success: true, messages };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isHistoryRestNotFound(error)) {
          console.warn('[OpenClawHistory] failed to load paged history:', message);
        }
        return { success: false, error: message };
      }
    },
  );
};
