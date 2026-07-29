import { createHash } from 'crypto';
import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import {
  type OpenClawCompactionDetailLookup,
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
const MAX_COMPACTION_DETAIL_IDS = 250;
const MAX_COMPACTION_ENTRY_ID_LENGTH = 256;
const MAX_COMPACTION_DETAIL_CACHE_SESSIONS = 100;
const MAX_COMPACTION_TRACKED_IDS_PER_SESSION = 500;
const MAX_COMPACTION_CACHED_SUMMARY_CHARS_PER_SESSION = 500_000;
const MAX_COMPACTION_TRANSCRIPT_LINE_BYTES = 4 * 1024 * 1024;
const COMPACTION_SENTINEL_BYTES = 2048;
const COMPACTION_ENTRY_LINE_PATTERN = /"type"\s*:\s*"compaction"/;

type TranscriptFileSnapshot = {
  filePath: string;
  identity: string;
  size: number;
  mtimeMs: number;
};

type CompactionDetailCacheEntry = {
  details: OpenClawCompactionDetailLookup;
  files: Map<
    string,
    TranscriptFileSnapshot & {
      scannedSize: number;
      sentinel: string;
    }
  >;
  trackedIds: Map<string, true>;
  summaryChars: number;
};

const compactionDetailCache = new Map<string, CompactionDetailCacheEntry>();
const compactionDetailCacheLocks = new Map<string, Promise<void>>();

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

const readAgentId = (sessionKey: string): string | null => {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  if (!match) return 'main';
  const agentId = match[1]?.trim() ?? '';
  if (
    !agentId ||
    agentId === '.' ||
    agentId === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)
  ) {
    return null;
  }
  return agentId;
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
  if (!agentId) return [];
  const agentsDir = path.resolve(stateDir, 'agents');
  const sessionsDir = path.resolve(agentsDir, agentId, 'sessions');
  if (!isWithinDirectory(sessionsDir, agentsDir)) return [];
  let realAgentsDir: string;
  let realSessionsDir: string;
  try {
    [realAgentsDir, realSessionsDir] = await Promise.all([
      fs.promises.realpath(agentsDir),
      fs.promises.realpath(sessionsDir),
    ]);
  } catch {
    return [];
  }
  if (!isWithinDirectory(realSessionsDir, realAgentsDir)) return [];

  const storePath = path.join(realSessionsDir, 'sessions.json');
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
      ? path.resolve(realSessionsDir, entry.sessionFile.trim())
      : path.join(realSessionsDir, `${sessionId}.jsonl`);
  if (!isWithinDirectory(configuredFile, realSessionsDir)) return [];

  let names: string[];
  try {
    names = await fs.promises.readdir(realSessionsDir);
  } catch {
    return [];
  }
  const primaryName = path.basename(configuredFile);
  const archivePrefix = `${primaryName}.`;
  const candidates = names
    .filter(
      name =>
        name === primaryName ||
        (name.startsWith(archivePrefix) &&
          (name.includes('.reset.') || name.includes('.bak.'))),
    )
    .sort()
    .map(name => path.join(realSessionsDir, name));
  const resolved = await Promise.all(
    candidates.map(async candidate => {
      try {
        const realCandidate = await fs.promises.realpath(candidate);
        if (!isWithinDirectory(realCandidate, realSessionsDir)) return null;
        const stat = await fs.promises.stat(realCandidate);
        return stat.isFile() ? realCandidate : null;
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter((filePath): filePath is string => Boolean(filePath));
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
    let lines: readline.Interface | undefined;
    try {
      input = fs.createReadStream(filePath, { encoding: 'utf-8' });
    } catch {
      continue;
    }
    try {
      lines = readline.createInterface({ input, crlfDelay: Infinity });
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
      // Treat transcript hydration as best effort.
    } finally {
      lines?.close();
      input.destroy();
    }
  }
  return found;
};

export const collectCompactionDetailsFromFiles = async (
  filePaths: string[],
  targetIds: Set<string>,
): Promise<OpenClawCompactionDetailLookup> => {
  const found: OpenClawCompactionDetailLookup = {};
  for (const filePath of filePaths) {
    if (Object.keys(found).length >= targetIds.size) break;
    let input: fs.ReadStream;
    let lines: readline.Interface | undefined;
    try {
      input = fs.createReadStream(filePath, { encoding: 'utf-8' });
    } catch {
      continue;
    }
    try {
      lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!COMPACTION_ENTRY_LINE_PATTERN.test(line)) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const id = typeof entry.id === 'string' ? entry.id : '';
          if (entry.type !== 'compaction' || !targetIds.has(id) || found[id]) continue;
          const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
          const tokensBefore =
            typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore)
              ? entry.tokensBefore
              : undefined;
          const tokensAfter =
            typeof entry.tokensAfter === 'number' && Number.isFinite(entry.tokensAfter)
              ? entry.tokensAfter
              : undefined;
          if (!summary && tokensBefore === undefined && tokensAfter === undefined) continue;
          found[id] = {
            ...(summary ? { summary } : {}),
            ...(tokensBefore !== undefined ? { tokensBefore } : {}),
            ...(tokensAfter !== undefined ? { tokensAfter } : {}),
          };
        } catch {
          continue;
        }
        if (Object.keys(found).length >= targetIds.size) break;
      }
    } catch {
      // Treat transcript hydration as best effort.
    } finally {
      lines?.close();
      input.destroy();
    }
  }
  return found;
};

