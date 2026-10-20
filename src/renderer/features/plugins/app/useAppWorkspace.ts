import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { AppView } from './browserRegistry';
import { appBrowserRegistry } from './runtime';

export const appWorkspaceId = (view: AppView) => `app:${view.pluginId}:${view.id}`;
interface OpenView {
  id: string;
  epoch: string;
  sessionId: string;
  selection?: unknown;
  selectionRevision: number;
}
export function useAppWorkspace(sessionId: string | null, onOpen: (id: string) => void) {
  const registered = useSyncExternalStore(
    appBrowserRegistry.subscribe,
    appBrowserRegistry.getViews,
  );
  const requests = useSyncExternalStore(
    appBrowserRegistry.subscribe,
    appBrowserRegistry.getWorkspaceRequests,
  );
  const hasSummary = useSyncExternalStore(
    appBrowserRegistry.subscribe,
    () =>
      !!sessionId && appBrowserRegistry.sessionPresentation(sessionId).summaryAvailable === true,
  );
  const [opened, setOpened] = useState<OpenView[]>([]);
  const selectionRevision = useRef(0);
  const open = useCallback(
    (view: AppView, selection?: unknown) => {
      if (!sessionId) return;
      const id = appWorkspaceId(view);
      const revision = ++selectionRevision.current;
      setOpened(current => [
        ...current.filter(item => item.id !== id),
        { id, epoch: view.epoch, sessionId, selection, selectionRevision: revision },
      ]);
      onOpen(id);
    },
    [sessionId, onOpen],
  );
  useEffect(() => {
    for (const input of requests) {
      const view = registered.find(
        item =>
          item.pluginId === input?.pluginId &&
          item.id === input.contributionId &&
          item.epoch === input.epoch &&
          item.slot === 'workspace.tab',
      );
      if (view && input.sessionId === sessionId) {
        open(view, input.selection);
        appBrowserRegistry.acknowledgeWorkspaceRequest(input);
      }
    }
  }, [registered, requests, sessionId, open]);
  const views = registered.flatMap(view => {
    const selection = opened.find(
      item =>
        item.id === appWorkspaceId(view) &&
        item.sessionId === sessionId &&
        item.epoch === view.epoch,
    );
    return selection && view.slot === 'workspace.tab'
      ? [
          {
            ...view,
            tabId: selection.id,
            selection: selection.selection,
            selectionRevision: selection.selectionRevision,
          },
        ]
      : [];
  });
  return {
    views,
    hasSummary,
    open,
    close: (id: string) => setOpened(current => current.filter(item => item.id !== id)),
  };
}
