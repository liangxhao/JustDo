import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import {
  OpenClawHistoryIpc,
  type OpenClawPagedHistoryParams,
  type OpenClawPagedHistoryResult,
} from '../../../shared/openclaw/historyIpc';

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

const DEFAULT_HISTORY_PAGE_LIMIT = 250;
const MAX_HISTORY_PAGE_LIMIT = 500;

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

const normalizeSessionKey = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const readAgentId = (sessionKey: string): string => {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1]?.trim() || 'main';
};

const isWithinDirectory = (candidate: string, directory: string): boolean => {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
};

/**
 * Resolve only the transcript owned by the requested OpenClaw session. Reset
 * and backup artifacts are allowed solely when they share the same session id.
 */
export const resolveSessionTranscriptFiles = async (
  stateDir: string,
  sessionKey: string,
): Promise<string[]> => {
  const agentId = readAgentId(sessionKey);
  const sessionsDir = path.join(stateDir, 'agents', agentId, 'sessions');
  const storePath = path.join(sessionsDir, 'sessions.json');
  let store: Record<string, unknown>;
  try {
    store = JSON.parse(await fs.promises.readFile(storePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return [];
  }

  const alias =
    sessionKey.startsWith('agent:') || agentId !== 'main'
      ? sessionKey
      : `agent:main:${sessionKey}`;
  const rawEntry = store[sessionKey] ?? store[alias];
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return [];
  const entry = rawEntry as Record<string, unknown>;
  const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : '';
  if (!sessionId) return [];

  const configuredFile =
    typeof entry.sessionFile === 'string' && entry.sessionFile.trim()
      ? path.resolve(sessionsDir, entry.sessionFile.trim())
      : path.join(sessionsDir, `${sessionId}.jsonl`);
  if (!isWithinDirectory(configuredFile, sessionsDir)) return [];

  let names: string[];
  try {
    names = await fs.promises.readdir(sessionsDir);
  } catch {
    return [];
  }
  const primaryName = path.basename(configuredFile);
  const archivePrefix = `${primaryName}.`;
  return names
    .filter(
      name =>
        name === primaryName ||
        (name.startsWith(archivePrefix) &&
          (name.includes('.reset.') || name.includes('.bak.'))),
    )
    .map(name => path.join(sessionsDir, name));
};

export const collectToolInputsFromFiles = async (
  filePaths: string[],
  targetIds: Set<string>,
): Promise<OpenClawToolInputLookup> => {
  const found: OpenClawToolInputLookup = {};
  const targetIdList = [...targetIds];
  for (const filePath of filePaths) {
    if (Object.keys(found).length >= targetIds.size) break;
    let input: fs.ReadStream;
    try {
      input = fs.createReadStream(filePath, { encoding: 'utf-8' });
    } catch {
      continue;
    }
    try {
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim() || !targetIdList.some(id => line.includes(id))) continue;
        try {
          collectToolInputsFromValue(JSON.parse(line), targetIds, found);
        } catch {
          continue;
        }
        if (Object.keys(found).length >= targetIds.size) break;
      }
    } catch {
      input.destroy();
    }
  }
  return found;
};

const normalizeCursor = (value: unknown): string | undefined => {
  const cursor = typeof value === 'string' ? value.trim() : '';
  return cursor || undefined;
};

const normalizeHistoryPageLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HISTORY_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_PAGE_LIMIT, Math.floor(value)));
};

export const fetchPagedHistoryFromGateway = async (params: {
  sessionKey: string;
  port: number;
  token?: string | null;
  cursor?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<{
  messages: unknown[];
  hasMore: boolean;
  nextCursor?: string;
}> => {
  const fetcher = params.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (params.token) headers.Authorization = `Bearer ${params.token}`;

  const cursor = normalizeCursor(params.cursor);
  const query = new URLSearchParams({
    limit: String(normalizeHistoryPageLimit(params.limit)),
  });
  if (cursor) query.set('cursor', cursor);
  const url = `http://127.0.0.1:${params.port}/sessions/${encodeURIComponent(
    params.sessionKey,
  )}/history?${query}`;
  const response = await fetcher(url, { headers });
  if (!response.ok) {
    throw new OpenClawHistoryRestError(response.status);
  }
  const body = (await response.json()) as PagedHistoryPage;
  const nextCursor = body.hasMore === true ? normalizeCursor(body.nextCursor) : undefined;
  return {
    messages: Array.isArray(body.messages) ? body.messages : [],
    hasMore: Boolean(nextCursor),
    nextCursor,
  };
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
        const sessionKey = normalizeSessionKey(params?.sessionKey);
        if (!sessionKey) return { success: false, error: 'Missing session key' };

        const targetIds = new Set(toolCallIds);
        const sessionFiles = await resolveSessionTranscriptFiles(getStateDir(), sessionKey);
        const found = await collectToolInputsFromFiles(sessionFiles, targetIds);
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
    async (
      _event,
      params: Partial<OpenClawPagedHistoryParams>,
    ): Promise<OpenClawPagedHistoryResult> => {
      try {
        const sessionKey = normalizeSessionKey(params?.sessionKey);
        if (!sessionKey) return { success: false, error: 'Missing session key' };
        const connection = getGatewayConnectionInfo?.();
        const port = connection?.port;
        if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
          return { success: false, error: 'Gateway port not available' };
        }

        const page = await fetchPagedHistoryFromGateway({
          sessionKey,
          port,
          token: connection?.token ?? null,
          cursor: normalizeCursor(params?.cursor),
          limit: normalizeHistoryPageLimit(params?.limit),
        });
        return { success: true, ...page };
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
