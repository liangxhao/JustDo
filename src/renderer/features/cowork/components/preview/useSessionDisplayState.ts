import type { BrowserPanelTab } from '@shared/browser/browser';
import {
  DEFAULT_MAX_RETAINED_DISPLAY_TABS,
  normalizeMaxRetainedDisplayTabs,
} from '@shared/cowork/displayTabRetention';
import { REVIEW_TAB_ID } from '@shared/cowork/sessionReview';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  removeRetainedBrowserPanelTabs,
  setRetainedBrowserPanelTabs,
} from '@/features/browser/browserPanelRetention';
import type { SideChatMessage } from '@/features/cowork/components/chat/SideChatPanel';
import type { FilePreview } from '@/features/cowork/components/preview/FilePreviewDrawer';
import type { Subtask } from '@/features/cowork/components/subagents/subtaskPresentation';

export const HOME_DISPLAY_SESSION_KEY = '__home__';

export interface CoworkTerminalTab {
  cwd: string;
  id: string;
  label: string;
}

export interface CoworkSideChatTab {
  id: string;
  label: string;
  messages: SideChatMessage[];
  sessionId: string;
}

export interface SessionDisplayState {
  runtimeId: string;
  selectedSubagent: (Subtask & { parentSessionId?: string }) | null;
  isDisplayPanelOpen: boolean;
  isBrowserPanelOpen: boolean;
  hasBrowserPanelOpened: boolean;
  hasBrowserRecording: boolean;
  browserPanelWidth: number;
  browserPanelTargetId: string | null;
  browserTabs: BrowserPanelTab[];
  browserTabCreationSequence: number;
  terminalTabs: CoworkTerminalTab[];
  preferredDisplayTabId: string | null;
  sideChatTabs: CoworkSideChatTab[];
  isWorkspaceFilesOpen: boolean;
  isReviewOpen: boolean;
  reviewFocusPath: string;
  reviewFocusVersion: number;
  filesRevealPath: string;
  filesRevealVersion: number;
  filePreviews: FilePreview[];
  unsupportedFilePreviews: string[];
  tabRecency: Record<string, number>;
}

export type SessionDisplayStateMap = Record<string, SessionDisplayState>;

let displayRuntimeSequence = 0;

export const createSessionDisplayState = (browserPanelWidth: number): SessionDisplayState => ({
  runtimeId: `display-runtime:${++displayRuntimeSequence}`,
  selectedSubagent: null,
  isDisplayPanelOpen: false,
  isBrowserPanelOpen: false,
  hasBrowserPanelOpened: false,
  hasBrowserRecording: false,
  browserPanelWidth,
  browserPanelTargetId: null,
  browserTabs: [],
  browserTabCreationSequence: 0,
  terminalTabs: [],
  preferredDisplayTabId: null,
  sideChatTabs: [],
  isWorkspaceFilesOpen: false,
  isReviewOpen: false,
  reviewFocusPath: '',
  reviewFocusVersion: 0,
  filesRevealPath: '',
  filesRevealVersion: 0,
  filePreviews: [],
  unsupportedFilePreviews: [],
  tabRecency: {},
});

const BROWSER_TAB_PREFIX = 'browser:';
const FILE_TAB_PREFIX = 'file:';
const SUBAGENT_TAB_ID = 'subagent';

const fileTabId = (filePath: string): string => `${FILE_TAB_PREFIX}${filePath.replace(/\\/g, '/')}`;

const getDisplayTabIds = (state: SessionDisplayState): string[] => [
  ...(state.isReviewOpen ? [REVIEW_TAB_ID] : []),
  ...state.browserTabs.map(tab => `${BROWSER_TAB_PREFIX}${tab.targetId}`),
  ...state.terminalTabs.map(tab => tab.id),
  ...state.filePreviews.map(preview => fileTabId(preview.filePath)),
  ...state.unsupportedFilePreviews.map(fileTabId),
  ...(state.selectedSubagent ? [SUBAGENT_TAB_ID] : []),
  ...state.sideChatTabs.map(tab => tab.id),
];