const readTranscriptFileSnapshots = async (
  filePaths: string[],
): Promise<TranscriptFileSnapshot[]> => {
  const snapshots = await Promise.all(
    [...new Set(filePaths.map(filePath => path.resolve(filePath)))].map(
      async filePath => {
        try {
          const stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) return null;
          return {
            filePath,
            identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        } catch {
          return null;
        }
      },
    ),
  );
  return snapshots
    .filter((snapshot): snapshot is TranscriptFileSnapshot => Boolean(snapshot))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
};

const collectCompactionDetailsFromFileRange = async (
  snapshot: TranscriptFileSnapshot,
  start: number,
  targetIds: Set<string>,
): Promise<{ details: OpenClawCompactionDetailLookup; scannedSize: number }> => {
  if (snapshot.size <= start) return { details: {}, scannedSize: start };
  const found: OpenClawCompactionDetailLookup = {};
  let input: fs.ReadStream;
  try {
    input = fs.createReadStream(snapshot.filePath, {
      start,
      end: snapshot.size - 1,
    });
  } catch {
    return { details: found, scannedSize: start };
  }
  let pending = Buffer.alloc(0);
  let oversizedLine = false;
  let chunkStart = start;
  let scannedSize = start;
  const appendSegment = (segment: Buffer): void => {
    if (oversizedLine || segment.length === 0) return;
    if (pending.length + segment.length > MAX_COMPACTION_TRANSCRIPT_LINE_BYTES) {
      pending = Buffer.alloc(0);
      oversizedLine = true;
      return;
    }
    pending = pending.length === 0 ? Buffer.from(segment) : Buffer.concat([pending, segment]);
  };
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let segmentStart = 0;
      while (segmentStart < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, segmentStart);
        if (newlineIndex < 0) {
          appendSegment(chunk.subarray(segmentStart));
          break;
        }
        appendSegment(chunk.subarray(segmentStart, newlineIndex));
        if (!oversizedLine) {
          const lineBuffer =
            pending[pending.length - 1] === 0x0d ? pending.subarray(0, -1) : pending;
          const line = lineBuffer.toString('utf-8');
          if (COMPACTION_ENTRY_LINE_PATTERN.test(line)) {
            try {
              const entry = JSON.parse(line) as Record<string, unknown>;
              const id = typeof entry.id === 'string' ? entry.id : '';
              if (entry.type === 'compaction' && targetIds.has(id)) {
                const summary =
                  typeof entry.summary === 'string' ? entry.summary.trim() : '';
                const tokensBefore =
                  typeof entry.tokensBefore === 'number' &&
                  Number.isFinite(entry.tokensBefore)
                    ? entry.tokensBefore
                    : undefined;
                const tokensAfter =
                  typeof entry.tokensAfter === 'number' &&
                  Number.isFinite(entry.tokensAfter)
                    ? entry.tokensAfter
                    : undefined;
                if (summary || tokensBefore !== undefined || tokensAfter !== undefined) {
                  found[id] = {
                    ...(summary ? { summary } : {}),
                    ...(tokensBefore !== undefined ? { tokensBefore } : {}),
                    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
                  };
                }
              }
            } catch {
              // Ignore malformed complete lines.
            }
          }
        }
        pending = Buffer.alloc(0);
        oversizedLine = false;
        scannedSize = chunkStart + newlineIndex + 1;
        segmentStart = newlineIndex + 1;
      }
      chunkStart += chunk.length;
    }
  } catch {
    // Treat transcript hydration as best effort.
  } finally {
    input.destroy();
  }
  return { details: found, scannedSize };
};

