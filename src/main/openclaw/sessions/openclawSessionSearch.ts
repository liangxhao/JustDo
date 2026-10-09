import { normalizeOpenClawAgentId } from '../../../shared/agents/agentId';
import type {
  CoworkSessionMessageSearchMatch,
  CoworkSessionSearchOptions,
} from '../../../shared/cowork/sessionSearch';
import type { CoworkStore } from '../../data/coworkStore';
import {
  type OpenClawSessionsSearchHitV2026_9_8,
  parseSessionsSearchResultV2026_9_8,
} from '../../engine/openclaw/wire/v2026_9_8';
import { buildManagedSessionKey } from './openclawSessionKeys';

const SESSION_KEYS_PER_REQUEST = 200;
const SEARCH_RESULTS_PER_REQUEST = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;
const MAX_GATEWAY_REQUESTS = 128;
const MAX_CONCURRENT_REQUESTS = 4;

type GatewayRequest = (method: string, params: unknown) => Promise<unknown>;

interface SearchBatchResult {
  hits: OpenClawSessionsSearchHitV2026_9_8[];
  indexing: boolean;
  truncated: boolean;
  partial: boolean;
  archivedTranscriptsExcluded: number;
}

interface OpenClawSessionSearchOptions {
  query: string;
  store: Pick<CoworkStore, 'listSessions'>;
  requestGateway: GatewayRequest;
  options?: CoworkSessionSearchOptions;
}

export const parseCoworkSessionSearchOptions = (value: unknown): CoworkSessionSearchOptions => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Search options must be an object');
  }
  const result: CoworkSessionSearchOptions = {};
  for (const [key, ids] of Object.entries(value)) {
    if (key !== 'sessionIds' && key !== 'excludeSessionIds') {
      throw new Error('Unknown search option');
    }
    if (
      !Array.isArray(ids) ||
      ids.length > 10_000 ||
      ids.some(id => typeof id !== 'string' || !id || id.length > 512)
    ) {
      throw new Error('Search session IDs must be a bounded string array');
    }
    result[key] = Array.from(new Set(ids as string[]));
  }
  return result;
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const createRequestLimiter = (limit: number) => {
  let active = 0;
  const pending: Array<() => Promise<void>> = [];

  const pump = (): void => {
    while (active < limit) {
      const next = pending.shift();
      if (!next) return;
      active += 1;
      void next();
    }
  };

  return <T>(operation: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.push(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        } finally {
          active -= 1;
          pump();
        }
      });
      pump();
    });
};

const combineSettledBatches = (
  batches: PromiseSettledResult<SearchBatchResult>[],
): SearchBatchResult => {
  const fulfilled = batches.filter(
    (batch): batch is PromiseFulfilledResult<SearchBatchResult> => batch.status === 'fulfilled',
  );

  if (fulfilled.length === 0) {
    const failure = batches.find(
      (batch): batch is PromiseRejectedResult => batch.status === 'rejected',
    );
    throw failure?.reason ?? new Error('Session search failed');
  }

  return {
    hits: fulfilled.flatMap(batch => batch.value.hits),
    indexing: fulfilled.some(batch => batch.value.indexing),
    truncated: fulfilled.some(batch => batch.value.truncated),
    partial: fulfilled.some(batch => batch.value.partial) || fulfilled.length !== batches.length,
    archivedTranscriptsExcluded: fulfilled.reduce(
      (count, batch) => count + batch.value.archivedTranscriptsExcluded,
      0,
    ),
  };
};

const isBetterHit = (
  candidate: OpenClawSessionsSearchHitV2026_9_8,
  current: OpenClawSessionsSearchHitV2026_9_8,
): boolean =>
  candidate.score > current.score ||
  (candidate.score === current.score && candidate.timestamp > current.timestamp);

