import {
  filterNativePendingInputsByReceipts,
  type NativePendingInput,
  parseNativePendingInputs,
} from '@shared/openclaw/pendingInputs';

import { projectGatewayHistoryForDisplay } from '../pipeline/history-display-normalizer';
import type { GatewayMessage } from '../types';
import { asRecord, type ChatState, readExplicitMessageRunId } from './chat-controller-support';
import { isTruncatedHistoryMessage } from './chat-history-protocol';

type PendingView = {
  sessionKey: string;
  sessionId: string | null;
  generation: number;
  client: ChatState['client'];
  items: NativePendingInput[];
  failed: boolean;
  suppressedOptimistic?: ChatState['pendingUserMessage'];
};
// Display-only native custody, not transcript entries or execution identities.
// A new history snapshot replaces this view; nothing survives a renderer reload.
const views = new WeakMap<ChatState, PendingView>();
const isScopeCurrent = (state: ChatState, view: PendingView): boolean =>
  views.get(state) === view &&
  state.connected &&
  state.client === view.client &&
  state.sessionKey === view.sessionKey &&
  state.currentSessionId === view.sessionId &&
  state.transcript.historyGeneration === view.generation;

export async function refreshNativePendingInputs(
  state: ChatState,
  response: unknown,
  onChange: () => void,
  onConsumed: () => void,
): Promise<void> {
  const view: PendingView = {
    sessionKey: state.sessionKey,
    sessionId: state.currentSessionId,
    generation: state.transcript.historyGeneration,
    client: state.client,
    items: [],
    failed: false,
  };
  views.set(state, view);
  try {
    let page = parseNativePendingInputs(asRecord(response)?.pendingInputs);
    if (!page || !view.client) {
      return;
    }
    const items = new Map<string, NativePendingInput>();
    let stagedOptimistic: ChatState['pendingUserMessage'] | undefined;
    let previousCursor = Infinity;
    for (;;) {
      if (!isScopeCurrent(state, view)) return;
      for (const input of page.items) items.set(input.id, { ...input });
      if (
        state.pendingUserMessage &&
        [...items.values()].some(input => input.runId && input.runId === state.chatRunId)
      )
        stagedOptimistic = state.pendingUserMessage;
      if (page.nextBefore === undefined) break;
      if (page.nextBefore >= previousCursor)
        throw new Error('Pending input cursor did not advance');
      previousCursor = page.nextBefore;
      const next = await view.client.request('chat.history', {
        sessionKey: view.sessionKey,
        ...(view.sessionId ? { sessionId: view.sessionId } : {}),
        limit: 20,
        maxChars: 500_000,
        pendingBefore: previousCursor,
      });
      if (!isScopeCurrent(state, view)) return;
      page = parseNativePendingInputs(asRecord(next)?.pendingInputs);
      if (!page) throw new Error('Pending input page missing');
    }
    let recovered = [...items.values()];
    const retiredIds = new Set<string>();
    for (const input of recovered) {
      if (!isScopeCurrent(state, view)) return;
      if (!isTruncatedHistoryMessage(input.message)) continue;
      const id = asRecord(input.message.__openclaw)?.id;
      if (typeof id !== 'string') continue;
      // Pending IDs are native display identities, not raw transcript offsets.
      // Never fall back to the transcript-only chunk/file bridge.
      try {
        const result = asRecord(
          await view.client.request('chat.message.get', {
            sessionKey: view.sessionKey,
            messageId: id,
            maxChars: 2_000_000,
          }),
        );
        if (!isScopeCurrent(state, view)) return;
        if (
          result?.ok === false &&
          (result.unavailableReason === 'not_found' || result.unavailableReason === 'not_visible')
        ) {
          retiredIds.add(input.id);
          if (input.runId && input.runId === state.chatRunId && state.pendingUserMessage)
            view.suppressedOptimistic = state.pendingUserMessage;
          if (result.unavailableReason === 'not_found') onConsumed();
          continue;
        }
        const full = result?.ok === true ? asRecord(result.message) : null;
        if (full) input.message = { ...full, __openclaw: { ...asRecord(full.__openclaw), id } };
      } catch {
        // A transport/size failure does not establish withdrawal. Keep the
        // native truncated placeholder, but never override an explicit miss.
      }
    }
    recovered = recovered.filter(input => !retiredIds.has(input.id));
    // Custody may be consumed or withdrawn while older pages are in flight.
    // Query native receipts, rather than guessing from text or timestamps.
    const runIds = [
      ...new Set([
        ...recovered.flatMap(item => (item.runId ? [item.runId] : [])),
        ...(state.pendingUserMessage && state.chatRunId && state.chatRunId.length <= 256
          ? [state.chatRunId]
          : []),
      ]),
    ];
    for (let offset = 0; offset < runIds.length; offset += 50) {
      if (!isScopeCurrent(state, view)) return;
      const batch = runIds.slice(offset, offset + 50);
      const latest = asRecord(
        await view.client.request('chat.history', {
          sessionKey: view.sessionKey,
          ...(view.sessionId ? { sessionId: view.sessionId } : {}),
          limit: 1,
          maxChars: 500_000,
          inputRunIds: batch,
        }),
      );
      if (!isScopeCurrent(state, view)) return;
      const beforeReceipts = recovered;
      recovered = filterNativePendingInputsByReceipts(recovered, latest?.inputReceipts, batch);
      const retiredVisibleInput = beforeReceipts.some(
        input =>
          input.message.display !== false && !recovered.some(current => current.id === input.id),
      );
      if (
        state.pendingUserMessage &&
        Array.isArray(latest?.inputReceipts) &&
        latest.inputReceipts.some(receipt => {
          const record = asRecord(receipt);
          return (
            record?.runId === state.chatRunId &&
            (record?.state === 'consumed' || record?.cancelled === true)
          );
        })
      )
        view.suppressedOptimistic = state.pendingUserMessage;
      const consumed =
        Array.isArray(latest?.inputReceipts) &&
        latest.inputReceipts.some(receipt => {
          const record = asRecord(receipt);
          return (
            (record?.state === 'consumed' &&
              !state.chatMessages.some(
                message => asRecord(asRecord(message)?.__openclaw)?.id === record.consumedByEventId,
              )) ||
            (record?.cancelled === true &&
              [...items.values()].some(
                input => input.runId === record.runId && input.state !== 'cancelled',
              ))
          );
        });
      // Native consumption may remove custody without retaining a consumed
      // receipt. Exact queried absence still needs a canonical history refresh.
      if (consumed || retiredVisibleInput) onConsumed();
    }
    if (!isScopeCurrent(state, view)) return;
    view.items = recovered;
    view.suppressedOptimistic ??= stagedOptimistic;
    onChange();
  } catch {
    if (isScopeCurrent(state, view)) {
      view.failed = true;
      onChange();
    }
  }
}