const readCompactionFileSentinel = async (
  filePath: string,
  scannedSize: number,
): Promise<string> => {
  if (scannedSize <= 0) return '';
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const firstLength = Math.min(COMPACTION_SENTINEL_BYTES, scannedSize);
    const lastStart = Math.max(0, scannedSize - COMPACTION_SENTINEL_BYTES);
    const lastLength = scannedSize - lastStart;
    const first = Buffer.alloc(firstLength);
    const last = Buffer.alloc(lastLength);
    await Promise.all([
      handle.read(first, 0, firstLength, 0),
      handle.read(last, 0, lastLength, lastStart),
    ]);
    return createHash('sha256').update(first).update(last).digest('hex');
  } finally {
    await handle.close();
  }
};

const canIncrementCompactionCache = async (
  existing: CompactionDetailCacheEntry,
  snapshots: TranscriptFileSnapshot[],
): Promise<boolean> => {
  const currentByPath = new Map(snapshots.map(snapshot => [snapshot.filePath, snapshot]));
  for (const previous of existing.files.values()) {
    const current = currentByPath.get(previous.filePath);
    if (!current) return false;
    if (current.identity !== previous.identity || current.size < previous.scannedSize) return false;
    try {
      if (
        (await readCompactionFileSentinel(current.filePath, previous.scannedSize)) !==
        previous.sentinel
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
};

const withCompactionCacheLock = async <T>(
  cacheKey: string,
  task: () => Promise<T>,
): Promise<T> => {
  const previous = compactionDetailCacheLocks.get(cacheKey) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  compactionDetailCacheLocks.set(cacheKey, queued);
  await previous;
  try {
    return await task();
  } finally {
    release?.();
    if (compactionDetailCacheLocks.get(cacheKey) === queued) {
      compactionDetailCacheLocks.delete(cacheKey);
    }
  }
};

const compactionSummaryChars = (
  detail: OpenClawCompactionDetailLookup[string] | undefined,
): number => detail?.summary?.length ?? 0;

const enforceCompactionCacheLimits = (cached: CompactionDetailCacheEntry): void => {
  while (
    cached.trackedIds.size > MAX_COMPACTION_TRACKED_IDS_PER_SESSION ||
    cached.summaryChars > MAX_COMPACTION_CACHED_SUMMARY_CHARS_PER_SESSION
  ) {
    const oldestId = cached.trackedIds.keys().next().value;
    if (typeof oldestId !== 'string') break;
    cached.trackedIds.delete(oldestId);
    cached.summaryChars -= compactionSummaryChars(cached.details[oldestId]);
    delete cached.details[oldestId];
  }
};

const readCachedCompactionDetailsUnlocked = async (
  cacheKey: string,
  filePaths: string[],
  targetIds: Set<string>,
): Promise<OpenClawCompactionDetailLookup> => {
  const snapshots = await readTranscriptFileSnapshots(filePaths);
  const existing = compactionDetailCache.get(cacheKey);
  const incremental = existing && (await canIncrementCompactionCache(existing, snapshots));
  const cached: CompactionDetailCacheEntry = {
    details: incremental ? existing.details : {},
    files: new Map(),
    trackedIds: incremental ? existing.trackedIds : new Map(),
    summaryChars: incremental ? existing.summaryChars : 0,
  };
  const newTargetIds = new Set([...targetIds].filter(id => !cached.trackedIds.has(id)));
  for (const id of targetIds) {
    cached.trackedIds.delete(id);
    cached.trackedIds.set(id, true);
  }
  const scanTargetIds = new Set(cached.trackedIds.keys());
  const responseDetails: OpenClawCompactionDetailLookup = {};
  for (const snapshot of snapshots) {
    const previous = incremental ? existing.files.get(snapshot.filePath) : undefined;
    const mustScanPrefix = newTargetIds.size > 0 && previous;
    const scanStart = mustScanPrefix ? 0 : (previous?.scannedSize ?? 0);
    const scanned = await collectCompactionDetailsFromFileRange(
      snapshot,
      scanStart,
      scanTargetIds,
    );
    for (const [id, detail] of Object.entries(scanned.details)) {
      responseDetails[id] = detail;
      if (!cached.trackedIds.has(id)) continue;
      cached.summaryChars -= compactionSummaryChars(cached.details[id]);
      cached.details[id] = detail;
      cached.summaryChars += compactionSummaryChars(detail);
    }
    const scannedSize = mustScanPrefix
      ? scanned.scannedSize
      : Math.max(previous?.scannedSize ?? 0, scanned.scannedSize);
    cached.files.set(snapshot.filePath, {
      ...snapshot,
      scannedSize,
      sentinel: await readCompactionFileSentinel(snapshot.filePath, scannedSize),
    });
  }
  enforceCompactionCacheLimits(cached);

  compactionDetailCache.delete(cacheKey);
  compactionDetailCache.set(cacheKey, cached);
  while (compactionDetailCache.size > MAX_COMPACTION_DETAIL_CACHE_SESSIONS) {
    const oldestKey = compactionDetailCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    compactionDetailCache.delete(oldestKey);
  }

  return Object.fromEntries(
    [...targetIds].flatMap(id => {
      const detail = cached.details[id] ?? responseDetails[id];
      return detail ? [[id, detail]] : [];
    }),
  );
};

export const readCachedCompactionDetails = async (
  cacheKey: string,
  filePaths: string[],
  targetIds: Set<string>,
): Promise<OpenClawCompactionDetailLookup> =>
  withCompactionCacheLock(cacheKey, () =>
    readCachedCompactionDetailsUnlocked(cacheKey, filePaths, targetIds),
  );

const normalizeCursor = (value: unknown): string | undefined => {
  const cursor = typeof value === 'string' ? value.trim() : '';
  return cursor || undefined;
};

const normalizeHistoryPageLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HISTORY_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_PAGE_LIMIT, Math.floor(value)));
};