const withTrackedTabRecency = (
  previous: SessionDisplayState,
  next: SessionDisplayState,
  touchedTabId: string | null,
  nextSequence: () => number,
): SessionDisplayState => {
  const previousIds = new Set(getDisplayTabIds(previous));
  const nextIds = getDisplayTabIds(next);
  const nextIdSet = new Set(nextIds);
  const tabRecency = Object.fromEntries(
    Object.entries(previous.tabRecency).filter(([tabId]) => nextIdSet.has(tabId)),
  );
  for (const tabId of nextIds) {
    if (!previousIds.has(tabId) || tabRecency[tabId] === undefined) {
      tabRecency[tabId] = nextSequence();
    }
  }
  if (touchedTabId && nextIdSet.has(touchedTabId)) tabRecency[touchedTabId] = nextSequence();
  return { ...next, tabRecency };
};

const retainTabs = (state: SessionDisplayState, retainedTabIds: Set<string>) => {
  const browserTabs = state.browserTabs.filter(tab =>
    retainedTabIds.has(`${BROWSER_TAB_PREFIX}${tab.targetId}`),
  );
  const terminalTabs = state.terminalTabs.filter(tab => retainedTabIds.has(tab.id));
  const filePreviews = state.filePreviews.filter(preview =>
    retainedTabIds.has(fileTabId(preview.filePath)),
  );
  const unsupportedFilePreviews = state.unsupportedFilePreviews.filter(filePath =>
    retainedTabIds.has(fileTabId(filePath)),
  );
  const selectedSubagent = retainedTabIds.has(SUBAGENT_TAB_ID) ? state.selectedSubagent : null;
  const sideChatTabs = state.sideChatTabs.filter(tab => retainedTabIds.has(tab.id));
  const isReviewOpen = state.isReviewOpen && retainedTabIds.has(REVIEW_TAB_ID);
  const liveIds = new Set([
    ...(isReviewOpen ? [REVIEW_TAB_ID] : []),
    ...browserTabs.map(tab => `${BROWSER_TAB_PREFIX}${tab.targetId}`),
    ...terminalTabs.map(tab => tab.id),
    ...filePreviews.map(preview => fileTabId(preview.filePath)),
    ...unsupportedFilePreviews.map(fileTabId),
    ...(selectedSubagent ? [SUBAGENT_TAB_ID] : []),
    ...sideChatTabs.map(tab => tab.id),
  ]);
  return {
    ...state,
    isReviewOpen,
    browserTabs,
    terminalTabs,
    filePreviews,
    unsupportedFilePreviews,
    selectedSubagent,
    sideChatTabs,
    isBrowserPanelOpen: browserTabs.length > 0 && state.isBrowserPanelOpen,
    hasBrowserPanelOpened: browserTabs.length > 0 && state.hasBrowserPanelOpened,
    browserPanelTargetId:
      state.browserPanelTargetId &&
      liveIds.has(`${BROWSER_TAB_PREFIX}${state.browserPanelTargetId}`)
        ? state.browserPanelTargetId
        : null,
    preferredDisplayTabId:
      state.preferredDisplayTabId && liveIds.has(state.preferredDisplayTabId)
        ? state.preferredDisplayTabId
        : null,
    tabRecency: Object.fromEntries(
      Object.entries(state.tabRecency).filter(([tabId]) => liveIds.has(tabId)),
    ),
  };
};

export const enforceBackgroundTabLimit = (
  states: SessionDisplayStateMap,
  activeSessionKey: string,
  maximum: number,
  protectedSessionIds: readonly string[] = [],
): SessionDisplayStateMap => {
  const limit = normalizeMaxRetainedDisplayTabs(maximum);
  const protectedSessions = new Set([
    ...protectedSessionIds,
    ...Object.entries(states)
      .filter(([, state]) => state.hasBrowserRecording)
      .map(([key]) => key),
  ]);
  const backgroundTabs = Object.entries(states).flatMap(([sessionKey, state]) =>
    sessionKey === activeSessionKey || protectedSessions.has(sessionKey)
      ? []
      : getDisplayTabIds(state)
          .map(tabId => ({
            sessionKey,
            tabId,
            recency: state.tabRecency[tabId] ?? 0,
          })),
  );
  if (backgroundTabs.length <= limit) return states;
  const retainedKeys = new Set(
    backgroundTabs
      .sort((left, right) => right.recency - left.recency)
      .slice(0, limit)
      .map(tab => `${tab.sessionKey}\0${tab.tabId}`),
  );
  return Object.fromEntries(
    Object.entries(states).map(([sessionKey, state]) => {
      if (sessionKey === activeSessionKey || protectedSessions.has(sessionKey)) {
        return [sessionKey, state];
      }
      const retainedTabIds = new Set(
        getDisplayTabIds(state).filter(tabId => retainedKeys.has(`${sessionKey}\0${tabId}`)),
      );
      return [sessionKey, retainTabs(state, retainedTabIds)];
    }),
  );
};

