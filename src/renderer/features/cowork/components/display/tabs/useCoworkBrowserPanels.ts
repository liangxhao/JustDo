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
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { type BrowserPanelHandle, createBrowserPanelTab } from '@/features/browser/BrowserPanel';
import {
  browserAgentPanelOperationKey,
  isAgentBrowserSessionAvailable,
  type PendingBrowserAgentPanelState,
  takeAvailableBrowserAgentPanelStates,
} from '@/features/browser/browserPanelRetention';
import { reportBrowserTabCapacity } from '@/features/browser/browserTabCapacity';
import { MessageBrowserEvent } from '@/features/browser/messageBrowserLinks';
import { getBrowserTabLimit } from '@/features/browser/useBrowserTabLimit';
import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import { browserDisplayTabId } from './displayTabIds';
import type { SessionDisplayState, SessionDisplayStateMap } from './useSessionDisplayState';

export interface OpenLocalHtmlOptions {
  filePath: string;
  workingDirectory?: string;
  navigationSuffix?: string;
  displayTarget?: unknown;
  currentSessionOnly?: boolean;
  isCurrent?: () => boolean;
}

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
  filePreviewRequestIdRef?: React.MutableRefObject<number>;
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
  sessions: Array<Pick<CoworkSessionSummary, 'id' | 'status'>>;
  availableAgentBrowserSessionIdsRef: React.MutableRefObject<string[]>;
  handleBrowserTargetChange: (targetId: string | null) => void;
  openBrowserTab: (targetSessionKey: string, tab: BrowserPanelTab, maximumTabs: number) => void;
}