export const normalizeCompactionEntryIds = (
  value: unknown,
): { ids: string[]; error?: string } => {
  const rawEntryIds = Array.isArray(value) ? value : [];
  if (rawEntryIds.length > MAX_COMPACTION_DETAIL_IDS) {
    return { ids: [], error: 'Too many compaction entry IDs' };
  }
  const ids = new Set<string>();
  for (const rawId of rawEntryIds) {
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (!id) continue;
    if (id.length > MAX_COMPACTION_ENTRY_ID_LENGTH) {
      return { ids: [], error: 'Compaction entry ID is too long' };
    }
    ids.add(id);
  }
  return { ids: [...ids] };
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
        const { ids: entryIds, error: entryIdError } = normalizeCompactionEntryIds(
          params?.entryIds,
        );
        if (entryIdError) return { success: false, error: entryIdError };
        if (entryIds.length === 0) return { success: true, details: {} };
        const sessionKey = normalizeSessionKey(params?.sessionKey);
        if (!sessionKey) return { success: false, error: 'Missing session key' };

        const stateDir = getStateDir();
        const sessionFiles = await resolveSessionTranscriptFiles(stateDir, sessionKey);
        const details = await readCachedCompactionDetails(
          `${path.resolve(stateDir)}\0${sessionKey}`,
          sessionFiles,
          new Set(entryIds),
        );
        return { success: true, details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
