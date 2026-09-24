import type { BrowserPanelTab } from '@shared/browser/browser';
import {
  BROWSER_AGENT_INTERACTION_ACK_TIMEOUT_MS,
  BROWSER_AGENT_PANEL_TARGET_ID,
  type BrowserAgentInteractionState,
} from '@shared/browser/browser';
import { useCallback, useEffect } from 'react';

import { type BrowserPanelHandle, createBrowserPanelTab } from '@/features/browser/BrowserPanel';
import {
  browserAgentPanelOperationKey,
  isAgentBrowserSessionAvailable,
  type PendingBrowserAgentPanelState,
  takeAvailableBrowserAgentPanelStates,
} from '@/features/browser/browserPanelRetention';
import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';

import { browserDisplayTabId, MAX_BROWSER_TABS } from './displayTabIds';
import type { SessionDisplayState, SessionDisplayStateMap } from './useSessionDisplayState';

interface CoworkBrowserPanelsOptions {
  pendingBrowserTabsRef: React.MutableRefObject<
    Map<
      string,
      {
        url?: string;
        sourceFilePath?: string;
        sourcePreviewUrl?: string;
        sourceRootPath?: string;
        sourcePreviewRootUrl?: string;
      }[]
    >
  >;
  displaySessionKey: string;
  currentSessionId: string | null;
  browserTabs: BrowserPanelTab[];
  setIsWorkspaceFilesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsDisplayPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setHasBrowserPanelOpened: React.Dispatch<React.SetStateAction<boolean>>;
  setIsBrowserPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setBrowserTabCreationSequence: React.Dispatch<React.SetStateAction<number>>;
  browserTabCreationSequence: number;
  browserPanelRefs: React.MutableRefObject<Map<string, BrowserPanelHandle>>;
  displayStates: SessionDisplayStateMap;
  setBrowserAgentPanelStates: React.Dispatch<
    React.SetStateAction<Map<string, Map<string, BrowserAgentInteractionState>>>
  >;
  setSessionField: <K extends keyof SessionDisplayState>(
    targetSessionKey: string,
    field: K,
    value: React.SetStateAction<SessionDisplayState[K]>,
  ) => void;
  pendingBrowserAgentPanelStatesRef: React.MutableRefObject<
    Map<string, PendingBrowserAgentPanelState>
  >;
  sessions: CoworkSessionSummary[];
  availableAgentBrowserSessionIdsRef: React.MutableRefObject<string[]>;
  handleBrowserTargetChange: (targetId: string | null) => void;
  openBrowserTab: (targetSessionKey: string, tab: BrowserPanelTab, maximumTabs: number) => void;
}