export const searchCoworkSessionMessages = async ({
  query,
  store,
  requestGateway,
  options = {},
}: OpenClawSessionSearchOptions) => {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      matches: [],
      indexing: false,
      truncated: false,
      partial: false,
      archivedTranscriptsExcluded: 0,
    };
  }
  if (trimmedQuery.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`Search query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }

  const includedIds = options.sessionIds ? new Set(options.sessionIds) : null;
  const excludedIds = new Set(options.excludeSessionIds);
  const sessions = store
    .listSessions()
    .filter(
      session => (!includedIds || includedIds.has(session.id)) && !excludedIds.has(session.id),
    );
  if (sessions.length === 0) {
    return {
      matches: [],
      indexing: false,
      truncated: false,
      partial: false,
      archivedTranscriptsExcluded: 0,
    };
  }

  const localSessionIdByKey = new Map<string, string>();
  const keysByAgent = new Map<string, string[]>();

  for (const session of sessions) {
    const agentId = normalizeOpenClawAgentId(session.agentId ?? 'main');
    const sessionKey =
      session.nativeSessionKey ||
      session.external?.sessionKey ||
      buildManagedSessionKey(session.id, agentId);
    localSessionIdByKey.set(sessionKey, session.id);
    const keys = keysByAgent.get(agentId) ?? [];
    keys.push(sessionKey);
    keysByAgent.set(agentId, keys);
  }

  const limitedRequest = createRequestLimiter(MAX_CONCURRENT_REQUESTS);
  let requestCount = 0;

  const searchBatch = async (
    agentId: string,
    sessionKeys: string[],
  ): Promise<SearchBatchResult> => {
    if (requestCount >= MAX_GATEWAY_REQUESTS) {
      throw new Error('Session search request limit exceeded');
    }
    requestCount += 1;

    const page = parseSessionsSearchResultV2026_9_8(
      await limitedRequest(() =>
        requestGateway('sessions.search', {
          query: trimmedQuery,
          agentId,
          sessionKeys,
          limit: SEARCH_RESULTS_PER_REQUEST,
        }),
      ),
    );

    if (!page.truncated || sessionKeys.length === 1) {
      return {
        hits: page.results,
        indexing: page.indexing,
        // Once the batch contains one session, additional message hits cannot
        // hide another session and the first hit is already its best snippet.
        truncated: false,
        partial: false,
        archivedTranscriptsExcluded: page.archivedTranscriptsExcluded,
      };
    }

    const midpoint = Math.ceil(sessionKeys.length / 2);
    const children = await Promise.allSettled([
      searchBatch(agentId, sessionKeys.slice(0, midpoint)),
      searchBatch(agentId, sessionKeys.slice(midpoint)),
    ]);
    // A successful parent page remains useful if a child scope fails or the
    // request budget runs out. Keep those hits and report incomplete coverage.
    const combined = children.some(child => child.status === 'fulfilled')
      ? combineSettledBatches(children)
      : {
          hits: [],
          indexing: false,
          truncated: false,
          partial: true,
          archivedTranscriptsExcluded: 0,
        };
    return {
      ...combined,
      hits: combined.partial ? [...page.results, ...combined.hits] : combined.hits,
      // Parent and children cover the same scope; never count archives twice.
      archivedTranscriptsExcluded: Math.max(
        page.archivedTranscriptsExcluded,
        combined.archivedTranscriptsExcluded,
      ),
      indexing: page.indexing || combined.indexing,
    };
  };

  const initialBatches: Promise<SearchBatchResult>[] = [];
  for (const [agentId, sessionKeys] of keysByAgent) {
    for (const sessionKeyBatch of chunk(sessionKeys, SESSION_KEYS_PER_REQUEST)) {
      initialBatches.push(searchBatch(agentId, sessionKeyBatch));
    }
  }

  const combined = combineSettledBatches(await Promise.allSettled(initialBatches));
  const bestHitBySessionId = new Map<string, OpenClawSessionsSearchHitV2026_9_8>();

  for (const hit of combined.hits) {
    const localSessionId = localSessionIdByKey.get(hit.sessionKey);
    if (!localSessionId) continue;
    const current = bestHitBySessionId.get(localSessionId);
    if (!current || isBetterHit(hit, current)) {
      bestHitBySessionId.set(localSessionId, hit);
    }
  }

  const allMatches: CoworkSessionMessageSearchMatch[] = Array.from(
    bestHitBySessionId,
    ([sessionId, hit]) => ({
      sessionId,
      nativeSessionKey: hit.sessionKey,
      nativeSessionId: hit.sessionId,
      messageId: hit.messageId,
      role: hit.role,
      snippet: hit.snippet,
      timestamp: hit.timestamp,
      score: hit.score,
    }),
  ).sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);

  return {
    matches: allMatches.slice(0, SEARCH_RESULTS_PER_REQUEST),
    indexing: combined.indexing,
    truncated: combined.truncated || allMatches.length > SEARCH_RESULTS_PER_REQUEST,
    partial: combined.partial,
    archivedTranscriptsExcluded: combined.archivedTranscriptsExcluded,
  };
};
