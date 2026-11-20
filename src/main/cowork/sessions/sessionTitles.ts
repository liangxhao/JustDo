import {
  normalizeSessionDisplayName,
  SESSION_DISPLAY_NAME_METHOD,
  type SessionDisplayNameRequest,
} from '../../../../plugins/extensions/runtime-services/contracts/session-display-name';
import type {
  GenerateSessionTitleRequest,
  SessionTitleTarget,
} from '../../../shared/cowork/sessionTitle';
import { isGatewayRequestOutcomeUnknown } from '../../../shared/openclaw/gatewayRequestOutcome';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';

export type SessionTitleGateway = {
  request: GatewayClientLike['request'];
  isCurrent: () => boolean;
};

type NativeTitleRow = {
  key?: unknown;
  sessionId?: unknown;
  lifecycleRevision?: unknown;
};

interface SessionTitleDependencies {
  getStore: () => Pick<CoworkStore, 'getSession' | 'updateSession'>;
  getGateway: () => SessionTitleGateway | null;
  generateTitle: (userInput: string, sessionId: string) => Promise<string>;
  onChanged: () => void;
}

const TITLE_REQUEST_TIMEOUT_MS = 5_000;

function managedKey(session: CoworkSession): string | undefined {
  if (session.external || session.nativeParentSessionId) return;
  const key = buildManagedSessionKey(session.id, session.agentId);
  if (
    (session.nativeSessionKey && session.nativeSessionKey !== key) ||
    (session.historyBinding && session.historyBinding.sessionKey !== key)
  )
    return;
  return key;
}

function sameProductSession(
  initial: CoworkSession,
  current: CoworkSession | null,
): current is CoworkSession {
  return (
    current !== null &&
    initial.createdAt === current.createdAt &&
    initial.agentId === current.agentId &&
    initial.nativeSessionKey === current.nativeSessionKey &&
    initial.nativeParentSessionId === current.nativeParentSessionId &&
    initial.historyBinding?.sessionKey === current.historyBinding?.sessionKey &&
    initial.historyBinding?.nativeSessionId === current.historyBinding?.nativeSessionId &&
    initial.external?.sessionKey === current.external?.sessionKey &&
    initial.external?.origin === current.external?.origin
  );
}

async function readNativeTarget(
  gateway: SessionTitleGateway,
  session: CoworkSession,
  key: string,
): Promise<SessionTitleTarget> {
  const { session: entry } = await gateway.request<{ session: NativeTitleRow | null }>(
    'sessions.describe',
    { key },
    { timeoutMs: TITLE_REQUEST_TIMEOUT_MS },
  );
  if (!gateway.isCurrent()) throw new Error('Gateway connection changed.');
  if (
    entry?.key !== key ||
    typeof entry.sessionId !== 'string' ||
    !entry.sessionId.trim() ||
    (entry.lifecycleRevision != null &&
      (typeof entry.lifecycleRevision !== 'string' || !entry.lifecycleRevision.trim())) ||
    (session.historyBinding && entry.sessionId !== session.historyBinding.nativeSessionId)
  ) {
    throw new Error('Native session identity could not be confirmed.');
  }
  return {
    sessionKey: key,
    nativeSessionId: entry.sessionId,
    lifecycleRevision: typeof entry.lifecycleRevision === 'string' ? entry.lifecycleRevision : null,
  };
}

