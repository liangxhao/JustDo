import {
  parseProgressCardChangedEvent,
  parseProgressCardGetResult,
  type ProgressCard,
  progressCardIsComplete,
} from '@shared/openclaw/progressCard';

import { normalizeTranscriptSessionKey } from '@/libs/openclaw-chat/model/chat-transcript-state';

import {
  ChatState,
  PROGRESS_CARD_CACHE_LIMIT,
  PROGRESS_CARD_GET_METHOD,
  PROGRESS_CARD_PUT_METHOD,
  PROGRESS_CARD_REFRESH_METHOD,
} from './chat-controller-support';
export interface ChatControllerProgressContext {
  readonly state: ChatState;
  readonly isGatewayMethodAdvertised: (method: string) => boolean;
  progressCardLoadGeneration: number;
  readonly rememberProgressCard: (sessionKey: string, card: ProgressCard | null) => void;
  readonly notify: () => void;
  readonly progressCardCache: Map<string, ProgressCard | null>;
  readonly loadProgressCard: (sessionKey: string, force?: boolean) => Promise<void>;
}

const refreshIntents = new WeakMap<
  ChatControllerProgressContext,
  {
    sessionKey: string;
    revision: number;
    idempotencyKey: string;
  }
>();

/** Retry uncertain delivery with the same intent; terminal failures permit a new run. */
export async function refreshProgressCard(this: ChatControllerProgressContext): Promise<boolean> {
  const { client, sessionKey, progressCard: card } = this.state;
  if (
    !client ||
    !this.state.connected ||
    !card ||
    card.sessionKey !== sessionKey ||
    !this.isGatewayMethodAdvertised(PROGRESS_CARD_REFRESH_METHOD)
  )
    return false;
  const previous = refreshIntents.get(this);
  const retry = previous?.sessionKey === sessionKey && previous.revision === card.revision;
  const intent = retry
    ? previous
    : { sessionKey, revision: card.revision, idempotencyKey: crypto.randomUUID() };
  refreshIntents.set(this, intent);
  const current = () => client === this.state.client && sessionKey === this.state.sessionKey;
  try {
    const response = await client.request<{ status: string; runId: string; revision: number }>(
      PROGRESS_CARD_REFRESH_METHOD,
      { sessionKey, idempotencyKey: intent.idempotencyKey },
    );
    const accepted =
      current() &&
      response.status === 'accepted' &&
      typeof response.runId === 'string' &&
      !!response.runId &&
      Number.isInteger(response.revision) &&
      response.revision > 0;
    if (accepted && retry) {
      // A replayed ACK does not replay a missed changed event. Keep the old card
      // if this read fails, and never let an older read replace a newer revision.
      void client
        .request(PROGRESS_CARD_GET_METHOD, { sessionKey })
        .then(value => {
          const saved = parseProgressCardGetResult(value, sessionKey);
          if (
            !current() ||
            !saved ||
            !this.state.progressCard ||
            saved.revision <= this.state.progressCard.revision
          )
            return;
          this.rememberProgressCard(sessionKey, saved);
          this.state.progressCard = saved;
          this.notify();
        })
        .catch(() => undefined);
    }
    return accepted;
  } catch (error) {
    const details = error && typeof error === 'object' && 'details' in error ? error.details : null;
    if (
      details &&
      typeof details === 'object' &&
      'code' in details &&
      details.code === 'PROGRESS_CARD_REFRESH_TERMINAL' &&
      refreshIntents.get(this) === intent
    ) {
      refreshIntents.delete(this);
    }
    return false;
  }
}

export async function dismissProgressCard(this: ChatControllerProgressContext): Promise<boolean> {
  const card = this.state.progressCard;
  const client = this.state.client;
  if (
    !card ||
    !client ||
    !this.state.connected ||
    !progressCardIsComplete(card) ||
    !this.isGatewayMethodAdvertised(PROGRESS_CARD_PUT_METHOD)
  ) {
    return false;
  }

  const sessionKey = this.state.sessionKey;
  const generation = ++this.progressCardLoadGeneration;
  try {
    const response = await client.request(PROGRESS_CARD_PUT_METHOD, {
      sessionKey,
      expectedRevision: card.revision,
    });
    const nextCard = parseProgressCardGetResult(response, sessionKey);
    if (nextCard === undefined) throw new Error('invalid progress card response');
    if (client !== this.state.client || sessionKey !== this.state.sessionKey) {
      return false;
    }
    // The Gateway broadcasts progressCard.changed before returning from put.
    // A matching clear event therefore invalidates the load generation first;
    // it is still a successful dismissal when the authoritative response and
    // selected state both confirm that the card is gone.
    if (generation !== this.progressCardLoadGeneration) {
      return nextCard === null && this.state.progressCard === null;
    }
    this.rememberProgressCard(sessionKey, nextCard);
    this.state.progressCard = nextCard;
    this.state.progressCardLoading = false;
    this.state.progressCardError = null;
    this.notify();
    return nextCard === null;
  } catch {
    if (
      generation === this.progressCardLoadGeneration &&
      client === this.state.client &&
      sessionKey === this.state.sessionKey
    ) {
      this.state.progressCardError = 'unavailable';
      this.notify();
    }
    return false;
  }
}