export const promoteSessionDisplayState = (
  states: SessionDisplayStateMap,
  fromSessionKey: string,
  toSessionKey: string,
): SessionDisplayStateMap => {
  if (fromSessionKey === toSessionKey || !states[fromSessionKey]) return states;
  const next = { ...states, [toSessionKey]: states[fromSessionKey] };
  delete next[fromSessionKey];
  return next;
};

export function useSessionDisplayState(
  sessionId: string | null,
  browserPanelWidth: number,
  maxRetainedTabs = DEFAULT_MAX_RETAINED_DISPLAY_TABS,
  validSessionIds?: readonly string[],
  protectedSessionIds: readonly string[] = [],
) {
  const sessionKey = sessionId ?? HOME_DISPLAY_SESSION_KEY;
  const protectedSessionIdsKey = protectedSessionIds.join('\0');
  const stableProtectedSessionIds = useMemo(
    () => (protectedSessionIdsKey ? protectedSessionIdsKey.split('\0') : []),
    [protectedSessionIdsKey],
  );
  const sequenceRef = useRef(0);
  const [states, setStates] = useState<SessionDisplayStateMap>(() => ({
    [sessionKey]: createSessionDisplayState(browserPanelWidth),
  }));
  const state = states[sessionKey] ?? createSessionDisplayState(browserPanelWidth);

  const setSessionField = useCallback(
    <K extends keyof SessionDisplayState>(
      targetSessionKey: string,
      field: K,
      value: SetStateAction<SessionDisplayState[K]>,
    ) => {
      setStates(current => {
        const currentState =
          current[targetSessionKey] ?? createSessionDisplayState(browserPanelWidth);
        const nextValue =
          typeof value === 'function'
            ? (value as (previous: SessionDisplayState[K]) => SessionDisplayState[K])(
                currentState[field],
              )
            : value;
        if (Object.is(currentState[field], nextValue)) return current;
        const updatedState = withTrackedTabRecency(
          currentState,
          { ...currentState, [field]: nextValue },
          field === 'preferredDisplayTabId' ? (nextValue as string | null) : null,
          () => ++sequenceRef.current,
        );
        return enforceBackgroundTabLimit(
          {
            ...current,
            [targetSessionKey]: updatedState,
          },
          sessionKey,
          maxRetainedTabs,
          stableProtectedSessionIds,
        );
      });
    },
    [browserPanelWidth, maxRetainedTabs, sessionKey, stableProtectedSessionIds],
  );

  const setField = useCallback(
    <K extends keyof SessionDisplayState>(
      field: K,
      value: SetStateAction<SessionDisplayState[K]>,
    ) => setSessionField(sessionKey, field, value),
    [sessionKey, setSessionField],
  );

  const setters = useMemo(() => {
    const setter = <K extends keyof SessionDisplayState>(field: K) =>
      ((value: SetStateAction<SessionDisplayState[K]>) => setField(field, value)) as Dispatch<
        SetStateAction<SessionDisplayState[K]>
      >;
    return {
      setSelectedSubagent: setter('selectedSubagent'),
      setIsDisplayPanelOpen: setter('isDisplayPanelOpen'),
      setIsBrowserPanelOpen: setter('isBrowserPanelOpen'),
      setHasBrowserPanelOpened: setter('hasBrowserPanelOpened'),
      setBrowserPanelWidth: setter('browserPanelWidth'),
      setBrowserPanelTargetId: setter('browserPanelTargetId'),
      setBrowserTabs: setter('browserTabs'),
      setBrowserTabCreationSequence: setter('browserTabCreationSequence'),
      setTerminalTabs: setter('terminalTabs'),
      setPreferredDisplayTabId: setter('preferredDisplayTabId'),
      setSideChatTabs: setter('sideChatTabs'),
      setIsWorkspaceFilesOpen: setter('isWorkspaceFilesOpen'),
      setIsReviewOpen: setter('isReviewOpen'),
      setReviewFocusPath: setter('reviewFocusPath'),
      setReviewFocusVersion: setter('reviewFocusVersion'),
      setFilesRevealPath: setter('filesRevealPath'),
      setFilesRevealVersion: setter('filesRevealVersion'),
      setFilePreviews: setter('filePreviews'),
      setUnsupportedFilePreviews: setter('unsupportedFilePreviews'),
    };
  }, [setField]);

  const promote = useCallback((fromSessionKey: string, toSessionKey: string) => {
    setStates(current => promoteSessionDisplayState(current, fromSessionKey, toSessionKey));
  }, []);

  const openBrowserTab = useCallback(
    (targetSessionKey: string, tab: BrowserPanelTab, maximumTabs: number) => {
      setStates(current => {
        const currentState =
          current[targetSessionKey] ?? createSessionDisplayState(browserPanelWidth);
        if (
          currentState.browserTabs.some(candidate => candidate.targetId === tab.targetId) ||
          currentState.browserTabs.length >= maximumTabs
        ) {
          return current;
        }
        const tabId = `${BROWSER_TAB_PREFIX}${tab.targetId}`;
        const updatedState = withTrackedTabRecency(
          currentState,
          {
            ...currentState,
            browserTabs: [...currentState.browserTabs, tab],
            browserPanelTargetId: tab.targetId,
            preferredDisplayTabId: tabId,
            isDisplayPanelOpen: true,
            isBrowserPanelOpen: true,
            hasBrowserPanelOpened: true,
            isWorkspaceFilesOpen: false,
          },
          tabId,
          () => ++sequenceRef.current,
        );
        return enforceBackgroundTabLimit(
          { ...current, [targetSessionKey]: updatedState },
          sessionKey,
          maxRetainedTabs,
          stableProtectedSessionIds,
        );
      });
    },
    [browserPanelWidth, maxRetainedTabs, sessionKey, stableProtectedSessionIds],
  );

  useEffect(() => {
    setStates(current => {
      const currentState = current[sessionKey] ?? createSessionDisplayState(browserPanelWidth);
      const tabRecency = { ...currentState.tabRecency };
      for (const tabId of getDisplayTabIds(currentState)) {
        tabRecency[tabId] = ++sequenceRef.current;
      }
      return enforceBackgroundTabLimit(
        { ...current, [sessionKey]: { ...currentState, tabRecency } },
        sessionKey,
        maxRetainedTabs,
        stableProtectedSessionIds,
      );
    });
  }, [browserPanelWidth, maxRetainedTabs, sessionKey, stableProtectedSessionIds]);

  const validSessionIdsKey = validSessionIds?.join('\0');
  useEffect(() => {
    if (validSessionIdsKey === undefined) return;
    const validKeys = new Set([HOME_DISPLAY_SESSION_KEY, ...validSessionIdsKey.split('\0')]);
    if (sessionId) validKeys.add(sessionId);
    setStates(current =>
      Object.fromEntries(Object.entries(current).filter(([key]) => validKeys.has(key))),
    );
  }, [sessionId, validSessionIdsKey]);

  const previousSessionKeysRef = useRef(new Set<string>());
  useEffect(() => {
    const nextKeys = new Set(Object.keys(states));
    for (const key of previousSessionKeysRef.current) {
      if (!nextKeys.has(key)) removeRetainedBrowserPanelTabs(key);
    }
    for (const [key, displayState] of Object.entries(states)) {
      setRetainedBrowserPanelTabs(key, displayState.browserTabs);
    }
    previousSessionKeysRef.current = nextKeys;
  }, [states]);

  return { sessionKey, state, states, setters, setSessionField, openBrowserTab, promote };
}
