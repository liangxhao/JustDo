import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import { parseChatHistoryResultV2026_10_6 } from '../../engine/openclaw/wire/v2026_10_6';

export type SessionBranchGatewayRequest = <T>(method: string, params?: unknown) => Promise<T>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_BRANCH_TIMING_PAGES = 40;

function messageRunId(message: Record<string, unknown>): string | undefined {
  const metadata = record(message.metadata) ? message.metadata : undefined;
  const marker = record(message.__openclaw) ? message.__openclaw : undefined;
  for (const value of [
    message.runId,
    message.run_id,
    metadata?.runId,
    metadata?.run_id,
    marker?.runId,
    marker?.run_id,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
}

export function hasSessionBranchCreationResponse(error: unknown): boolean {
  return record(error) && (typeof error.gatewayCode === 'string' || error.requestSent === false);
}

/** Request-local identity projection only; bodies never become a Main transcript cache. */
export async function readSessionBranchRunIds(
  requestGateway: SessionBranchGatewayRequest,
  sessionKey: string,
  sessionId: string,
  entryId?: string,
): Promise<ReadonlySet<string>> {
  const unavailable = new Set<string>();
  try {
    let offset = 0;
    let total: number | undefined;
    let cursor: string | undefined;
    let foundCut = entryId === undefined;
    const ids = new Set<string>();
    let pagesRead = 0;
    while (true) {
      if (++pagesRead > MAX_BRANCH_TIMING_PAGES) return unavailable;
      // Native pagination forbids sessionId without messageId. Fence every
      // response and the final cursor against the expected physical identity.
      const raw = await requestGateway<unknown>('chat.history', {
        sessionKey,
        limit: 250,
        maxChars: 1,
        maxBytes: 262144,
        ...(offset ? { offset } : {}),
      });
      if (!record(raw) || raw.sessionId !== sessionId) return unavailable;
      const page = parseChatHistoryResultV2026_10_6(raw);
      if (!page.deltaCursor || page.totalMessages === undefined) return unavailable;
      if (total !== undefined && page.totalMessages !== total) return unavailable;
      total = page.totalMessages;
      cursor ??= page.deltaCursor;
      for (const message of page.messages) {
        if (!record(message)) continue;
        const marker = record(message.__openclaw) ? message.__openclaw : undefined;
        const runId = messageRunId(message);
        if (runId) ids.add(runId);
        if (message.role === 'assistant' && marker?.id === entryId && runId) foundCut = true;
      }
      if (!page.hasMore) break;
      if (page.nextOffset === undefined || page.nextOffset <= offset || page.nextOffset >= total)
        return unavailable;
      offset = page.nextOffset;
    }
    if (!foundCut || !cursor) return unavailable;
    const current = await requestGateway<unknown>('chat.history', {
      sessionKey,
      cursor,
      limit: 1,
      maxChars: 1,
      maxBytes: 4096,
    });
    if (
      !record(current) ||
      current.kind !== 'delta' ||
      typeof current.deltaCursor !== 'string' ||
      !current.deltaCursor ||
      !record(current.sessionInfo) ||
      current.sessionInfo.sessionId !== sessionId ||
      current.sessionInfo.hasActiveRun === true ||
      !Array.isArray(current.messages) ||
      current.messages.length ||
      (current.activity !== undefined &&
        (!Array.isArray(current.activity) || current.activity.length))
    )
      return unavailable;
    return ids;
  } catch {
    // Optional timing failure must not destroy an otherwise valid native copy.
  }
  return unavailable;
}

/** A lost creation response or failed preparation keeps a visible record with the same key. */
export async function recoverFailedSessionBranch(options: {
  requestGateway: SessionBranchGatewayRequest;
  store: Pick<CoworkStore, 'deleteSession' | 'updateSession'>;
  router: Pick<CoworkEngineRouter, 'onSessionDeleted'>;
  session: CoworkSession;
  sessionKey: string;
  creationResponseReceived: boolean;
  creationRequestIssued?: boolean;
}): Promise<CoworkSession | undefined> {
  const { requestGateway, store, router, session, sessionKey } = options;
  if (options.creationRequestIssued === false) {
    try {
      store.deleteSession(session.id);
      return;
    } catch {
      // Keep the identity visible if local cleanup itself fails.
    }
  }
  // A read of absence cannot fence a creation whose response was lost: that
  // original request may still commit after this read. Keep its product row.
  if (options.creationResponseReceived) {
    try {
      const described = await requestGateway<{ session?: unknown }>('sessions.describe', {
        key: sessionKey,
      });
      if (described.session === null) {
        store.deleteSession(session.id);
        try {
          router.onSessionDeleted(session.id, session.agentId, [sessionKey], [session.cwd]);
        } catch {
          // The confirmed-absent target and local row have already been removed.
        }
        return;
      }
    } catch {
      // Preserve the original failure and the recovery entry when reads fail too.
    }
  }
  try {
    store.updateSession(session.id, { status: 'error' });
  } catch {
    // The existing row still preserves the target identity if this update fails.
  }
  return { ...session, status: 'error', branchCreationPending: true };
}