export function useCoworkBrowserPanels({
  pendingBrowserTabsRef,
  displaySessionKey,
  currentSessionId,
  browserTabs,
  setIsWorkspaceFilesOpen,
  setIsDisplayPanelOpen,
  setHasBrowserPanelOpened,
  setIsBrowserPanelOpen,
  setBrowserTabCreationSequence,
  browserTabCreationSequence,
  browserPanelRefs,
  displayStates,
  setBrowserAgentPanelStates,
  setSessionField,
  pendingBrowserAgentPanelStatesRef,
  sessions,
  availableAgentBrowserSessionIdsRef,
  handleBrowserTargetChange,
  openBrowserTab,
}: CoworkBrowserPanelsOptions) {
  const handleCreateBrowserTab = useCallback(() => {
    const pendingTabs = pendingBrowserTabsRef.current.get(displaySessionKey) ?? [];
    if (
      currentSessionId?.startsWith('temp-') ||
      browserTabs.length + pendingTabs.length >= MAX_BROWSER_TABS
    )
      return;
    pendingTabs.push({});
    pendingBrowserTabsRef.current.set(displaySessionKey, pendingTabs);
    setIsWorkspaceFilesOpen(false);
    setIsDisplayPanelOpen(true);
    setHasBrowserPanelOpened(true);
    setIsBrowserPanelOpen(true);
    setBrowserTabCreationSequence(sequence => sequence + 1);
  }, [
    browserTabs.length,
    currentSessionId,
    displaySessionKey,
    pendingBrowserTabsRef,
    setBrowserTabCreationSequence,
    setHasBrowserPanelOpened,
    setIsBrowserPanelOpen,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
  ]);

  useEffect(() => {
    if (browserTabCreationSequence === 0 && pendingBrowserTabsRef.current.size === 0) return;
    for (const [sessionKey, pendingTabs] of pendingBrowserTabsRef.current) {
      const panel = browserPanelRefs.current.get(sessionKey);
      if (!panel) continue;
      pendingBrowserTabsRef.current.delete(sessionKey);
      pendingTabs.forEach(pendingTab => {
        panel.openTab(pendingTab.url, {
          sourceFilePath: pendingTab.sourceFilePath,
          sourcePreviewUrl: pendingTab.sourcePreviewUrl,
          sourceRootPath: pendingTab.sourceRootPath,
          sourcePreviewRootUrl: pendingTab.sourcePreviewRootUrl,
        });
      });
    }
  }, [browserPanelRefs, browserTabCreationSequence, displayStates, pendingBrowserTabsRef]);

  const applyBrowserAgentPanelState = useCallback(
    (event: BrowserAgentInteractionState) => {
      setBrowserAgentPanelStates(current => {
        const next = new Map(current);
        const sessionStates = new Map(next.get(event.sessionId) ?? []);
        if (event.busy) sessionStates.set(event.operationId!, event);
        else sessionStates.delete(event.operationId!);
        if (sessionStates.size) next.set(event.sessionId, sessionStates);
        else next.delete(event.sessionId);
        return next;
      });
      if (event.busy) {
        setSessionField(event.sessionId, 'hasBrowserPanelOpened', true);
      }
    },
    [setBrowserAgentPanelStates, setSessionField],
  );

  useEffect(() => {
    const available = takeAvailableBrowserAgentPanelStates(
      pendingBrowserAgentPanelStatesRef.current,
      sessions.map(session => session.id),
    );
    for (const pending of available) {
      window.clearTimeout(pending.timeoutId);
      applyBrowserAgentPanelState(pending.event);
    }
  }, [applyBrowserAgentPanelState, pendingBrowserAgentPanelStatesRef, sessions]);

  useEffect(
    () => () => {
      for (const pending of pendingBrowserAgentPanelStatesRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingBrowserAgentPanelStatesRef.current.clear();
    },
    [pendingBrowserAgentPanelStatesRef],
  );

  useEffect(() => {
    const removeInteractionListener = window.electron.browser.onAgentInteractionState(event => {
      if (
        event.targetId !== BROWSER_AGENT_PANEL_TARGET_ID ||
        !event.operationId ||
        !event.sessionId ||
        event.sessionId.startsWith('temp-')
      ) {
        return;
      }
      const operationKey = browserAgentPanelOperationKey(event)!;
      const existingPending = pendingBrowserAgentPanelStatesRef.current.get(operationKey);
      if (existingPending) {
        window.clearTimeout(existingPending.timeoutId);
        pendingBrowserAgentPanelStatesRef.current.delete(operationKey);
      }
      if (
        !isAgentBrowserSessionAvailable(availableAgentBrowserSessionIdsRef.current, event.sessionId)
      ) {
        if (event.busy) {
          const timeoutId = window.setTimeout(() => {
            pendingBrowserAgentPanelStatesRef.current.delete(operationKey);
          }, BROWSER_AGENT_INTERACTION_ACK_TIMEOUT_MS);
          pendingBrowserAgentPanelStatesRef.current.set(operationKey, { event, timeoutId });
        }
        return;
      }
      applyBrowserAgentPanelState(event);
    });
    const removeEnsureListener = window.electron.browser.onAgentEnsureTab(event => {
      if (
        !isAgentBrowserSessionAvailable(availableAgentBrowserSessionIdsRef.current, event.sessionId)
      ) {
        return;
      }
      const tab = createBrowserPanelTab(event.url, {
        targetId: event.targetId,
        customTitle: event.label,
        profile: event.profile,
      });
      setSessionField(event.sessionId, 'browserTabs', current => {
        const existingTab = event.targetId
          ? current.find(candidate => candidate.targetId === event.targetId)
          : current[0];
        return existingTab ? current : [...current, tab];
      });
      setSessionField(event.sessionId, 'browserPanelTargetId', tab.targetId);
      setSessionField(event.sessionId, 'preferredDisplayTabId', browserDisplayTabId(tab.targetId));
      setSessionField(event.sessionId, 'hasBrowserPanelOpened', true);
      setSessionField(event.sessionId, 'isBrowserPanelOpen', true);
      if (event.sessionId === displaySessionKey) {
        setIsWorkspaceFilesOpen(false);
        setIsDisplayPanelOpen(true);
      }
    });
    const removeFocusListener = window.electron.browser.onAgentFocusTab(event => {
      if (event.sessionId !== displaySessionKey) {
        setSessionField(event.sessionId, 'browserPanelTargetId', event.targetId);
        setSessionField(
          event.sessionId,
          'preferredDisplayTabId',
          browserDisplayTabId(event.targetId),
        );
        setSessionField(event.sessionId, 'hasBrowserPanelOpened', true);
        setSessionField(event.sessionId, 'isBrowserPanelOpen', true);
        return;
      }
      setIsWorkspaceFilesOpen(false);
      setIsDisplayPanelOpen(true);
      setHasBrowserPanelOpened(true);
      setIsBrowserPanelOpen(true);
      handleBrowserTargetChange(event.targetId);
    });
    const removeCloseListener = window.electron.browser.onAgentCloseTab(event => {
      const panel = browserPanelRefs.current.get(event.sessionId);
      if (panel) {
        panel.closeTab(event.targetId);
        return;
      }
      setSessionField(event.sessionId, 'browserTabs', current =>
        current.filter(tab => tab.targetId !== event.targetId),
      );
      setSessionField(event.sessionId, 'browserPanelTargetId', current =>
        current === event.targetId ? null : current,
      );
      setSessionField(event.sessionId, 'preferredDisplayTabId', current =>
        current === browserDisplayTabId(event.targetId) ? null : current,
      );
    });
    return () => {
      removeInteractionListener();
      removeEnsureListener();
      removeFocusListener();
      removeCloseListener();
    };
  }, [
    applyBrowserAgentPanelState,
    availableAgentBrowserSessionIdsRef,
    browserPanelRefs,
    displaySessionKey,
    handleBrowserTargetChange,
    pendingBrowserAgentPanelStatesRef,
    setHasBrowserPanelOpened,
    setIsBrowserPanelOpen,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setSessionField,
  ]);

  useEffect(() => {
    const handleOpenLocalHtml = async (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string; workingDirectory?: string }>)
        .detail;
      if (!detail?.filePath) return;
      try {
        const result = await window.electron.browser.createLocalHtmlPreview(
          detail.filePath,
          detail.workingDirectory,
        );
        if (!result.success) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail:
                result.errorCode === 'not_found'
                  ? i18nService.t('coworkAttachmentNotFound').replace('{filepath}', detail.filePath)
                  : result.errorCode === 'invalid_type' || result.errorCode === 'invalid_source'
                    ? i18nService.t('coworkLocalHtmlPreviewInvalid')
                    : i18nService.t('coworkFilePreviewFailed'),
            }),
          );
          return;
        }
        const tab = createBrowserPanelTab(result.url, {
          sourceFilePath: result.filePath,
          sourcePreviewUrl: result.url,
          sourceRootPath: result.rootPath,
          sourcePreviewRootUrl: result.previewRootUrl,
        });
        openBrowserTab(displaySessionKey, tab, MAX_BROWSER_TABS);
      } catch {
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('coworkFilePreviewFailed') }),
        );
      }
    };
    window.addEventListener('cowork:open-local-html', handleOpenLocalHtml);
    return () => window.removeEventListener('cowork:open-local-html', handleOpenLocalHtml);
  }, [displaySessionKey, openBrowserTab]);
  return { handleCreateBrowserTab };
}