export function rememberProgressCard(
  this: ChatControllerProgressContext,
  sessionKey: string,
  card: ProgressCard | null,
): void {
  this.progressCardCache.delete(sessionKey);
  this.progressCardCache.set(sessionKey, card);
  while (this.progressCardCache.size > PROGRESS_CARD_CACHE_LIMIT) {
    const oldestSessionKey = this.progressCardCache.keys().next().value as string | undefined;
    if (!oldestSessionKey) break;
    this.progressCardCache.delete(oldestSessionKey);
  }
}

export async function loadProgressCard(
  this: ChatControllerProgressContext,
  sessionKey: string,
  force = false,
): Promise<void> {
  const client = this.state.client;
  const available =
    !!client && this.state.connected && this.isGatewayMethodAdvertised(PROGRESS_CARD_GET_METHOD);
  if (this.state.sessionKey === sessionKey) {
    this.state.progressCardAvailable = available;
  }
  if (!client || !available) {
    if (this.state.sessionKey === sessionKey) {
      this.state.progressCard = null;
      this.state.progressCardLoading = false;
      this.state.progressCardError = null;
      this.notify();
    }
    return;
  }

  if (!force && this.progressCardCache.has(sessionKey)) {
    if (this.state.sessionKey === sessionKey) {
      const cachedCard = this.progressCardCache.get(sessionKey) ?? null;
      this.rememberProgressCard(sessionKey, cachedCard);
      this.state.progressCard = cachedCard;
      this.state.progressCardLoading = false;
      this.state.progressCardError = null;
      this.notify();
    }
    return;
  }

  const generation = ++this.progressCardLoadGeneration;
  if (this.state.sessionKey === sessionKey) {
    if (force) this.state.progressCard = null;
    this.state.progressCardLoading = true;
    this.state.progressCardError = null;
    this.notify();
  }
  try {
    const response = await client.request(PROGRESS_CARD_GET_METHOD, { sessionKey });
    if (
      generation !== this.progressCardLoadGeneration ||
      client !== this.state.client ||
      sessionKey !== this.state.sessionKey
    ) {
      return;
    }
    const card = parseProgressCardGetResult(response, sessionKey);
    if (card === undefined) throw new Error('invalid progress card response');
    this.rememberProgressCard(sessionKey, card);
    this.state.progressCard = card;
    this.state.progressCardLoading = false;
    this.state.progressCardError = null;
    this.notify();
  } catch (error) {
    if (
      generation !== this.progressCardLoadGeneration ||
      client !== this.state.client ||
      sessionKey !== this.state.sessionKey
    ) {
      return;
    }
    const gatewayCode =
      error && typeof error === 'object' && 'gatewayCode' in error
        ? (error as { gatewayCode?: unknown }).gatewayCode
        : undefined;
    const details =
      error && typeof error === 'object' && 'details' in error
        ? (error as { details?: unknown }).details
        : undefined;
    const detailCode =
      details && typeof details === 'object' && !Array.isArray(details) && 'code' in details
        ? (details as { code?: unknown }).code
        : undefined;
    this.progressCardCache.delete(sessionKey);
    this.state.progressCard = null;
    this.state.progressCardLoading = false;
    this.state.progressCardError =
      gatewayCode === 'SESSION_PARTICIPATION_REQUIRED' ||
      detailCode === 'SESSION_PARTICIPATION_REQUIRED'
        ? 'access-denied'
        : 'unavailable';
    this.notify();
  }
}

export function handleProgressCardChanged(
  this: ChatControllerProgressContext,
  payload: unknown,
): void {
  const changed = parseProgressCardChangedEvent(payload);
  if (!changed) return;

  const targetsSelectedSession =
    normalizeTranscriptSessionKey(changed.sessionKey) ===
    normalizeTranscriptSessionKey(this.state.sessionKey);
  const cached = this.progressCardCache.get(changed.sessionKey);
  if (changed.revision === null) {
    this.rememberProgressCard(changed.sessionKey, null);
    if (targetsSelectedSession) {
      this.progressCardLoadGeneration += 1;
      this.state.progressCard = null;
      this.state.progressCardLoading = false;
      this.state.progressCardError = null;
      this.notify();
    }
    return;
  }
  if (cached?.revision === changed.revision) return;

  this.progressCardCache.delete(changed.sessionKey);
  if (targetsSelectedSession) {
    this.state.progressCard = null;
    void this.loadProgressCard(this.state.sessionKey, true);
  }
}