export function nativePendingInputReadFailed(state: ChatState): boolean {
  const view = views.get(state);
  return !!view && isScopeCurrent(state, view) && view.failed;
}

export function nativePendingInputState(message: unknown): NativePendingInput['state'] | undefined {
  const value = asRecord(message)?.justdoPendingInputState;
  return value === 'queued' || value === 'interrupted' || value === 'cancelled' ? value : undefined;
}

export function projectNativePendingInputs(
  state: ChatState,
  visibleHistory: GatewayMessage[],
  loadedHistory: GatewayMessage[],
): { messages: GatewayMessage[]; suppressOptimistic: boolean } {
  const view = views.get(state);
  if (!view || !isScopeCurrent(state, view))
    return { messages: visibleHistory, suppressOptimistic: false };
  const persistedRunIds = new Set(
    loadedHistory
      .filter(message => message.role === 'user')
      .flatMap(message => {
        const id = readExplicitMessageRunId(message) ?? asRecord(message)?.idempotencyKey;
        return typeof id === 'string' ? [id] : [];
      }),
  );
  const persistedInputKeys = new Set(
    loadedHistory
      .filter(message => message.role === 'user')
      .flatMap(message => {
        const metadata = asRecord(message.__openclaw);
        return [asRecord(message)?.idempotencyKey, metadata?.idempotencyKey].filter(
          (key): key is string => typeof key === 'string',
        );
      }),
  );
  let suppressOptimistic =
    !!state.pendingUserMessage && view.suppressedOptimistic === state.pendingUserMessage;
  const messages = [...visibleHistory];
  for (const input of [...view.items].sort((a, b) => a.acceptedAt - b.acceptedAt)) {
    if (state.pendingUserMessage && input.runId && input.runId === state.chatRunId) {
      suppressOptimistic = true;
    }
    if (
      input.message.display === false ||
      (input.runId &&
        (persistedRunIds.has(input.runId) || persistedInputKeys.has(`${input.runId}:user`)))
    )
      continue;
    const projected = asRecord(projectGatewayHistoryForDisplay([input.message])[0]);
    if (!projected) continue;
    const message = {
      ...projected,
      role: 'user',
      timestamp: input.acceptedAt,
      justdoPendingInputState: input.state,
    } as GatewayMessage;
    const index = messages.findIndex(existing => {
      const timestamp =
        typeof existing.timestamp === 'number'
          ? existing.timestamp
          : Date.parse(String(existing.timestamp));
      return Number.isFinite(timestamp) && timestamp > input.acceptedAt;
    });
    messages.splice(index < 0 ? messages.length : index, 0, message);
  }
  return { messages: view.items.length ? messages : visibleHistory, suppressOptimistic };
}