export function createSessionTitleOperations(deps: SessionTitleDependencies) {
  const writes = new Map<string, Promise<unknown>>();
  const generations = new Map<string, symbol>();

  function enqueue<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const pending = (writes.get(sessionId) ?? Promise.resolve()).then(action, action);
    writes.set(sessionId, pending);
    return pending.finally(() => {
      if (writes.get(sessionId) === pending) writes.delete(sessionId);
    });
  }

  function current(initial: CoworkSession, expectedTitle?: string): CoworkSession | undefined {
    const row = deps.getStore().getSession(initial.id);
    if (
      sameProductSession(initial, row) &&
      (expectedTitle === undefined || row.title === expectedTitle)
    )
      return row;
  }

  async function save(
    session: CoworkSession,
    displayName: string,
    native: { gateway: SessionTitleGateway; target: SessionTitleTarget } | null,
    expectedTitle?: string,
  ): Promise<string | null> {
    if (!current(session, expectedTitle)) return null;
    if (native) {
      const { gateway, target } = native;
      if (!gateway.isCurrent()) throw new Error('Gateway connection changed.');
      const params: SessionDisplayNameRequest = {
        ...target,
        displayName,
        ...(expectedTitle === undefined ? {} : { expectedDisplayName: expectedTitle }),
      };
      const receipt = await gateway
        .request<SessionTitleTarget & { displayName: string }>(
          SESSION_DISPLAY_NAME_METHOD,
          params,
          {
            timeoutMs: TITLE_REQUEST_TIMEOUT_MS,
          },
        )
        .catch(error => {
          if (!isGatewayRequestOutcomeUnknown(error) || !gateway.isCurrent()) throw error;
          return gateway.request<SessionTitleTarget & { displayName: string }>(
            SESSION_DISPLAY_NAME_METHOD,
            { ...target, displayName, confirmOnly: true },
            { timeoutMs: TITLE_REQUEST_TIMEOUT_MS },
          );
        });
      if (
        !gateway.isCurrent() ||
        receipt?.sessionKey !== target.sessionKey ||
        receipt.nativeSessionId !== target.nativeSessionId ||
        receipt.lifecycleRevision !== target.lifecycleRevision ||
        receipt.displayName !== displayName
      )
        throw new Error('Native session title could not be confirmed.');
    }
    const row = current(session, expectedTitle);
    if (!row) return null;
    if (row.title !== displayName) {
      deps.getStore().updateSession(session.id, { title: displayName });
      deps.onChanged();
    }
    return displayName;
  }

  return {
    async generate({
      sessionId,
      expectedTitle,
      userInput,
      nativeTarget,
    }: GenerateSessionTitleRequest): Promise<string | null> {
      const session = deps.getStore().getSession(sessionId);
      if (!session || session.title !== expectedTitle || !userInput.trim() || writes.has(sessionId))
        return null;
      const key = managedKey(session);
      const gateway = deps.getGateway();
      if (!key || key !== nativeTarget.sessionKey || !gateway) return null;
      const token = Symbol();
      generations.set(sessionId, token);
      try {
        const target = await readNativeTarget(gateway, session, key);
        if (
          target.nativeSessionId !== nativeTarget.nativeSessionId ||
          target.lifecycleRevision !== nativeTarget.lifecycleRevision ||
          generations.get(sessionId) !== token
        )
          return null;
        const displayName = normalizeSessionDisplayName(
          await deps.generateTitle(userInput, sessionId),
        );
        if (!displayName) return null;
        return await enqueue(sessionId, () =>
          generations.get(sessionId) === token
            ? save(session, displayName, { gateway, target }, expectedTitle)
            : Promise.resolve(null),
        );
      } finally {
        if (generations.get(sessionId) === token) generations.delete(sessionId);
      }
    },

    async rename(sessionId: string, displayName: string): Promise<string | null> {
      const session = deps.getStore().getSession(sessionId);
      if (!session) return null;
      generations.delete(sessionId);
      const key = managedKey(session);
      if (!key) return enqueue(sessionId, () => save(session, displayName, null));
      const gateway = deps.getGateway();
      if (!gateway || !gateway.isCurrent()) throw new Error('Gateway is unavailable.');
      // Observe the intended incarnation before waiting for another title write.
      const prepared = readNativeTarget(gateway, session, key).then(
        target => ({ target }),
        error => ({ error }),
      );
      return enqueue(sessionId, async () => {
        const result = await prepared;
        if ('error' in result) throw result.error;
        const { target } = result;
        return save(session, displayName, { gateway, target });
      });
    },
  };
}
