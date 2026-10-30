import type { BrowserAgentInteractionState, BrowserPanelTab } from '@shared/browser/browser';

const retainedTabsByDraftKey = new Map<string, BrowserPanelTab[]>();

export const getRetainedBrowserPanelTabs = (draftKey: string): BrowserPanelTab[] | undefined =>
  retainedTabsByDraftKey.get(draftKey);

export const setRetainedBrowserPanelTabs = (draftKey: string, tabs: BrowserPanelTab[]): void => {
  retainedTabsByDraftKey.set(draftKey, tabs);
};

export const promoteBrowserPanelTabs = (fromDraftKey: string, toDraftKey: string): void => {
  if (fromDraftKey === toDraftKey) return;
  const tabs = retainedTabsByDraftKey.get(fromDraftKey);
  if (!tabs) return;
  retainedTabsByDraftKey.set(toDraftKey, tabs);
  retainedTabsByDraftKey.delete(fromDraftKey);
};

export const promotePendingBrowserPanelItems = <T>(
  pendingBySession: Map<string, T[]>,
  fromSessionKey: string,
  toSessionKey: string,
  maxItems: number,
): void => {
  if (fromSessionKey === toSessionKey) return;
  const sourceItems = pendingBySession.get(fromSessionKey);
  if (!sourceItems) return;
  const targetItems = pendingBySession.get(toSessionKey) ?? [];
  pendingBySession.set(toSessionKey, [...targetItems, ...sourceItems].slice(0, maxItems));
  pendingBySession.delete(fromSessionKey);
};

export const isAgentBrowserSessionAvailable = (
  sessionIds: readonly string[],
  sessionId: string,
): boolean =>
  Boolean(sessionId && !sessionId.startsWith('temp-') && sessionIds.includes(sessionId));

export type PendingBrowserAgentPanelState = {
  event: BrowserAgentInteractionState;
  timeoutId: number;
};

export const browserAgentPanelOperationKey = (
  event: BrowserAgentInteractionState,
): string | null => (event.operationId ? `${event.sessionId}\u0000${event.operationId}` : null);

export const takeAvailableBrowserAgentPanelStates = (
  pendingByOperation: Map<string, PendingBrowserAgentPanelState>,
  sessionIds: readonly string[],
): PendingBrowserAgentPanelState[] => {
  const availableSessionIds = new Set(sessionIds);
  const available: PendingBrowserAgentPanelState[] = [];
  for (const [operationKey, pending] of pendingByOperation) {
    if (!availableSessionIds.has(pending.event.ownerSessionId ?? pending.event.sessionId)) continue;
    pendingByOperation.delete(operationKey);
    available.push(pending);
  }
  return available;
};

export const removeRetainedBrowserPanelTabs = (draftKey: string): void => {
  retainedTabsByDraftKey.delete(draftKey);
};