export function useCoworkBrowserPanels({
  pendingBrowserTabsRef,
  displaySessionKey,
  currentSessionId,
  filePreviewRequestIdRef,
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
  const displayStatesRef = useRef(displayStates);
  displayStatesRef.current = displayStates;
  const pendingResourceTargetsRef = useRef(new Map<string, Map<string, string>>());
  useEffect(() => {
    for (const [owner, targets] of pendingResourceTargetsRef.current) {
      for (const [target, resource] of targets)
        if (
          displayStates[owner]?.browserTabs.some(
            tab => tab.targetId === target && tab.resourceSessionId === resource,
          )
        )
          targets.delete(target);
      if (!targets.size) pendingResourceTargetsRef.current.delete(owner);
    }
  }, [displayStates]);
  const hasResourceTarget = useCallback(
    (owner: string, target: string | undefined, resource: string): boolean =>
      Boolean(
        target &&
        (displayStatesRef.current[owner]?.browserTabs.some(
          tab => tab.targetId === target && (tab.resourceSessionId ?? owner) === resource,
        ) ||
          pendingResourceTargetsRef.current.get(owner)?.get(target) === resource),
      ),
    [],
  );
  const initializingTabSessionRef = useRef<string | null>(null);
  const previousDisplayTabsRef = useRef({ displaySessionKey, hasDisplayTabs });
  const messageNavigationScopeRef = useRef({ displaySessionKey });
  if (messageNavigationScopeRef.current.displaySessionKey !== displaySessionKey) {
    messageNavigationScopeRef.current = { displaySessionKey };
  }
  const messageOwnerLifetimeRef = useRef<object | null>(null);
  const messageOwnersRef = useRef(new Set<string>());
  messageOwnersRef.current = new Set(sessions.map(session => session.id));
  const openBrowserTabRef = useRef(openBrowserTab);
  openBrowserTabRef.current = openBrowserTab;
  const displayControlsRef = useRef({
    displaySessionKey,
    setIsDisplayPanelOpen,
    setIsBrowserPanelOpen,
  });
  displayControlsRef.current = { displaySessionKey, setIsDisplayPanelOpen, setIsBrowserPanelOpen };
  // Account for message-created tabs until the next commit publishes them.
  const messageTabAdmissionsRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    messageTabAdmissionsRef.current.clear();
  });
  useLayoutEffect(() => {
    const lifetime = {};
    messageOwnerLifetimeRef.current = lifetime;
    return () => {
      if (messageOwnerLifetimeRef.current === lifetime) messageOwnerLifetimeRef.current = null;
    };
  }, []);
  const createBrowserTab = useCallback(
    (url?: string, invalidatePendingNavigation = false) => {
      setIsDisplayPanelOpen(true);
      const pendingTabs = pendingBrowserTabsRef.current.get(displaySessionKey) ?? [];
      if (currentSessionId?.startsWith('temp-')) return;
      const messageAdmissions = messageTabAdmissionsRef.current.get(displaySessionKey) ?? 0;
      if (browserTabs.length + pendingTabs.length + messageAdmissions >= getBrowserTabLimit()) {
        if (browserTabs.length) setIsBrowserPanelOpen(true);
        reportBrowserTabCapacity(displaySessionKey);
        return;
      }
      if (invalidatePendingNavigation && filePreviewRequestIdRef) {
        filePreviewRequestIdRef.current += 1;
      }
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
      filePreviewRequestIdRef,
      pendingBrowserTabsRef,
      setBrowserTabCreationSequence,
      setHasBrowserPanelOpened,
      setIsBrowserPanelOpen,
      setIsDisplayPanelOpen,
      setIsWorkspaceFilesOpen,
    ],
  );
  const handleCreateBrowserTab = useCallback(
    (url?: string) => createBrowserTab(url, true),
    [createBrowserTab],
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
      if (filePreviewRequestIdRef) filePreviewRequestIdRef.current += 1;
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
    // Seeding an empty panel is not a new user navigation.
    createBrowserTab();
    // Keep the creation in flight after the queue drains, until its tab is published.
    // StrictMode may replay this effect before the parent observes the browser tab.
    if ((pendingBrowserTabsRef.current.get(displaySessionKey)?.length ?? 0) > 0) {
      initializingTabSessionRef.current = displaySessionKey;
    }
  }, [
    browserTabs,
    createBrowserTab,
    displaySessionKey,
    filePreviewRequestIdRef,
    handleBrowserTargetChange,
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
      const ownerSessionId = event.ownerSessionId ?? event.sessionId;
      setBrowserAgentPanelStates(current => {
        const next = new Map(current);
        const sessionStates = new Map(next.get(ownerSessionId) ?? []);
        if (event.busy) sessionStates.set(event.operationId!, event);
        else sessionStates.delete(event.operationId!);
        if (sessionStates.size) next.set(ownerSessionId, sessionStates);
        else next.delete(ownerSessionId);
        return next;
      });
      if (event.busy) {
        setSessionField(ownerSessionId, 'hasBrowserPanelOpened', true);
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
      const ownerSessionId = event.ownerSessionId ?? event.sessionId;
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
        !isAgentBrowserSessionAvailable(availableAgentBrowserSessionIdsRef.current, ownerSessionId)
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
      const ownerSessionId = event.ownerSessionId ?? event.sessionId;
      if (
        !isAgentBrowserSessionAvailable(availableAgentBrowserSessionIdsRef.current, ownerSessionId)
      ) {
        return;
      }
      if (event.targetId && event.ownerSessionId) {
        const existing = displayStatesRef.current[ownerSessionId]?.browserTabs.find(
          tab => tab.targetId === event.targetId,
        );
        const pending = pendingResourceTargetsRef.current.get(ownerSessionId)?.get(event.targetId);
        if (
          (existing && (existing.resourceSessionId ?? ownerSessionId) !== event.sessionId) ||
          (pending !== undefined && pending !== event.sessionId)
        )
          return;
      }
      const tab = createBrowserPanelTab(event.url, {
        targetId: event.targetId,
        customTitle: event.label,
        profile: event.profile,
        ...(event.ownerSessionId ? { resourceSessionId: event.sessionId } : {}),
      });
      // Only the selected main conversation presents its newly opened page.
      // Delegated executions share its sidebar but keep the user's selection.
      const reveal =
        !event.ownerSessionId &&
        event.sessionId === displayControlsRef.current.displaySessionKey;
      // initialTabs only seeds an empty panel. An already mounted panel owns
      // its live tabs and must create the requested guest through its handle.
      const created = browserPanelRefs.current.get(ownerSessionId)?.openTab(tab.url, {
        targetId: tab.targetId,
        customTitle: event.label,
        profile: event.profile,
        notifyOnCapacity: false,
        ...(tab.resourceSessionId ? { resourceSessionId: tab.resourceSessionId } : {}),
        preserveSelection: !reveal,
      });
      // A mounted panel may reject creation at its capacity limit. Keep the
      // current selection and parent state aligned with its actual guests.
      if (created === false) return;
      if (tab.resourceSessionId) {
        const pending = pendingResourceTargetsRef.current.get(ownerSessionId) ?? new Map();
        pending.set(tab.targetId, tab.resourceSessionId);
        pendingResourceTargetsRef.current.set(ownerSessionId, pending);
      }
      setSessionField(ownerSessionId, 'browserTabs', current => {
        const existingTab = event.targetId
          ? current.find(candidate => candidate.targetId === event.targetId)
          : current[0];
        return existingTab ? current : [...current, tab];
      });
      setSessionField(ownerSessionId, 'hasBrowserPanelOpened', true);
      setSessionField(ownerSessionId, 'isBrowserPanelOpen', true);
      if (reveal) {
        setSessionField(ownerSessionId, 'browserPanelTargetId', tab.targetId);
        setSessionField(ownerSessionId, 'preferredDisplayTabId', browserDisplayTabId(tab.targetId));
        setSessionField(ownerSessionId, 'isWorkspaceFilesOpen', false);
        setSessionField(ownerSessionId, 'isDisplayPanelOpen', true);
      }
    });
    const removeCloseListener = window.electron.browser.onAgentCloseTab(event => {
      const ownerSessionId = event.ownerSessionId ?? event.sessionId;
      const panel = browserPanelRefs.current.get(ownerSessionId);
      if (panel) {
        if (
          event.targetId &&
          pendingResourceTargetsRef.current.get(ownerSessionId)?.get(event.targetId) ===
            event.sessionId
        )
          pendingResourceTargetsRef.current.get(ownerSessionId)?.delete(event.targetId);
        if (event.ownerSessionId)
          panel.closeTab(event.targetId, {
            resourceSessionId: event.sessionId,
            preserveFocus: true,
          });
        else panel.closeTab(event.targetId, { preserveFocus: true });
        return;
      }
      if (
        event.ownerSessionId &&
        !hasResourceTarget(ownerSessionId, event.targetId, event.sessionId)
      )
        return;
      if (event.targetId)
        pendingResourceTargetsRef.current.get(ownerSessionId)?.delete(event.targetId);
      setSessionField(ownerSessionId, 'browserTabs', current =>
        current.filter(
          tab =>
            tab.targetId !== event.targetId ||
            (tab.resourceSessionId ?? ownerSessionId) !== event.sessionId,
        ),
      );
      setSessionField(ownerSessionId, 'browserPanelTargetId', current =>
        current === event.targetId ? null : current,
      );
      setSessionField(ownerSessionId, 'preferredDisplayTabId', current =>
        current === browserDisplayTabId(event.targetId) ? null : current,
      );
    });
    return () => {
      removeInteractionListener();
      removeEnsureListener();
      removeCloseListener();
    };
  }, [
    applyBrowserAgentPanelState,
    availableAgentBrowserSessionIdsRef,
    browserPanelRefs,
    displaySessionKey,
    handleBrowserTargetChange,
    hasResourceTarget,
    pendingBrowserAgentPanelStatesRef,
    setHasBrowserPanelOpened,
    setIsBrowserPanelOpen,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setSessionField,
  ]);

  const openMessageBrowserTab = useCallback(
    (tab: BrowserPanelTab) => {
      const pendingTabs = pendingBrowserTabsRef.current.get(displaySessionKey) ?? [];
      const currentTabs = displayStatesRef.current[displaySessionKey]?.browserTabs ?? browserTabs;
      const messageAdmissions = messageTabAdmissionsRef.current.get(displaySessionKey) ?? 0;
      if (currentTabs.length + pendingTabs.length + messageAdmissions >= getBrowserTabLimit()) {
        const controls = displayControlsRef.current;
        if (controls.displaySessionKey === displaySessionKey) {
          controls.setIsDisplayPanelOpen(true);
          if (currentTabs.length) controls.setIsBrowserPanelOpen(true);
        }
        reportBrowserTabCapacity(displaySessionKey);
        return;
      }
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
      if (created === undefined) {
        messageTabAdmissionsRef.current.set(displaySessionKey, messageAdmissions + 1);
      }
      openBrowserTabRef.current(displaySessionKey, tab, getBrowserTabLimit());
    },
    [browserPanelRefs, browserTabs, displaySessionKey, pendingBrowserTabsRef],
  );
  const openLocalHtml = useCallback(
    async (detail: OpenLocalHtmlOptions) => {
      const navigationScope = messageNavigationScopeRef.current;
      const ownerLifetime = messageOwnerLifetimeRef.current;
      const ownerIsCurrent = () =>
        ownerLifetime !== null &&
        messageOwnerLifetimeRef.current === ownerLifetime &&
        (currentSessionId
          ? messageOwnersRef.current.has(currentSessionId)
          : messageNavigationScopeRef.current === navigationScope);
      if (!detail?.filePath || !ownerIsCurrent() || detail.isCurrent?.() === false) return;
      const navigationSuffix = detail.navigationSuffix;
      if (
        navigationSuffix !== undefined &&
        (typeof navigationSuffix !== 'string' ||
          !/^[?#]/u.test(navigationSuffix) ||
          /[\u0000-\u001f\u007f]/u.test(navigationSuffix))
      ) {
        return;
      }
      const requestId = filePreviewRequestIdRef ? ++filePreviewRequestIdRef.current : undefined;
      const requestIsCurrent = () =>
        ownerIsCurrent() &&
        (!detail.currentSessionOnly || messageNavigationScopeRef.current === navigationScope) &&
        detail.isCurrent?.() !== false &&
        (requestId === undefined || filePreviewRequestIdRef?.current === requestId);
      const target = normalizeBrowserLinkTarget(
        detail.displayTarget ?? configService.getConfig().browserHtmlLinkTarget,
        BrowserLinkTarget.Embedded,
      );
      if (!requestIsCurrent()) return;
      try {
        const result = await window.electron.browser.createLocalHtmlPreview(
          detail.filePath,
          detail.workingDirectory,
        );
        if (!requestIsCurrent()) return;
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
          const opened = await window.electron.chrome.openUrl(url);
          if (!opened.success && requestIsCurrent()) {
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
        if (!requestIsCurrent()) return;
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('coworkFilePreviewFailed') }),
        );
      }
    },
    [currentSessionId, filePreviewRequestIdRef, openMessageBrowserTab],
  );
  const messageEventHandlersRef = useRef({ openLocalHtml, openMessageBrowserTab });
  messageEventHandlersRef.current = { openLocalHtml, openMessageBrowserTab };
  useEffect(() => {
    const handleOpenWebUrl = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: unknown }>).detail;
      if (!isWebBrowserLink(detail?.url)) return;
      if (filePreviewRequestIdRef) filePreviewRequestIdRef.current += 1;
      messageEventHandlersRef.current.openMessageBrowserTab(createBrowserPanelTab(detail.url));
    };
    const handleOpenLocalHtml = (event: Event) => {
      const detail = (event as CustomEvent<OpenLocalHtmlOptions>).detail;
      if (detail) void messageEventHandlersRef.current.openLocalHtml(detail);
    };
    window.addEventListener(MessageBrowserEvent.OpenWebUrl, handleOpenWebUrl);
    window.addEventListener(MessageBrowserEvent.OpenLocalHtml, handleOpenLocalHtml);
    return () => {
      window.removeEventListener(MessageBrowserEvent.OpenWebUrl, handleOpenWebUrl);
      window.removeEventListener(MessageBrowserEvent.OpenLocalHtml, handleOpenLocalHtml);
    };
  }, [filePreviewRequestIdRef]);
  return { handleCreateBrowserTab, openLocalHtml };
}
