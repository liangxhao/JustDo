import type { CoworkSessionMessageSearchMatch } from '../../../shared/cowork/sessionSearch';
import { normalizeOpenClawAgentId } from '../../../shared/openclaw/agentId';
import type { CoworkStore } from '../../data/coworkStore';
import {
  type OpenClawSessionsSearchHitV2026_9_2,
  parseSessionsSearchResultV2026_9_2,
} from '../../engine/openclaw/wire/v2026_9_2';
import { buildManagedSessionKey } from './openclawSessionKeys';

const SESSION_KEYS_PER_REQUEST = 200;
const SEARCH_RESULTS_PER_REQUEST = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;
const MAX_GATEWAY_REQUESTS = 128;
const MAX_CONCURRENT_REQUESTS = 4;

type GatewayRequest = (method: string, params: unknown) => Promise<unknown>;

interface SearchBatchResult {
  hits: OpenClawSessionsSearchHitV2026_9_2[];
  indexing: boolean;
  truncated: boolean;
  partial: boolean;
}

interface OpenClawSessionSearchOptions {
  query: string;
  store: Pick<CoworkStore, 'listSessions'>;
  requestGateway: GatewayRequest;
}

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
  };
};

const isBetterHit = (
  candidate: OpenClawSessionsSearchHitV2026_9_2,
  current: OpenClawSessionsSearchHitV2026_9_2,
): boolean =>
  candidate.score > current.score ||
  (candidate.score === current.score && candidate.timestamp > current.timestamp);

export const searchCoworkSessionMessages = async ({
  query,
  store,
  requestGateway,
}: OpenClawSessionSearchOptions) => {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      matches: [],
      indexing: false,
      truncated: false,
      partial: false,
    };
  }
  if (trimmedQuery.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`Search query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }

  const sessions = store.listSessions();
  if (sessions.length === 0) {
    return {
      matches: [],
      indexing: false,
      truncated: false,
      partial: false,
    };
  }

  const localSessionIdByKey = new Map<string, string>();
  const keysByAgent = new Map<string, string[]>();

  for (const session of sessions) {
    const agentId = normalizeOpenClawAgentId(session.agentId ?? 'main');
    const sessionKey = buildManagedSessionKey(session.id, agentId);
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

    const page = parseSessionsSearchResultV2026_9_2(
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
      };
    }

    const midpoint = Math.ceil(sessionKeys.length / 2);
    const children = await Promise.allSettled([
      searchBatch(agentId, sessionKeys.slice(0, midpoint)),
      searchBatch(agentId, sessionKeys.slice(midpoint)),
    ]);
    const combined = combineSettledBatches(children);
    return {
      ...combined,
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
  const bestHitBySessionId = new Map<string, OpenClawSessionsSearchHitV2026_9_2>();

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
  };
};
