import type { BrowserPanelTab } from '@shared/browser/browser';
import {
  BROWSER_AGENT_INTERACTION_ACK_TIMEOUT_MS,
  BROWSER_AGENT_PANEL_TARGET_ID,
  type BrowserAgentInteractionState,
} from '@shared/browser/browser';
import {
  BrowserLinkTarget,
  isWebBrowserLink,
  normalizeBrowserLinkTarget,
} from '@shared/browser/browserLinkOpening';
import { useCallback, useEffect, useRef } from 'react';

import { type BrowserPanelHandle, createBrowserPanelTab } from '@/features/browser/BrowserPanel';
import {
  browserAgentPanelOperationKey,
  isAgentBrowserSessionAvailable,
  type PendingBrowserAgentPanelState,
  takeAvailableBrowserAgentPanelStates,
} from '@/features/browser/browserPanelRetention';
import { MessageBrowserEvent } from '@/features/browser/messageBrowserLinks';
import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { configService } from '@/services/config';
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
  isDisplayPanelOpen: boolean;
  hasDisplayTabs: boolean;
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
  isDisplayPanelOpen,
  hasDisplayTabs,
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
  const initializingTabSessionRef = useRef<string | null>(null);
  const previousDisplayTabsRef = useRef({ displaySessionKey, hasDisplayTabs });
  const handleCreateBrowserTab = useCallback(
    (url?: string) => {
      setIsDisplayPanelOpen(true);
      const pendingTabs = pendingBrowserTabsRef.current.get(displaySessionKey) ?? [];
      if (
        currentSessionId?.startsWith('temp-') ||
        browserTabs.length + pendingTabs.length >= MAX_BROWSER_TABS
      )
        return;
      pendingTabs.push(url ? { url } : {});
      pendingBrowserTabsRef.current.set(displaySessionKey, pendingTabs);
      setIsWorkspaceFilesOpen(false);
      setHasBrowserPanelOpened(true);
      setIsBrowserPanelOpen(true);
      setBrowserTabCreationSequence(sequence => sequence + 1);
    },
    [
      browserTabs.length,
      currentSessionId,
      displaySessionKey,
      pendingBrowserTabsRef,
      setBrowserTabCreationSequence,
      setHasBrowserPanelOpened,
      setIsBrowserPanelOpen,
      setIsDisplayPanelOpen,
      setIsWorkspaceFilesOpen,
    ],
  );

  useEffect(() => {
    const previous = previousDisplayTabsRef.current;
    previousDisplayTabsRef.current = { displaySessionKey, hasDisplayTabs };
    if (
      previous.displaySessionKey === displaySessionKey &&
      previous.hasDisplayTabs &&
      !hasDisplayTabs
    ) {
      initializingTabSessionRef.current = null;
      setIsDisplayPanelOpen(false);
      return;
    }
    if (!isDisplayPanelOpen || hasDisplayTabs) {
      initializingTabSessionRef.current = null;
      return;
    }
    if (
      initializingTabSessionRef.current === displaySessionKey ||
      (pendingBrowserTabsRef.current.get(displaySessionKey)?.length ?? 0) > 0
    )
      return;
    if (browserTabs.length > 0) {
      setIsBrowserPanelOpen(true);
      setHasBrowserPanelOpened(true);
      handleBrowserTargetChange(browserTabs[0].targetId);
      return;
    }
    handleCreateBrowserTab();
    // Keep the creation in flight after the queue drains, until its tab is published.
    // StrictMode may replay this effect before the parent observes the browser tab.
    if ((pendingBrowserTabsRef.current.get(displaySessionKey)?.length ?? 0) > 0) {
      initializingTabSessionRef.current = displaySessionKey;
    }
  }, [
    browserTabs,
    displaySessionKey,
    handleBrowserTargetChange,
    handleCreateBrowserTab,
    hasDisplayTabs,
    isDisplayPanelOpen,
    pendingBrowserTabsRef,
    setHasBrowserPanelOpened,
    setIsBrowserPanelOpen,
    setIsDisplayPanelOpen,
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
      // initialTabs only seeds an empty panel. An already mounted panel owns
      // its live tabs and must create the requested guest through its handle.
      const created = browserPanelRefs.current.get(event.sessionId)?.openTab(tab.url, {
        targetId: tab.targetId,
        customTitle: event.label,
        profile: event.profile,
      });
      // A mounted panel may reject creation at its capacity limit. Keep the
      // current selection and parent state aligned with its actual guests.
      if (created === false) return;
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
    const openMessageBrowserTab = (tab: BrowserPanelTab) => {
      // A mounted panel owns its live tabs; changing initialTabs only seeds an
      // empty panel. Use the same identity in both the guest and parent state.
      const created = browserPanelRefs.current.get(displaySessionKey)?.openTab(tab.url, {
        targetId: tab.targetId,
        sourceFilePath: tab.sourceFilePath,
        sourcePreviewUrl: tab.sourcePreviewUrl,
        sourceRootPath: tab.sourceRootPath,
        sourcePreviewRootUrl: tab.sourcePreviewRootUrl,
      });
      if (created === false) return;
      openBrowserTab(displaySessionKey, tab, MAX_BROWSER_TABS);
    };
    const handleOpenWebUrl = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: unknown }>).detail;
      if (!isWebBrowserLink(detail?.url)) return;
      openMessageBrowserTab(createBrowserPanelTab(detail.url));
    };
    const handleOpenLocalHtml = async (event: Event) => {
      const detail = (
        event as CustomEvent<{
          filePath?: string;
          workingDirectory?: string;
          navigationSuffix?: unknown;
        }>
      ).detail;
      if (!detail?.filePath) return;
      const navigationSuffix = detail.navigationSuffix;
      if (
        navigationSuffix !== undefined &&
        (typeof navigationSuffix !== 'string' ||
          !/^[?#]/u.test(navigationSuffix) ||
          /[\u0000-\u001f\u007f]/u.test(navigationSuffix))
      ) {
        return;
      }
      const target = normalizeBrowserLinkTarget(
        configService.getConfig().browserHtmlLinkTarget,
        BrowserLinkTarget.Embedded,
      );
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
        let url = result.url;
        if (navigationSuffix) {
          const previewUrl = new URL(url);
          if (navigationSuffix.startsWith('#')) {
            previewUrl.hash = navigationSuffix;
          } else {
            const fragmentIndex = navigationSuffix.indexOf('#');
            previewUrl.search =
              fragmentIndex < 0 ? navigationSuffix : navigationSuffix.slice(0, fragmentIndex);
            previewUrl.hash = fragmentIndex < 0 ? '' : navigationSuffix.slice(fragmentIndex);
          }
          url = previewUrl.href;
        }
        if (target === BrowserLinkTarget.Chrome) {
          const opened = await window.electron.browser.openInChrome(url);
          if (!opened.success) {
            window.dispatchEvent(
              new CustomEvent('app:showToast', { detail: i18nService.t('browserLinkOpenFailed') }),
            );
          }
          return;
        }
        const tab = createBrowserPanelTab(url, {
          sourceFilePath: result.filePath,
          sourcePreviewUrl: url,
          sourceRootPath: result.rootPath,
          sourcePreviewRootUrl: result.previewRootUrl,
        });
        openMessageBrowserTab(tab);
      } catch {
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('coworkFilePreviewFailed') }),
        );
      }
    };
    window.addEventListener(MessageBrowserEvent.OpenWebUrl, handleOpenWebUrl);
    window.addEventListener(MessageBrowserEvent.OpenLocalHtml, handleOpenLocalHtml);
    return () => {
      window.removeEventListener(MessageBrowserEvent.OpenWebUrl, handleOpenWebUrl);
      window.removeEventListener(MessageBrowserEvent.OpenLocalHtml, handleOpenLocalHtml);
    };
  }, [browserPanelRefs, displaySessionKey, openBrowserTab]);
  return { handleCreateBrowserTab };
}
