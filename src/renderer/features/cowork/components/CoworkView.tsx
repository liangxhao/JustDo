import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckCircleIcon,
  ClipboardDocumentCheckIcon,
  CommandLineIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  PhotoIcon,
  QueueListIcon,
  StopCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { PauseCircleIcon as PauseCircleSolidIcon } from '@heroicons/react/24/solid';
import { MAIN_USER_AGENT_ID } from '@shared/agents/agents';
import { SaveTextFileErrorCode } from '@shared/app/dialogIpc';
import {
  BROWSER_AGENT_INTERACTION_ACK_TIMEOUT_MS,
  BROWSER_AGENT_PANEL_TARGET_ID,
  BROWSER_ANNOTATION_CONTEXT_MAX_LENGTH,
  type BrowserAgentInteractionState,
  type BrowserAnnotationDraft,
  composeBrowserGatewayPrompt,
  serializeBrowserAnnotationContext,
} from '@shared/browser/browser';
import { recordingImagesInStepOrder } from '@shared/browser/browserRecording';
import { DEFAULT_MAX_RETAINED_DISPLAY_TABS } from '@shared/cowork/displayTabRetention';
import { getMessageTitleInput } from '@shared/cowork/messageInput';
import { COWORK_PLAN_PREVIEW_EVENT, isCoworkPlanPreview } from '@shared/cowork/planPreview';
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { isGoalEditCommand } from '@shared/cowork/slashCommands';
import { CoworkInteractionKind, OpenClawToolName } from '@shared/openclaw/extensions';
import {
  type ProgressCard,
  progressCardIsComplete,
  type ProgressCardViewState,
} from '@shared/openclaw/progressCard';
import { HOME_WORKSPACE_SESSION_ID } from '@shared/preview/filePreview';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';

import WindowHeader from '@/app/shell/window/WindowHeader';
import {
  BROWSER_ANNOTATION_MAX_COUNT,
  BROWSER_ANNOTATION_MAX_IMAGE_BYTES,
  browserAnnotationDataBytes,
} from '@/features/browser/browserAnnotation';
import BrowserPanel, {
  BROWSER_PANEL_DEFAULT_WIDTH,
  type BrowserPanelHandle,
  createBrowserPanelTab,
  getBrowserTabDisplayTitle,
} from '@/features/browser/BrowserPanel';
import {
  browserAgentPanelOperationKey,
  isAgentBrowserSessionAvailable,
  type PendingBrowserAgentPanelState,
  promoteBrowserPanelTabs,
  promotePendingBrowserPanelItems,
  takeAvailableBrowserAgentPanelStates,
} from '@/features/browser/browserPanelRetention';
import { recordingSubmissionIssue } from '@/features/browser/browserRecordingSubmission';
import JustDoChatWrapper, {
  type JustDoChatWrapperRef,
} from '@/features/cowork/components/chat/JustDoChatWrapper';
import SideChatPanel from '@/features/cowork/components/chat/SideChatPanel';
import { resolveAgentModelSelection } from '@/features/cowork/components/composer/agentModelSelection';
import { submitCoworkMessage } from '@/features/cowork/components/composer/coworkMessageSubmit';
import CoworkPromptInput, {
  appendMediaDirectiveLines,
  type CoworkPromptInputRef,
} from '@/features/cowork/components/composer/CoworkPromptInput';
import { inferInitialGoalObjective } from '@/features/cowork/components/goals/goalPendingObjective';
import type { GoalRunProgress } from '@/features/cowork/components/goals/goalRunProgress';
import CoworkDisplayPanel, {
  type CoworkDisplayTab,
  type CoworkDisplayTabCloseActions,
} from '@/features/cowork/components/preview/CoworkDisplayPanel';
import DisplayPanelLauncher from '@/features/cowork/components/preview/DisplayPanelLauncher';
import { getAdjacentDisplayTabId } from '@/features/cowork/components/preview/displayTabSelection';
import FilePreviewDrawer, {
  type FilePreviewDrawerHandle,
} from '@/features/cowork/components/preview/FilePreviewDrawer';
import { type FilePreviewNavigationOptions } from '@/features/cowork/components/preview/filePreviewNavigation';
import NewDisplayTabMenu from '@/features/cowork/components/preview/NewDisplayTabMenu';
import PlanApprovalDrawer from '@/features/cowork/components/preview/PlanApprovalDrawer';
import {
  initialPlanPreviewState,
  planPreviewReducer,
  retainedPlanForSession,
} from '@/features/cowork/components/preview/planPreviewState';
import TerminalPanel from '@/features/cowork/components/preview/TerminalPanel';
import UnsupportedFilePreview from '@/features/cowork/components/preview/UnsupportedFilePreview';
import { useFilePreviewEvents } from '@/features/cowork/components/preview/useFilePreviewEvents';
import { useRecordingReviewTabs } from '@/features/cowork/components/preview/useRecordingReviewTabs';
import {
  HOME_DISPLAY_SESSION_KEY,
  useSessionDisplayState,
} from '@/features/cowork/components/preview/useSessionDisplayState';
import WorkspaceFilesPanel from '@/features/cowork/components/preview/WorkspaceFilesPanel';
import ExportSessionModal from '@/features/cowork/components/sessions/ExportSessionModal';
import {
  resolveBackgroundRuntimeDiscoverySessionIds,
  resolveBackgroundRuntimeSessionIds,
  shouldContinueFullRuntimeScan,
} from '@/features/cowork/components/status/runtimePolling';
import SessionProgressCard, {
  type ProgressCardRunState,
} from '@/features/cowork/components/status/SessionProgressCard';
import { useProgressCardVisibility } from '@/features/cowork/components/status/useProgressCardVisibility';
import SubagentMessageDrawer from '@/features/cowork/components/subagents/SubagentMessageDrawer';
import SubtaskListPanel from '@/features/cowork/components/subagents/SubtaskListPanel';
import {
  isActiveSubtask,
  type Subtask,
} from '@/features/cowork/components/subagents/subtaskPresentation';
import {
  selectCoworkConfig,
  selectCoworkSessions,
  selectCurrentSession,
  selectDraftBrowserAnnotations,
  selectIsOpenClawEngine,
  selectIsStreaming,
  selectSessionRuntimeActivity,
  selectSessionRunTimings,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import { setDraftBrowserRecording } from '@/features/cowork/coworkSlice';
import {
  addDraftBrowserAnnotation,
  clearCurrentSession,
  clearDraftBrowserAnnotations,
  type DraftAttachment,
  setCurrentSession,
  setDraftAttachments,
  setDraftPrompt,
  setPlanMode,
  setStreaming,
  updateSessionStatus,
} from '@/features/cowork/coworkSlice';
import type {
  CoworkAttachmentPayload,
  CoworkInteractionRequest,
  CoworkInteractionResult,
  CoworkSession,
  OpenClawEngineStatus,
} from '@/features/cowork/coworkTypes';
import {
  buildSessionExportFileName,
  createSessionExportDocument,
} from '@/features/cowork/sessionExport';
import {
  COWORK_SESSION_LIST_ACTION_EVENT,
  type CoworkSessionListActionDetail,
} from '@/features/cowork/sessionListActions';
import { clearActiveSkills } from '@/features/plugins/skills/skillSlice';
import type { SettingsOpenOptions } from '@/features/settings/Settings';
import type {
  ChatContextUsageSnapshot,
  RewindEditorDraft,
  SideChatResult,
  SideChatStreamUpdate,
} from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';
import { getGreetingPeriod, pickHomeGreeting } from '@/services/i18n/homeGreetings';
import Modal from '@/shared/components/common/Modal';
import BrainIcon from '@/shared/components/icons/BrainIcon';
import ComposeIcon from '@/shared/components/icons/ComposeIcon';
import FolderIcon from '@/shared/components/icons/FolderIcon';
import RightSidebarIcon from '@/shared/components/icons/RightSidebarIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import SidebarToggleIcon from '@/shared/components/icons/SidebarToggleIcon';
import { type RootState, store } from '@/store';
import { getCompactFolderName } from '@/utils/path';

import logoUrl from '../../../../../resources/logo.png';
import CollaborationPanel, {
  CollaborationMemberLinks,
  useCollaborationRooms,
} from './chat/CollaborationPanel';
import {
  bindSessionSubmissionRun,
  createSessionSubmission,
  getSessionStopOperationKey,
  type SessionSubmission,
  stopSessionSubmission,
} from './composer/sessionSubmission';

const DEBUG_COWORK_VIEW =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_COWORK_VIEW === 'true';

const CURRENT_SESSION_RUNNING_POLL_MS = 3_000;
const CURRENT_SESSION_IDLE_POLL_MS = 10_000;
const BACKGROUND_SESSION_POLL_MS = 30_000;
const BACKGROUND_DISCOVERY_POLL_MS = 60_000;
const HIDDEN_DISCOVERY_POLL_MS = 120_000;
const HIDDEN_WINDOW_POLL_MS = 60_000;
const BROWSER_DISPLAY_TAB_PREFIX = 'browser:';
const FILE_DISPLAY_TAB_PREFIX = 'file:';
const TERMINAL_DISPLAY_TAB_PREFIX = 'terminal:';
const PLAN_DISPLAY_TAB_ID = 'plan';
const SUBAGENT_DISPLAY_TAB_ID = 'subagent';
const COLLABORATION_DISPLAY_TAB_ID = 'collaboration';
const SIDE_CHAT_DISPLAY_TAB_PREFIX = 'side-chat:';
const MAX_BROWSER_TABS = 8;
const MAX_TERMINAL_TABS = 16;

const browserDisplayTabId = (targetId: string): string =>
  `${BROWSER_DISPLAY_TAB_PREFIX}${targetId}`;
const fileDisplayTabId = (filePath: string): string =>
  `${FILE_DISPLAY_TAB_PREFIX}${filePath.replace(/\\/g, '/')}`;

const getSystemTerminalLabel = (): string => {
  if (window.electron.platform === 'win32') {
    return i18nService.t('coworkOpenWindowsSystemTerminal');
  }
  if (window.electron.platform === 'darwin') {
    return i18nService.t('coworkOpenMacSystemTerminal');
  }
  return i18nService.t('coworkOpenSystemTerminal');
};
function resolveProgressCardRunState(
  card: ProgressCard,
  runtimeRunning: boolean,
  runTimings: readonly SessionRunTiming[],
): ProgressCardRunState {
  const matchingRun = [...runTimings]
    .sort((left, right) => right.startedAt - left.startedAt)
    .find(
      timing =>
        card.updatedAt >= timing.startedAt &&
        (timing.endedAt === undefined || card.updatedAt <= timing.endedAt),
    );
  if (!matchingRun) return runtimeRunning ? 'running' : 'idle';
  if (matchingRun.state === 'running') return runtimeRunning ? 'running' : 'idle';
  return matchingRun.state;
}

function debugLog(...args: unknown[]): void {
  if (DEBUG_COWORK_VIEW) {
    console.debug(...args);
  }
}

export interface CoworkViewProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  isQuestionInputBlocked?: boolean;
  inputBlockedMessage?: string;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  planInteraction?: CoworkInteractionRequest | null;
  onPlanRespond?: (result: CoworkInteractionResult) => Promise<boolean>;
}

export interface CoworkViewHandle {
  requestFilePreviewTransition: (options?: FilePreviewNavigationOptions) => Promise<boolean>;
}

// Keep the last greeting across home view remounts in this app session.
let lastHomeGreeting: string | undefined;

type SessionTranscriptMutation = {
  kind: 'copy' | 'fork' | 'message';
  sessionId: string;
};

type PendingMessageHistoryAction = {
  action: 'edit' | 'withdraw';
  entryId: string;
  sourceSessionId: string;
  confirmationKey: string;
  editedText?: string;
};

function restoredDraftAttachments(draft: RewindEditorDraft): DraftAttachment[] {
  const restoredAt = Date.now();
  const inline = draft.attachments.map((attachment, index) => ({
    path: `inline:${attachment.name}:reedit-${restoredAt}-${index}`,
    name: attachment.name,
    isImage: attachment.mimeType.startsWith('image/'),
    dataUrl: `data:${attachment.mimeType};base64,${attachment.base64Data}`,
  }));
  const paths = draft.filePaths.map(filePath => {
    const pathParts = filePath.split(/[\\/]/u).filter(Boolean);
    const name = pathParts[pathParts.length - 1] ?? filePath;
    return {
      path: filePath,
      name,
      isImage: /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu.test(filePath),
    };
  });
  return [...inline, ...paths];
}

const CoworkView = forwardRef<CoworkViewHandle, CoworkViewProps>((props, ref) => {
  const {
    onRequestAppSettings,
    isQuestionInputBlocked = false,
    inputBlockedMessage,
    isSidebarCollapsed,
    onToggleSidebar,
    onNewChat,
    planInteraction = null,
    onPlanRespond,
  } = props;
  const dispatch = useDispatch();
  const currentSession = useSelector(selectCurrentSession);
  const currentSessionId = currentSession?.id ?? null;
  const collaborationRooms = useCollaborationRooms({
    activeSessionId: currentSessionId,
    onFirstCollaboration: sessionId => {
      setCollaborationSessionId(sessionId);
      setCollaborationMemberId(undefined);
      setPreferredDisplayTabId(COLLABORATION_DISPLAY_TAB_ID);
      setIsDisplayPanelOpen(true);
      setIsWorkspaceFilesOpen(false);
    },
  });
  const sessions = useSelector(selectCoworkSessions);
  const config = useSelector(selectCoworkConfig);
  const [collaborationSessionId, setCollaborationSessionId] = useState<string | null>(null);
  const [collaborationMemberId, setCollaborationMemberId] = useState<string | undefined>();
  const [isInitialized, setIsInitialized] = useState(false);
  const [greetingPeriod, setGreetingPeriod] = useState(() =>
    getGreetingPeriod(new Date().getHours()),
  );
  const [greetingKey, setGreetingKey] = useState(() =>
    pickHomeGreeting(getGreetingPeriod(new Date().getHours()), lastHomeGreeting),
  );
  useEffect(() => {
    const timer = setInterval(
      () => setGreetingPeriod(getGreetingPeriod(new Date().getHours())),
      60_000,
    );
    return () => clearInterval(timer);
  }, []);
  const openClawStatusRef = useRef<OpenClawEngineStatus | null>(null);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [isSubtaskListOpen, setIsSubtaskListOpen] = useState(false);
  const {
    sessionKey: displaySessionKey,
    states: displayStates,
    state: {
      selectedSubagent,
      isDisplayPanelOpen,
      isBrowserPanelOpen,
      hasBrowserPanelOpened,
      browserPanelWidth,
      browserTabs,
      browserTabCreationSequence,
      terminalTabs,
      preferredDisplayTabId,
      sideChatTabs,
      isWorkspaceFilesOpen,
      filePreviews,
      unsupportedFilePreviews,
    },
    setters: {
      setSelectedSubagent,
      setIsDisplayPanelOpen,
      setIsBrowserPanelOpen,
      setHasBrowserPanelOpened,
      setBrowserPanelTargetId,
      setBrowserTabCreationSequence,
      setTerminalTabs,
      setPreferredDisplayTabId,
      setSideChatTabs,
      setIsWorkspaceFilesOpen,
      setFilePreviews,
      setUnsupportedFilePreviews,
    },
    setSessionField,
    openBrowserTab,
    promote: promoteDisplaySession,
  } = useSessionDisplayState(
    currentSessionId,
    BROWSER_PANEL_DEFAULT_WIDTH,
    config.maxRetainedDisplayTabs ?? DEFAULT_MAX_RETAINED_DISPLAY_TABS,
    isInitialized ? sessions.map(session => session.id) : undefined,
    sessions.filter(session => session.status === 'running').map(session => session.id),
  );
  const subtaskListToggleRef = useRef<HTMLButtonElement>(null);
  const displayPanelToggleRef = useRef<HTMLButtonElement>(null);
  const [planPreviewState, dispatchPlanPreview] = useReducer(
    planPreviewReducer,
    initialPlanPreviewState,
  );
  const [goalRunProgress, setGoalRunProgress] = useState<GoalRunProgress | null>(null);
  const [goalPresence, setGoalPresence] = useState<{
    sessionId: string | undefined;
    hasGoal: boolean;
  }>({ sessionId: undefined, hasGoal: false });
  const [contextUsage, setContextUsage] = useState<ChatContextUsageSnapshot | null>(null);
  const [progressCardState, setProgressCardState] = useState<ProgressCardViewState | null>(null);
  const [isSessionSearchOpen, setIsSessionSearchOpen] = useState(false);
  const [areProcessSummariesExpanded, setAreProcessSummariesExpanded] = useState(false);
  const [isSessionExportOpen, setIsSessionExportOpen] = useState(false);
  const [pendingSessionListAction, setPendingSessionListAction] =
    useState<CoworkSessionListActionDetail | null>(null);
  const [sessionTranscriptMutation, setSessionTranscriptMutation] =
    useState<SessionTranscriptMutation | null>(null);
  const [pendingMessageHistoryAction, setPendingMessageHistoryAction] =
    useState<PendingMessageHistoryAction | null>(null);
  const [pendingSourceReveal, setPendingSourceReveal] = useState<{
    sessionId: string;
    entryId: string;
  } | null>(null);
  const [sessionExportMessageCount, setSessionExportMessageCount] = useState(0);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [sessionSearchIgnoreCase, setSessionSearchIgnoreCase] = useState(true);
  const [sessionSearchMatchCount, setSessionSearchMatchCount] = useState(0);
  const [sessionSearchActiveIndex, setSessionSearchActiveIndex] = useState(-1);
  const [sessionSearchNavigation, setSessionSearchNavigation] = useState<{
    token: number;
    direction: 1 | -1;
  }>({ token: 0, direction: 1 });
  const sessionSearchInputRef = useRef<HTMLInputElement>(null);
  const sessionSearchPanelRef = useRef<HTMLDivElement>(null);
  const browserPanelRefs = useRef(new Map<string, BrowserPanelHandle>());
  const [browserAgentPanelStates, setBrowserAgentPanelStates] = useState(
    () => new Map<string, Map<string, BrowserAgentInteractionState>>(),
  );
  const pendingBrowserAgentPanelStatesRef = useRef(
    new Map<string, PendingBrowserAgentPanelState>(),
  );
  const pendingBrowserTabsRef = useRef(
    new Map<
      string,
      Array<{
        url?: string;
        sourceFilePath?: string;
        sourcePreviewUrl?: string;
        sourceRootPath?: string;
        sourcePreviewRootUrl?: string;
      }>
    >(),
  );
  const availableAgentBrowserSessionIdsRef = useRef<string[]>([]);
  availableAgentBrowserSessionIdsRef.current = sessions.map(session => session.id);
  const promotePendingBrowserTabs = useCallback((fromSessionKey: string, toSessionKey: string) => {
    promotePendingBrowserPanelItems(
      pendingBrowserTabsRef.current,
      fromSessionKey,
      toSessionKey,
      MAX_BROWSER_TABS,
    );
  }, []);
  const terminalSequenceRef = useRef(0);
  const sideChatSequenceRef = useRef(0);
  const sideChatTabsRef = useRef(sideChatTabs);
  sideChatTabsRef.current = sideChatTabs;
  const filePreviewDrawerRefs = useRef(new Map<string, FilePreviewDrawerHandle>());
  const filePreviewsRef = useRef(filePreviews);
  filePreviewsRef.current = filePreviews;
  const unsupportedFilePreviewsRef = useRef(unsupportedFilePreviews);
  unsupportedFilePreviewsRef.current = unsupportedFilePreviews;
  const filePreviewRequestIdRef = useRef(0);
  const sessionTranscriptMutationRef = useRef<SessionTranscriptMutation | null>(null);
  // Track if we're starting a session to prevent duplicate submissions
  const isStartingRef = useRef(false);
  // Track pending start request so stop can cancel delayed startup.
  const pendingStartRef = useRef<{
    requestId: number;
    cancelled: boolean;
    cancellationAction: 'stop' | 'delete' | null;
    settled: Promise<boolean>;
    temporarySessionId?: string;
    canonicalSessionId?: string;
    clientTurnId?: string;
  } | null>(null);
  const startRequestIdRef = useRef(0);
  // Ref for CoworkPromptInput
  const promptInputRef = useRef<CoworkPromptInputRef>(null);
  // Ref for JustDoChatWrapper (to call sendMessage)
  const chatWrapperRef = useRef<JustDoChatWrapperRef>(null);
  const pendingMessageSubmissionsRef = useRef(new Map<string, SessionSubmission>());
  // Buffer for pending user message when JustDoChatWrapper isn't mounted yet
  const pendingPromptRef = useRef<string | null>(null);
  const pendingAttachmentsRef = useRef<CoworkAttachmentPayload[]>([]);
  const pendingGatewayPromptRef = useRef<string | undefined>(undefined);
  const pendingInitialGoalRef = useRef<{ sessionId: string; objective: string } | null>(null);

  const handleGoalPresenceChange = useCallback(
    (sessionId: string | undefined, hasGoal: boolean) => {
      setGoalPresence(current =>
        current.sessionId === sessionId && current.hasGoal === hasGoal
          ? current
          : { sessionId, hasGoal },
      );
    },
    [],
  );

  const retainedPlanInteraction = retainedPlanForSession(planPreviewState, currentSessionId);
  const visiblePlanInteraction = planInteraction ?? retainedPlanInteraction;
  const planPreviewReadOnly =
    visiblePlanInteraction !== null &&
    (planInteraction === null ||
      retainedPlanInteraction?.requestId === visiblePlanInteraction.requestId);
  const recordingReviewTabs = useRecordingReviewTabs(
    displaySessionKey,
    id => {
      setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(id);
    },
    () => setIsDisplayPanelOpen(true),
  );
  const availableDisplayTabIds = useMemo(
    () => [
      ...(isBrowserPanelOpen ? browserTabs.map(tab => browserDisplayTabId(tab.targetId)) : []),
      ...terminalTabs.map(tab => tab.id),
      ...filePreviews.map(preview => fileDisplayTabId(preview.filePath)),
      ...unsupportedFilePreviews.map(fileDisplayTabId),
      ...(visiblePlanInteraction ? [PLAN_DISPLAY_TAB_ID] : []),
      ...(selectedSubagent ? [SUBAGENT_DISPLAY_TAB_ID] : []),
      ...(collaborationSessionId && collaborationSessionId === currentSessionId
        ? [COLLABORATION_DISPLAY_TAB_ID]
        : []),
      ...sideChatTabs.map(tab => tab.id),
      ...recordingReviewTabs.tabs.map(tab => tab.id),
    ],
    [
      collaborationSessionId,
      currentSessionId,
      browserTabs,
      filePreviews,
      isBrowserPanelOpen,
      selectedSubagent,
      sideChatTabs,
      terminalTabs,
      unsupportedFilePreviews,
      visiblePlanInteraction,
      recordingReviewTabs.tabs,
    ],
  );
  const activeDisplayTabId =
    preferredDisplayTabId && availableDisplayTabIds.includes(preferredDisplayTabId)
      ? preferredDisplayTabId
      : (availableDisplayTabIds[availableDisplayTabIds.length - 1] ?? null);
  const activeFilePreview = filePreviews.find(
    preview => fileDisplayTabId(preview.filePath) === activeDisplayTabId,
  );
  const activeUnsupportedFilePath = unsupportedFilePreviews.find(
    filePath => fileDisplayTabId(filePath) === activeDisplayTabId,
  );
  const activeSideChatTab = sideChatTabs.find(tab => tab.id === activeDisplayTabId);
  const pendingPlanRequestId = planInteraction?.requestId ?? null;
  const pendingPlanSessionId = planInteraction?.sessionId ?? null;

  useEffect(
    () => () => {
      for (const tab of sideChatTabsRef.current) {
        dispatch(setDraftPrompt({ sessionId: tab.id, draft: '' }));
      }
    },
    [dispatch],
  );

  const selectAdjacentDisplayTabAfterClose = useCallback(
    (closingId: string) => {
      const adjacentId = getAdjacentDisplayTabId(availableDisplayTabIds, closingId);
      setPreferredDisplayTabId(current => (current === closingId ? adjacentId : current));
    },
    [availableDisplayTabIds, setPreferredDisplayTabId],
  );

  useEffect(() => {
    if (!pendingPlanRequestId || !pendingPlanSessionId) return;
    dispatchPlanPreview({ type: 'pending-shown', sessionId: pendingPlanSessionId });
    setIsWorkspaceFilesOpen(false);
    setPreferredDisplayTabId(PLAN_DISPLAY_TAB_ID);
    setIsDisplayPanelOpen(true);
  }, [
    pendingPlanRequestId,
    pendingPlanSessionId,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setPreferredDisplayTabId,
  ]);

  const handlePlanRespond = useCallback(
    async (result: CoworkInteractionResult): Promise<boolean> => {
      if (!planInteraction || !onPlanRespond) return false;
      const sessionId = planInteraction.sessionId;
      const retainForImplementation = result.behavior === 'plan' && result.decision === 'implement';
      if (retainForImplementation) {
        chatWrapperRef.current?.preparePlanImplementationReset({
          requestId: planInteraction.requestId,
          toolName: planInteraction.toolName,
          toolInput: planInteraction.toolInput,
        });
        dispatchPlanPreview({ type: 'implementation-started', interaction: planInteraction });
      }

      const success = await onPlanRespond(result);
      if (!success && retainForImplementation) {
        chatWrapperRef.current?.cancelPlanImplementationReset(planInteraction.requestId);
        dispatchPlanPreview({ type: 'pending-shown', sessionId });
      }
      if (success && !retainForImplementation) {
        dispatchPlanPreview({ type: 'resolved-without-implementation', sessionId });
      }
      return success;
    },
    [onPlanRespond, planInteraction],
  );
  const handleAddBrowserAnnotation = useCallback(
    (annotation: BrowserAnnotationDraft): boolean => {
      if (currentSessionId?.startsWith('temp-')) return false;
      const draftKey = currentSessionId ?? '__home__';
      const state = store.getState();
      const existing = selectDraftBrowserAnnotations(state, draftKey);
      const nextContextLength = serializeBrowserAnnotationContext([...existing, annotation]).length;
      const imageBytes = existing.reduce(
        (total, item) => total + browserAnnotationDataBytes(item.dataUrl),
        0,
      );
      if (
        existing.length >= BROWSER_ANNOTATION_MAX_COUNT ||
        nextContextLength > BROWSER_ANNOTATION_CONTEXT_MAX_LENGTH ||
        imageBytes + browserAnnotationDataBytes(annotation.dataUrl) >
          BROWSER_ANNOTATION_MAX_IMAGE_BYTES
      ) {
        return false;
      }
      dispatch(addDraftBrowserAnnotation({ draftKey, annotation }));
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return true;
    },
    [currentSessionId, dispatch],
  );
  useEffect(() => {
    if (currentSessionId) return;
    const next = pickHomeGreeting(getGreetingPeriod(new Date().getHours()), lastHomeGreeting);
    lastHomeGreeting = next;
    setGreetingKey(next);
  }, [currentSessionId, greetingPeriod]);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const isStreaming = useSelector(selectIsStreaming);
  const sessionRuntimeActivity = useSelector(selectSessionRuntimeActivity);
  const sessionRunTimings = useSelector(selectSessionRunTimings);
  useEffect(() => {
    if (!pendingSourceReveal || pendingSourceReveal.sessionId !== currentSessionId) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      void chatWrapperRef.current?.revealMessage(pendingSourceReveal.entryId).finally(() => {
        if (!cancelled) setPendingSourceReveal(null);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [currentSessionId, pendingSourceReveal]);
  useEffect(() => {
    for (const [sessionId, operation] of pendingMessageSubmissionsRef.current) {
      if (!operation.unknownMarked) continue;
      const timing = sessionRunTimings[sessionId]?.find(run => run.id === operation.receiptId);
      if (timing && timing.state !== 'running') {
        if (operation.sessionKey && operation.runId) {
          chatWrapperRef.current?.settleConfirmedRun(
            operation.sessionKey,
            operation.runId,
            timing.state,
          );
        }
        operation.unknown = false;
        if (!operation.stopping) pendingMessageSubmissionsRef.current.delete(sessionId);
      }
    }
  }, [sessionRunTimings]);
  const isOpenClawEngine = useSelector(selectIsOpenClawEngine);
  const agentState = useSelector((state: RootState) => state.agent);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const currentAgentId = MAIN_USER_AGENT_ID;
  const currentSessionRuntimeRunning = currentSession
    ? currentSession.id.startsWith('temp-')
      ? currentSession.status === 'running'
      : sessionRuntimeActivity[currentSession.id] === true
    : isStreaming;
  const currentSessionRuntimeRunningRef = useRef(currentSessionRuntimeRunning);
  currentSessionRuntimeRunningRef.current = currentSessionRuntimeRunning;
  const canonicalGatewaySessionKey = currentSession
    ? currentSession.external?.sessionKey ||
      `agent:${currentSession.agentId?.trim() || 'main'}:justdo:${currentSession.id}`
    : null;
  const [reportedGatewaySessionKey, setReportedGatewaySessionKey] = useState<{
    sessionId: string;
    sessionKey: string;
  } | null>(null);
  const currentGatewaySessionKey =
    reportedGatewaySessionKey?.sessionId === currentSessionId
      ? reportedGatewaySessionKey.sessionKey
      : canonicalGatewaySessionKey;
  const currentGatewaySessionKeyRef = useRef(currentGatewaySessionKey);
  currentGatewaySessionKeyRef.current = currentGatewaySessionKey;
  const handleGoalResumeAccepted = useCallback((sessionId: string, runId: string) => {
    if (currentSessionIdRef.current !== sessionId) return;
    const sessionKey = currentGatewaySessionKeyRef.current;
    if (sessionKey) chatWrapperRef.current?.beginGoalResume(sessionKey, runId);
  }, []);
  const progressCard =
    progressCardState?.sessionKey === currentGatewaySessionKey ? progressCardState.card : null;
  const currentSessionRunTimings = currentSession
    ? (sessionRunTimings[currentSession.id] ?? [])
    : [];
  const progressCardRunState = progressCard
    ? resolveProgressCardRunState(
        progressCard,
        currentSessionRuntimeRunning,
        currentSessionRunTimings,
      )
    : 'idle';
  const progressCardVisibility = useProgressCardVisibility(progressCard);
  const progressCardComplete = progressCard ? progressCardIsComplete(progressCard) : false;
  const progressCardPaused = Boolean(
    progressCard &&
    !progressCardComplete &&
    (progressCardRunState === 'completed' ||
      (progressCardRunState === 'idle' &&
        progressCard.steps?.some(step => step.status === 'in_progress'))),
  );
  const pendingInitialGoal = pendingInitialGoalRef.current;
  const initialGoalObjective =
    currentSessionRuntimeRunning &&
    pendingInitialGoal !== null &&
    pendingInitialGoal.sessionId === currentSession?.id
      ? pendingInitialGoal.objective
      : null;
  const backgroundSessionIdsKey = resolveBackgroundRuntimeSessionIds(
    sessions,
    currentSessionId,
    sessionRuntimeActivity,
  ).join('\n');
  const backgroundDiscoverySessionIdsKey = resolveBackgroundRuntimeDiscoverySessionIds(
    sessions,
    currentSessionId,
  ).join('\n');
  const currentSessionAgent = currentSession
    ? (agentState.agents.find(agent => agent.id === currentSession.agentId) ?? null)
    : null;
  const { selectedModel: sessionSelectedModel } = resolveAgentModelSelection({
    agentId: currentSession?.agentId ?? 'main',
    agentModel: currentSessionAgent?.model || '',
    sessionModel: currentSession?.modelRef,
    availableModels,
    fallbackModel: globalSelectedModel,
  });
  const assistantName =
    sessionSelectedModel?.name?.trim() ||
    sessionSelectedModel?.id?.trim() ||
    currentSessionAgent?.name?.trim() ||
    'Assistant';

  const buildApiConfigNotice = (
    error?: string,
  ): { noticeI18nKey: string; noticeExtra?: string } => {
    const key = 'coworkModelSettingsRequired';
    if (!error) {
      return { noticeI18nKey: key };
    }
    const normalizedError = error.trim();
    if (
      normalizedError.startsWith('No enabled provider found for model:') ||
      normalizedError === 'No available model configured in enabled providers.'
    ) {
      return { noticeI18nKey: key };
    }
    return { noticeI18nKey: key, noticeExtra: error };
  };

  const isOpenClawReadyForSession = (status: OpenClawEngineStatus | null): boolean => {
    if (!status) return false;
    return status.phase === 'running' || status.phase === 'ready';
  };

  const ensureOpenClawReadyForSubmit = (): boolean => {
    if (
      !isOpenClawEngine ||
      !openClawStatusRef.current ||
      isOpenClawReadyForSession(openClawStatusRef.current)
    ) {
      return true;
    }
    window.dispatchEvent(
      new CustomEvent('app:showToast', { detail: i18nService.t('coworkErrorEngineNotReady') }),
    );
    return false;
  };

  useEffect(() => {
    const init = async () => {
      await coworkService.init();
      const initialEngineStatus = await coworkService.getOpenClawEngineStatus();
      if (initialEngineStatus) {
        openClawStatusRef.current = initialEngineStatus;
      }
      setIsInitialized(true);
    };
    init();

    const unsubscribeOpenClawStatus = coworkService.onOpenClawEngineStatus(status => {
      openClawStatusRef.current = status;
    });

    return () => {
      unsubscribeOpenClawStatus();
    };
  }, [dispatch]);

  const handleStartSession = async (
    prompt: string,
    attachments?: CoworkAttachmentPayload[],
    gatewayPrompt?: string,
  ): Promise<boolean | void> => {
    if (!ensureOpenClawReadyForSubmit()) return false;
    // Prevent duplicate submissions
    if (isStartingRef.current) return false;
    isStartingRef.current = true;
    const requestId = ++startRequestIdRef.current;
    let resolveStartSettled!: (stopped: boolean) => void;
    const settled = new Promise<boolean>(resolve => {
      resolveStartSettled = resolve;
    });
    let cancelledStartStopped = false;
    pendingStartRef.current = { requestId, cancelled: false, cancellationAction: null, settled };
    const isPendingStartCancelled = () => {
      const pending = pendingStartRef.current;
      return !pending || pending.requestId !== requestId || pending.cancelled;
    };
    const getPendingCancellationAction = () => {
      const pending = pendingStartRef.current;
      if (!pending || pending.requestId !== requestId || !pending.cancelled) {
        return null;
      }
      return pending.cancellationAction;
    };

    try {
      try {
        const apiConfig = await coworkService.checkApiConfig();
        if (apiConfig && !apiConfig.hasConfig) {
          onRequestAppSettings?.({
            initialTab: 'model',
            ...buildApiConfigNotice(apiConfig.error),
          });
          isStartingRef.current = false;
          return false;
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }

      // Create a temporary session with user message to show immediately
      const startInPlanMode = store.getState().cowork.newSessionPlanMode;
      const tempSessionId = `temp-${Date.now()}`;
      if (pendingStartRef.current?.requestId === requestId)
        pendingStartRef.current.temporarySessionId = tempSessionId;
      const titleInput = getMessageTitleInput(prompt, attachments, gatewayPrompt);
      const fallbackTitle = titleInput.split('\n')[0].slice(0, 50) || i18nService.t('coworkAttachmentSession');
      const now = Date.now();
      const clientTurnId = `justdo-${now}-${crypto.randomUUID()}`;
      if (pendingStartRef.current?.requestId === requestId) {
        pendingStartRef.current.clientTurnId = clientTurnId;
      }

      // Capture active skill IDs before clearing them
      const sessionSkillIds = [...activeSkillIds];

      const initialGoal = inferInitialGoalObjective(prompt, true);
      pendingInitialGoalRef.current = initialGoal
        ? { sessionId: tempSessionId, objective: initialGoal }
        : null;
      const tempSession: CoworkSession = {
        id: tempSessionId,
        title: fallbackTitle,
        status: 'running',
        pinned: false,
        createdAt: now,
        updatedAt: now,
        cwd: config.workingDirectory || '',
        executionMode: config.executionMode || 'local',
        permissionMode: config.permissionMode,
        activeSkillIds: sessionSkillIds,
        agentId: currentAgentId,
      };

      // Immediately show the session detail page with user message
      promoteDisplaySession(HOME_DISPLAY_SESSION_KEY, tempSessionId);
      promoteBrowserPanelTabs(HOME_DISPLAY_SESSION_KEY, tempSessionId);
      browserPanelRefs.current.forEach(panel =>
        panel.promoteRecordingSession(HOME_DISPLAY_SESSION_KEY, tempSessionId),
      );
      promotePendingBrowserTabs(HOME_DISPLAY_SESSION_KEY, tempSessionId);
      dispatch(setCurrentSession(tempSession));
      dispatch(setPlanMode({ sessionId: tempSessionId, enabled: startInPlanMode }));
      dispatch(setStreaming(true));

      // Buffer the pending user message until the temporary session render has
      // switched the ChatController. Applying it synchronously here can still
      // target the previously selected, running session.
      pendingPromptRef.current = prompt;
      pendingAttachmentsRef.current = attachments ?? [];
      pendingGatewayPromptRef.current = gatewayPrompt;
      debugLog('[CoworkView] handleStartSession:', {
        prompt: prompt.slice(0, 60),
        wrapperRefExists: !!chatWrapperRef.current,
        tempSessionId: tempSessionId,
      });

      // Clear active skills after starting so they don't persist to the next session.
      dispatch(clearActiveSkills());

      // Start the actual session immediately with fallback title
      const {
        session: startedSession,
        error: startError,
        cancelled: startCancelled,
        acceptedRunId,
      } = await coworkService.startSession(
        {
          prompt,
          gatewayPrompt,
          title: fallbackTitle,
          cwd: config.workingDirectory || undefined,
          activeSkillIds: sessionSkillIds,
          agentId: currentAgentId,
          attachments,
          clientTurnId,
          startedAt: now,
          planMode: startInPlanMode,
        },
        {
          beforeSessionSelected: session => {
            if (pendingStartRef.current?.requestId === requestId)
              pendingStartRef.current.canonicalSessionId = session.id;
            promoteDisplaySession(tempSessionId, session.id);
            promoteBrowserPanelTabs(tempSessionId, session.id);
            browserPanelRefs.current.forEach(panel =>
              panel.promoteRecordingSession(tempSessionId, session.id),
            );
            promotePendingBrowserTabs(tempSessionId, session.id);
            const sourceAgentId = currentAgentId?.trim() || 'main';
            const targetAgentId = session.agentId?.trim() || sourceAgentId;
            chatWrapperRef.current?.registerSessionPromotion(
              `agent:${sourceAgentId}:justdo:${tempSessionId}`,
              `agent:${targetAgentId}:justdo:${session.id}`,
            );
          },
        },
      );

      if (!startedSession && (startError || startCancelled)) {
        dispatch(updateSessionStatus({ sessionId: tempSessionId, status: startCancelled ? 'idle' : 'error' }));
        chatWrapperRef.current?.clearSending(
          `agent:${currentAgentId?.trim() || 'main'}:justdo:${tempSessionId}`,
        );
        if (startCancelled && store.getState().cowork.currentSession?.id === tempSessionId) {
          pendingPromptRef.current = null;
          pendingAttachmentsRef.current = [];
          pendingGatewayPromptRef.current = undefined;
          // No canonical session was created. The unchanged home draft remains
          // available because this submission returns false to the composer.
          dispatch(clearCurrentSession());
        }
        cancelledStartStopped = true;
        return false;
      }

      // Generate title in the background and update when ready
      if (startedSession && titleInput) {
        coworkService
          .generateSessionTitle(titleInput, startedSession.id)
          .then(generatedTitle => {
            const betterTitle = generatedTitle?.trim();
            if (betterTitle && betterTitle !== fallbackTitle) {
              coworkService.renameSession(startedSession.id, betterTitle);
            }
          })
          .catch(error => {
            console.error('Failed to generate cowork session title:', error);
          });
      }

      // Stop immediately if user cancelled while startup request was in flight.
      if (isPendingStartCancelled() && startedSession) {
        cancelledStartStopped = await coworkService.stopSession(startedSession.id);
        if (cancelledStartStopped) {
          const sessionKey = `agent:${startedSession.agentId?.trim() || 'main'}:justdo:${startedSession.id}`;
          chatWrapperRef.current?.settleConfirmedRun(sessionKey, acceptedRunId ?? clientTurnId, 'aborted');
          chatWrapperRef.current?.clearSending(sessionKey, null);
        }
        if (getPendingCancellationAction() === 'delete') {
          await coworkService.deleteSession(startedSession.id);
        }
      }
      return Boolean(startedSession);
    } finally {
      resolveStartSettled(cancelledStartStopped);
      if (pendingStartRef.current?.requestId === requestId) {
        pendingStartRef.current = null;
      }
      isStartingRef.current = false;
    }
  };

  const handleStopSession = async () => {
    if (!currentSession) return false;
    if (currentSession.id.startsWith('temp-') && pendingStartRef.current) {
      const pendingStart = pendingStartRef.current;
      pendingStart.cancelled = true;
      pendingStart.cancellationAction = 'stop';
      // Main knows the canonical session before chat.send acknowledges it. Send
      // cancellation by operation identity even if that acknowledgement is lost.
      if (!pendingStart.clientTurnId) return pendingStart.settled;
      return coworkService.cancelSessionStart(pendingStart.clientTurnId);
    }
    const targetSessionKey = currentGatewaySessionKey;
    const targetSendingRunId = chatWrapperRef.current?.getSendingRunId() ?? null;
    const timings = sessionRunTimings[currentSession.id];
    const timing = timings?.[timings.length - 1];
    const targetRunId =
      targetSendingRunId ??
      (timing?.state === 'running' ? timing.rootRunId ?? timing.clientTurnId : null);
    const pendingSubmission = pendingMessageSubmissionsRef.current.get(currentSession.id);
    if (pendingSubmission?.unknown && pendingSubmission.receiptId) {
      pendingSubmission.cancelled = true;
      await coworkService.markSessionRunUnknown({
        sessionId: currentSession.id,
        id: pendingSubmission.receiptId,
        cancelled: true,
      });
      pendingSubmission.unknownMarked = true;
    }
    const stopping = stopSessionSubmission(pendingSubmission, async () => {
      const results = await Promise.allSettled([
        coworkService.stopSession(currentSession.id),
        targetSessionKey
          ? chatWrapperRef.current?.cancelManualCompaction(targetSessionKey)
          : undefined,
      ]);
      return (
        results[0].status === 'fulfilled' &&
        results[0].value === true &&
        results[1].status === 'fulfilled'
      );
    });
    // The UI has a bounded wait, while admission cancellation can finish later.
    // Retain its fence and apply its eventual receipt even after that UI wait.
    void (pendingSubmission?.stopCompletion ?? stopping).then(stopped => {
      if (
        pendingSubmission &&
        !pendingSubmission.stopping &&
        !pendingSubmission.unknown &&
        pendingMessageSubmissionsRef.current.get(currentSession.id) === pendingSubmission
      ) {
        pendingMessageSubmissionsRef.current.delete(currentSession.id);
      }
      if (stopped && targetSessionKey) {
        // Admission can bind a canonical run while Stop is waiting. Apply the
        // receipt to that operation only, even after navigating to another chat.
        const stoppedRunId = pendingSubmission?.runId ?? targetRunId;
        if (stoppedRunId) {
          chatWrapperRef.current?.settleConfirmedRun(targetSessionKey, stoppedRunId, 'aborted');
        }
        chatWrapperRef.current?.clearSending(targetSessionKey, targetSendingRunId);
      }
    });
    return stopping;
  };

  const handleSubtasksChange = useCallback(
    (nextSubtasks: Subtask[]) => {
      setSubtasks(nextSubtasks);
      setSelectedSubagent(current => {
        if (!current) return null;
        if (current.parentSessionId && current.parentSessionId !== currentSessionId) return current;
        return nextSubtasks.find(subtask => subtask.id === current.id) ?? null;
      });
    },
    [setSelectedSubagent, currentSessionId],
  );

  const closeSubtaskList = useCallback((restoreFocus = true) => {
    setIsSubtaskListOpen(false);
    if (restoreFocus) requestAnimationFrame(() => subtaskListToggleRef.current?.focus());
  }, []);

  const closeBrowserPanel = useCallback(() => {
    setIsBrowserPanelOpen(false);
    setPreferredDisplayTabId(current =>
      current?.startsWith(BROWSER_DISPLAY_TAB_PREFIX) ? null : current,
    );
    requestAnimationFrame(() => displayPanelToggleRef.current?.focus());
  }, [setIsBrowserPanelOpen, setPreferredDisplayTabId]);

  const handleBrowserTargetChange = useCallback(
    (targetId: string | null) => {
      setBrowserPanelTargetId(targetId);
      if (targetId) {
        setIsWorkspaceFilesOpen(false);
        setPreferredDisplayTabId(browserDisplayTabId(targetId));
      }
    },
    [setBrowserPanelTargetId, setIsWorkspaceFilesOpen, setPreferredDisplayTabId],
  );

  const openSubtask = useCallback(
    (subtask: Subtask, parentSessionId = currentSessionId ?? undefined) => {
      setSelectedSubagent({ ...subtask, parentSessionId });
      setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(SUBAGENT_DISPLAY_TAB_ID);
      setIsDisplayPanelOpen(true);
      setIsSubtaskListOpen(false);
    },
    [
      currentSessionId,
      setIsDisplayPanelOpen,
      setIsWorkspaceFilesOpen,
      setPreferredDisplayTabId,
      setSelectedSubagent,
    ],
  );

  const openDisplayPanel = useCallback(() => {
    setIsSubtaskListOpen(false);
    setIsDisplayPanelOpen(true);
  }, [setIsDisplayPanelOpen]);

  const closeDisplayPanel = useCallback(() => {
    setIsDisplayPanelOpen(false);
    setIsWorkspaceFilesOpen(false);
    requestAnimationFrame(() => displayPanelToggleRef.current?.focus());
  }, [setIsDisplayPanelOpen, setIsWorkspaceFilesOpen]);

  const activeSubtaskCount = subtasks.filter(subtask => isActiveSubtask(subtask.status)).length;

  useEffect(() => {
    const handleNewSession = () => onNewChat?.();
    window.addEventListener('cowork:shortcut:new-session', handleNewSession);
    return () => {
      window.removeEventListener('cowork:shortcut:new-session', handleNewSession);
    };
  }, [onNewChat]);

  useEffect(() => {
    if (!isOpenClawEngine) return;
    if (!currentSession || !currentSessionRuntimeRunning) return;

    const runningSessionId = currentSession.id;
    const handleWindowFocus = () => {
      void coworkService.loadSession(runningSessionId);
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [currentSession, currentSessionRuntimeRunning, isOpenClawEngine]);

  useEffect(() => {
    if (!currentSessionId || currentSessionId.startsWith('temp-')) return;
    let isCancelled = false;
    let timeoutId: number | null = null;
    let refreshInFlight = false;
    let requiresFullScan = true;
    const getNextDelay = () => {
      if (document.hidden) return HIDDEN_WINDOW_POLL_MS;
      return currentSessionRuntimeRunningRef.current
        ? CURRENT_SESSION_RUNNING_POLL_MS
        : CURRENT_SESSION_IDLE_POLL_MS;
    };
    const scheduleNextRefresh = () => {
      if (isCancelled) return;
      timeoutId = window.setTimeout(refresh, getNextDelay());
    };
    const refresh = () => {
      if (isCancelled || refreshInFlight) return;
      refreshInFlight = true;
      void coworkService
        .refreshSessionRuntimeActivity(currentSessionId, {
          includeSubagents: true,
          fullScan: requiresFullScan,
        })
        .then(status => {
          if (status) requiresFullScan = shouldContinueFullRuntimeScan(status);
        })
        .finally(() => {
          refreshInFlight = false;
          scheduleNextRefresh();
        });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        timeoutId = null;
        refresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    refresh();
    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [currentSessionId]);

  useEffect(() => {
    const sessionIds = backgroundSessionIdsKey ? backgroundSessionIdsKey.split('\n') : [];
    if (sessionIds.length === 0) return;
    let isCancelled = false;
    let timeoutId: number | null = null;
    let refreshInFlight = false;
    const refresh = () => {
      if (isCancelled || refreshInFlight) return;
      refreshInFlight = true;
      void coworkService.refreshSessionRuntimeActivities(sessionIds).finally(() => {
        refreshInFlight = false;
        if (isCancelled) return;
        timeoutId = window.setTimeout(
          refresh,
          document.hidden ? HIDDEN_WINDOW_POLL_MS : BACKGROUND_SESSION_POLL_MS,
        );
      });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        timeoutId = null;
        refresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    refresh();
    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [backgroundSessionIdsKey]);

  useEffect(() => {
    const sessionIds = backgroundDiscoverySessionIdsKey
      ? backgroundDiscoverySessionIdsKey.split('\n')
      : [];
    if (sessionIds.length === 0) return;
    let isCancelled = false;
    let timeoutId: number | null = null;
    let refreshInFlight = false;
    const refresh = () => {
      if (isCancelled || refreshInFlight) return;
      refreshInFlight = true;
      void coworkService
        .refreshSessionRuntimeActivities(sessionIds, { fullScan: true })
        .finally(() => {
          refreshInFlight = false;
          if (isCancelled) return;
          timeoutId = window.setTimeout(
            refresh,
            document.hidden ? HIDDEN_DISCOVERY_POLL_MS : BACKGROUND_DISCOVERY_POLL_MS,
          );
        });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        timeoutId = null;
        refresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    refresh();
    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [backgroundDiscoverySessionIdsKey]);

  useEffect(() => {
    setGoalRunProgress(null);
  }, [currentSession?.id]);

  const requestFilePreviewTransition = useCallback(
    async (options?: FilePreviewNavigationOptions): Promise<boolean> => {
      for (const drawer of filePreviewDrawerRefs.current.values()) {
        if (!(await drawer.requestTransition())) return false;
      }
      if (options?.preserveTabs) return true;
      filePreviewRequestIdRef.current += 1;
      setFilePreviews([]);
      setUnsupportedFilePreviews([]);
      setPreferredDisplayTabId(current =>
        current?.startsWith(FILE_DISPLAY_TAB_PREFIX) ? null : current,
      );
      return true;
    },
    [setFilePreviews, setPreferredDisplayTabId, setUnsupportedFilePreviews],
  );

  const closeFilePreview = useCallback(
    async (filePath: string): Promise<boolean> => {
      const tabId = fileDisplayTabId(filePath);
      const canClose =
        (await filePreviewDrawerRefs.current.get(tabId)?.requestTransition()) ?? true;
      if (!canClose) return false;
      setFilePreviews(current => current.filter(preview => preview.filePath !== filePath));
      selectAdjacentDisplayTabAfterClose(tabId);
      return true;
    },
    [selectAdjacentDisplayTabAfterClose, setFilePreviews],
  );

  const closeUnsupportedFilePreview = useCallback(
    (filePath: string): void => {
      const tabId = fileDisplayTabId(filePath);
      setUnsupportedFilePreviews(current => current.filter(path => path !== filePath));
      selectAdjacentDisplayTabAfterClose(tabId);
    },
    [selectAdjacentDisplayTabAfterClose, setUnsupportedFilePreviews],
  );

  useImperativeHandle(ref, () => ({ requestFilePreviewTransition }), [
    requestFilePreviewTransition,
  ]);

  useEffect(
    () => () => {
      filePreviewRequestIdRef.current += 1;
    },
    [],
  );

  useFilePreviewEvents({
    currentSessionIdRef,
    fileDisplayTabId,
    filePreviewRequestIdRef,
    filePreviewsRef,
    unsupportedFilePreviewsRef,
    setFilePreviews,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setPreferredDisplayTabId,
    setUnsupportedFilePreviews,
  });

  useEffect(() => {
    const handlePreviewPlan = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isCoworkPlanPreview(event.detail)) return;
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      const preview = event.detail;
      const interaction: CoworkInteractionRequest = {
        sessionId,
        requestId: `plan-preview:${preview.sourceId}`,
        toolName: OpenClawToolName.PRESENT_PLAN,
        interactionKind: CoworkInteractionKind.PLAN_APPROVAL,
        toolInput: {
          plan: preview.plan,
          ...(preview.title ? { title: preview.title } : {}),
        },
      };
      dispatchPlanPreview({ type: 'preview-opened', interaction });
      setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(PLAN_DISPLAY_TAB_ID);
      setIsDisplayPanelOpen(true);
    };
    window.addEventListener(COWORK_PLAN_PREVIEW_EVENT, handlePreviewPlan);
    return () => window.removeEventListener(COWORK_PLAN_PREVIEW_EVENT, handlePreviewPlan);
  }, [setIsDisplayPanelOpen, setIsWorkspaceFilesOpen, setPreferredDisplayTabId]);

  useEffect(() => {
    setIsSessionSearchOpen(false);
    setSessionSearchQuery('');
    setSessionSearchMatchCount(0);
    setSessionSearchActiveIndex(-1);
    setSessionSearchNavigation({ token: 0, direction: 1 });
    setAreProcessSummariesExpanded(false);
  }, [currentSession?.id]);

  useEffect(() => {
    if (!isSessionSearchOpen) return;
    requestAnimationFrame(() => {
      sessionSearchInputRef.current?.focus();
      sessionSearchInputRef.current?.select();
    });
  }, [isSessionSearchOpen]);

  useEffect(() => {
    if (!isSessionSearchOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sessionSearchPanelRef.current?.contains(target)) return;
      setIsSessionSearchOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSessionSearchOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSessionSearchOpen]);

  const handleSessionSearchMatchCountChange = useCallback((total: number, index: number) => {
    setSessionSearchMatchCount(total);
    setSessionSearchActiveIndex(index);
  }, []);

  const navigateSessionSearch = useCallback((direction: 1 | -1) => {
    setSessionSearchNavigation(current => ({
      token: current.token + 1,
      direction,
    }));
  }, []);

  const sessionSearchMatchCountText = i18nService
    .t('coworkSearchMatchCount')
    .replace('{current}', String(sessionSearchActiveIndex >= 0 ? sessionSearchActiveIndex + 1 : 0))
    .split('{total}')
    .join(String(sessionSearchMatchCount));

  const currentSessionFolderPath = currentSession?.cwd?.trim() || '';
  const currentSessionFolderName = currentSessionFolderPath
    ? getCompactFolderName(currentSessionFolderPath, 32)
    : '';
  const homeWorkspaceFolderPath = config.workingDirectory.trim();
  const workspaceFilesRootPath = currentSession
    ? currentSessionFolderPath
    : homeWorkspaceFolderPath;
  const terminalWorkingDirectory = currentSessionFolderPath || homeWorkspaceFolderPath;

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
  }, [browserTabCreationSequence, displayStates]);

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
    [setSessionField],
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
  }, [applyBrowserAgentPanelState, sessions]);

  useEffect(
    () => () => {
      for (const pending of pendingBrowserAgentPanelStatesRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingBrowserAgentPanelStatesRef.current.clear();
    },
    [],
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
    displaySessionKey,
    handleBrowserTargetChange,
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

  const handleCreateTerminalTab = useCallback(() => {
    if (terminalTabs.length >= MAX_TERMINAL_TABS) return;
    if (!terminalWorkingDirectory) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('coworkTerminalCreateFailed'),
        }),
      );
      return;
    }
    terminalSequenceRef.current += 1;
    const number = terminalSequenceRef.current;
    const id = `${TERMINAL_DISPLAY_TAB_PREFIX}${crypto.randomUUID()}`;
    setTerminalTabs(current => [
      ...current,
      {
        id,
        cwd: terminalWorkingDirectory,
        label: i18nService.t('coworkTerminalTitle').replace('{number}', String(number)),
      },
    ]);
    setPreferredDisplayTabId(id);
    setIsWorkspaceFilesOpen(false);
    setIsDisplayPanelOpen(true);
  }, [
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setPreferredDisplayTabId,
    setTerminalTabs,
    terminalTabs.length,
    terminalWorkingDirectory,
  ]);

  const handleCreateSideChat = useCallback(() => {
    if (!currentSessionId || currentSessionId.startsWith('temp-') || !isOpenClawEngine) return;
    sideChatSequenceRef.current += 1;
    const number = sideChatSequenceRef.current;
    const id = `${SIDE_CHAT_DISPLAY_TAB_PREFIX}${crypto.randomUUID()}`;
    setSideChatTabs(current => [
      ...current,
      {
        id,
        label: i18nService.t('sideChatTabTitle').replace('{number}', String(number)),
        messages: [],
        sessionId: currentSessionId,
      },
    ]);
    setPreferredDisplayTabId(id);
    setIsDisplayPanelOpen(true);
  }, [
    currentSessionId,
    isOpenClawEngine,
    setIsDisplayPanelOpen,
    setPreferredDisplayTabId,
    setSideChatTabs,
  ]);

  const closeSideChat = useCallback(
    (tabId: string) => {
      dispatch(setDraftPrompt({ sessionId: tabId, draft: '' }));
      selectAdjacentDisplayTabAfterClose(tabId);
      setSideChatTabs(current => current.filter(tab => tab.id !== tabId));
    },
    [dispatch, selectAdjacentDisplayTabAfterClose, setSideChatTabs],
  );

  const handleSideChatResult = useCallback(
    (result: SideChatResult) => {
      setSideChatTabs(current =>
        current.map(tab => {
          const index = tab.messages.findIndex(message => message.runId === result.runId);
          if (index < 0) return tab;
          const messages = [...tab.messages];
          const previousMessage = messages[index];
          messages[index] = {
            ...previousMessage,
            runId: result.runId,
            question: result.question,
            answer: result.text || i18nService.t('sideChatRunInterrupted'),
            activeTurn: undefined,
            answeredAt: previousMessage.activeTurn?.endedAt ?? Date.now(),
            modelRef: previousMessage.activeTurn?.modelRef ?? previousMessage.modelRef,
            startedAt: previousMessage.activeTurn?.startedAt ?? previousMessage.startedAt,
            status: result.isError ? 'error' : 'complete',
          };
          return { ...tab, messages };
        }),
      );
    },
    [setSideChatTabs],
  );

  const handleSideChatStream = useCallback(
    (update: SideChatStreamUpdate) => {
      setSideChatTabs(current =>
        current.map(tab => {
          const index = tab.messages.findIndex(message => message.runId === update.runId);
          if (index < 0) return tab;
          const messages = [...tab.messages];
          messages[index] = {
            ...messages[index],
            activeTurn: update.turn ?? undefined,
            modelRef: update.turn?.modelRef ?? messages[index].modelRef,
            startedAt: update.turn?.startedAt ?? messages[index].startedAt,
          };
          return { ...tab, messages };
        }),
      );
    },
    [setSideChatTabs],
  );

  const handleSendSideChat = useCallback(
    async (tabId: string, question: string, modelRef?: string | null): Promise<boolean> => {
      const normalizedQuestion = question.trim().replace(/\s*[\r\n]+\s*/g, ' ');
      if (!normalizedQuestion) return false;
      const runId = `justdo-btw-${Date.now()}-${crypto.randomUUID()}`;
      setSideChatTabs(current =>
        current.map(tab =>
          tab.id === tabId
            ? {
                ...tab,
                messages: [
                  ...tab.messages,
                  {
                    runId,
                    question: normalizedQuestion,
                    askedAt: Date.now(),
                    ...(modelRef ? { modelRef } : {}),
                    status: 'pending',
                  },
                ],
              }
            : tab,
        ),
      );
      try {
        const acceptedRunId = await chatWrapperRef.current?.sendSideQuestion(
          normalizedQuestion,
          runId,
        );
        if (!acceptedRunId) throw new Error('Chat controller is not ready');
        if (acceptedRunId !== runId) {
          setSideChatTabs(current =>
            current.map(tab =>
              tab.id === tabId
                ? {
                    ...tab,
                    messages: tab.messages.map(message =>
                      message.runId === runId ? { ...message, runId: acceptedRunId } : message,
                    ),
                  }
                : tab,
            ),
          );
        }
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setSideChatTabs(current =>
          current.map(tab =>
            tab.id === tabId
              ? {
                  ...tab,
                  messages: tab.messages.map(message =>
                    message.runId === runId
                      ? {
                          ...message,
                          answer: i18nService.t('sideChatSendFailed').replace('{error}', detail),
                          activeTurn: undefined,
                          answeredAt: Date.now(),
                          status: 'error',
                        }
                      : message,
                  ),
                }
              : tab,
          ),
        );
        return false;
      }
    },
    [setSideChatTabs],
  );

  const handleOpenWorkspaceFiles = useCallback(() => {
    if (!workspaceFilesRootPath || currentSessionId?.startsWith('temp-')) return;
    setIsWorkspaceFilesOpen(current => !current);
    setIsSubtaskListOpen(false);
    setIsDisplayPanelOpen(true);
  }, [currentSessionId, setIsDisplayPanelOpen, setIsWorkspaceFilesOpen, workspaceFilesRootPath]);

  useEffect(() => {
    if (!workspaceFilesRootPath) setIsWorkspaceFilesOpen(false);
  }, [setIsWorkspaceFilesOpen, workspaceFilesRootPath]);

  useEffect(() => {
    const handleTerminalShortcut = () => handleCreateTerminalTab();
    const handleBrowserShortcut = () => handleCreateBrowserTab();
    const handleSideChatShortcut = () => handleCreateSideChat();
    const handleFilesShortcut = () => handleOpenWorkspaceFiles();
    window.addEventListener('cowork:shortcut:terminal', handleTerminalShortcut);
    window.addEventListener('cowork:shortcut:browser', handleBrowserShortcut);
    window.addEventListener('cowork:shortcut:side-chat', handleSideChatShortcut);
    window.addEventListener('cowork:shortcut:files', handleFilesShortcut);
    return () => {
      window.removeEventListener('cowork:shortcut:terminal', handleTerminalShortcut);
      window.removeEventListener('cowork:shortcut:browser', handleBrowserShortcut);
      window.removeEventListener('cowork:shortcut:side-chat', handleSideChatShortcut);
      window.removeEventListener('cowork:shortcut:files', handleFilesShortcut);
    };
  }, [
    handleCreateBrowserTab,
    handleCreateSideChat,
    handleCreateTerminalTab,
    handleOpenWorkspaceFiles,
  ]);

  const closeTerminalTab = useCallback(
    (id: string) => {
      setTerminalTabs(current => current.filter(tab => tab.id !== id));
      selectAdjacentDisplayTabAfterClose(id);
    },
    [selectAdjacentDisplayTabAfterClose, setTerminalTabs],
  );

  const handleOpenSystemTerminal = useCallback(async (cwd: string) => {
    try {
      const result = await window.electron.openclaw.engine.openTerminal(cwd);
      if (result.success) return;
      console.warn('[CoworkView] Failed to open system terminal:', result.error);
    } catch (error) {
      console.error('[CoworkView] Failed to open system terminal:', error);
    }
    window.dispatchEvent(
      new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkOpenSystemTerminalFailed'),
      }),
    );
  }, []);

  const handleOpenCurrentSessionFolder = useCallback(async () => {
    if (!currentSessionFolderPath) return;
    try {
      const result = await window.electron.shell.openPath(currentSessionFolderPath);
      if (!result.success) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: result.error || i18nService.t('coworkOpenFolderFailed'),
          }),
        );
      }
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: error instanceof Error ? error.message : i18nService.t('coworkOpenFolderFailed'),
        }),
      );
    }
  }, [currentSessionFolderPath]);

  // Apply pending prompt to ChatController once the wrapper is mounted
  useEffect(() => {
    if (pendingPromptRef.current === null || !chatWrapperRef.current) return;
    debugLog(
      '[CoworkView] useEffect applying pendingPrompt:',
      pendingPromptRef.current.slice(0, 60),
    );
    chatWrapperRef.current.setPendingUserMessage(
      pendingPromptRef.current,
      pendingAttachmentsRef.current,
      pendingGatewayPromptRef.current,
    );
    pendingPromptRef.current = null;
    pendingAttachmentsRef.current = [];
    pendingGatewayPromptRef.current = undefined;
  });

  useEffect(() => {
    const handleSessionListAction = (event: Event) => {
      const detail = (event as CustomEvent<CoworkSessionListActionDetail>).detail;
      if (!detail?.sessionId || !['copy', 'export', 'collaboration'].includes(detail.action))
        return;
      setPendingSessionListAction(detail);
    };
    window.addEventListener(COWORK_SESSION_LIST_ACTION_EVENT, handleSessionListAction);
    return () => {
      window.removeEventListener(COWORK_SESSION_LIST_ACTION_EVENT, handleSessionListAction);
    };
  }, []);

  useEffect(() => {
    if (!pendingSessionListAction) return;
    if (currentSession?.id !== pendingSessionListAction.sessionId) {
      setPendingSessionListAction(null);
      return;
    }
    if (pendingSessionListAction.action === 'collaboration') {
      if (!currentSession.external) {
        setCollaborationSessionId(currentSession.id);
        const requestedMemberId = pendingSessionListAction.memberSessionId;
        const room = collaborationRooms.find(item => item.anchorSessionId === currentSession.id);
        setCollaborationMemberId(
          room?.members.some(member => member.sessionId === requestedMemberId)
            ? requestedMemberId
            : undefined,
        );
        setPreferredDisplayTabId(COLLABORATION_DISPLAY_TAB_ID);
        setIsDisplayPanelOpen(true);
        setIsWorkspaceFilesOpen(false);
      }
      setPendingSessionListAction(null);
      return;
    }
    if (
      currentSessionRuntimeRunning ||
      collaborationRooms
        .find(room => room.anchorSessionId === currentSession.id)
        ?.members.some(member =>
          sessions.some(session => session.id === member.sessionId && session.status === 'running'),
        )
    ) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t(
            pendingSessionListAction.action === 'export'
              ? 'coworkExportWaitForCompletion'
              : 'coworkCopyWaitForCompletion',
          ),
        }),
      );
      setPendingSessionListAction(null);
      return;
    }

    if (pendingSessionListAction.action === 'copy') {
      if (sessionTranscriptMutationRef.current) return;
      const operation = { kind: 'copy' as const, sessionId: currentSession.id };
      setPendingSessionListAction(null);
      sessionTranscriptMutationRef.current = operation;
      setSessionTranscriptMutation(operation);
      void coworkService
        .copySession(currentSession)
        .then(copied => {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t(
                copied ? 'coworkCopySessionSuccess' : 'coworkCopySessionFailed',
              ),
            }),
          );
        })
        .finally(() => {
          if (sessionTranscriptMutationRef.current === operation) {
            sessionTranscriptMutationRef.current = null;
            setSessionTranscriptMutation(null);
          }
        });
      return;
    }

    let attempts = 0;
    let settled = false;
    let timer: number | undefined;
    const openExportWhenReady = () => {
      if (settled) return;
      attempts += 1;
      if (currentSessionIdRef.current !== pendingSessionListAction.sessionId) {
        if (attempts >= 100) {
          settled = true;
          setPendingSessionListAction(null);
        }
        return;
      }
      const snapshot = chatWrapperRef.current?.getExportSnapshot();
      if (snapshot && snapshot.sessionKey === currentGatewaySessionKey && !snapshot.isLoading) {
        settled = true;
        setSessionExportMessageCount(snapshot.messages.length);
        setIsSessionExportOpen(true);
        setPendingSessionListAction(null);
        return;
      }
      if (attempts >= 100) {
        settled = true;
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkExportHistoryLoading'),
          }),
        );
        setPendingSessionListAction(null);
      }
    };
    openExportWhenReady();
    if (!settled) timer = window.setInterval(openExportWhenReady, 100);
    return () => {
      settled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [
    currentGatewaySessionKey,
    currentSession,
    currentSessionRuntimeRunning,
    pendingSessionListAction,
    collaborationRooms,
    sessions,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setPreferredDisplayTabId,
    sessionTranscriptMutation,
  ]);

  if (!isInitialized) {
    return (
      <div className="flex-1 h-full flex flex-col bg-background">
        <WindowHeader />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-secondary">{i18nService.t('loading')}</div>
        </div>
      </div>
    );
  }

  // Gateway lifecycle changes intentionally stay out of React state so a restart
  // cannot force the chat transcript and prompt tree to re-render.
  const isEngineReady = true;

  const windowHeader = <WindowHeader />;

  const homeConversationHeader = (
    <div className="cowork-workspace-header relative flex shrink-0 items-center justify-between border-b border-border px-2">
      <div className="non-draggable flex h-7 items-center">
        {isSidebarCollapsed && (
          <div className="mr-2 flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleSidebar}
              className="inline-flex h-7 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
            >
              <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
            </button>
            <button
              type="button"
              onClick={onNewChat}
              className="inline-flex h-7 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
            >
              <ComposeIcon className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <div className="non-draggable flex items-center gap-1">
        {!isDisplayPanelOpen && (
          <button
            ref={displayPanelToggleRef}
            type="button"
            onClick={openDisplayPanel}
            className="inline-flex h-7 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            title={i18nService.t('coworkDisplayPanelOpen')}
            aria-label={i18nService.t('coworkDisplayPanelOpen')}
            aria-expanded={false}
            aria-controls="cowork-display-panel"
          >
            <RightSidebarIcon className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
    </div>
  );

  const hasRetainedRuntimePanels = Object.values(displayStates).some(
    displayState => displayState.hasBrowserPanelOpened || displayState.terminalTabs.length > 0,
  );
  const retainedRuntimePanels = Object.entries(displayStates).flatMap(
    ([sessionKey, displayState]) => {
      const isActiveSession = sessionKey === displaySessionKey;
      const runtimeActiveTabId = isActiveSession ? activeDisplayTabId : null;
      const browserVisible = Boolean(
        isActiveSession &&
        displayState.isBrowserPanelOpen &&
        runtimeActiveTabId?.startsWith(BROWSER_DISPLAY_TAB_PREFIX),
      );
      return [
        ...(displayState.hasBrowserPanelOpened
          ? [
              <BrowserPanel
                ref={panel => {
                  if (panel) browserPanelRefs.current.set(sessionKey, panel);
                  else browserPanelRefs.current.delete(sessionKey);
                }}
                key={`browser-runtime:${displayState.runtimeId}`}
                draftKey={sessionKey}
                isOpen={isDisplayPanelOpen && browserVisible && !sessionKey.startsWith('temp-')}
                width={displayState.browserPanelWidth}
                activeTargetId={displayState.browserPanelTargetId}
                onClose={() => {
                  if (isActiveSession) closeBrowserPanel();
                }}
                onWidthChange={width => setSessionField(sessionKey, 'browserPanelWidth', width)}
                onActiveTargetChange={targetId => {
                  if (isActiveSession) {
                    handleBrowserTargetChange(targetId);
                    return;
                  }
                  setSessionField(sessionKey, 'browserPanelTargetId', targetId);
                  setSessionField(
                    sessionKey,
                    'preferredDisplayTabId',
                    targetId ? browserDisplayTabId(targetId) : null,
                  );
                }}
                onTabsChange={tabs => setSessionField(sessionKey, 'browserTabs', tabs)}
                onRecordingRetentionChange={retained =>
                  setSessionField(sessionKey, 'hasBrowserRecording', retained)
                }
                initialTabs={displayState.browserTabs}
                retainedTargetIds={displayState.browserTabs.map(tab => tab.targetId)}
                agentInteractionStates={[
                  ...(browserAgentPanelStates.get(sessionKey)?.values() ?? []),
                ]}
                onAddAnnotation={isActiveSession ? handleAddBrowserAnnotation : () => false}
                onRequestBrowserSettings={browserPage =>
                  onRequestAppSettings?.({ initialTab: 'browser', browserPage })
                }
                embedded
              />,
            ]
          : []),
        ...displayState.terminalTabs.map(tab => (
          <TerminalPanel
            key={`terminal-runtime:${displayState.runtimeId}:${tab.id}`}
            terminalId={tab.id}
            cwd={tab.cwd}
            isObscured={!isActiveSession || runtimeActiveTabId !== tab.id}
          />
        )),
      ];
    },
  );

  // When there's a current session, show the session detail view
  if (currentSession) {
    const handleSendMessage = async (
      prompt: string,
      attachments?: CoworkAttachmentPayload[],
      gatewayPrompt?: string,
    ) => {
      if (currentSession.external?.readOnly) return false;
      if (!ensureOpenClawReadyForSubmit() || pendingStartRef.current?.cancelled) return false;
      const outboundPrompt = gatewayPrompt ?? prompt;
      const goalEdit = isGoalEditCommand(outboundPrompt);
      const targetSessionKey = currentGatewaySessionKey;
      if (!targetSessionKey || pendingMessageSubmissionsRef.current.has(currentSession.id))
        return false;
      const operation = createSessionSubmission();
      operation.sessionKey = targetSessionKey;
      pendingMessageSubmissionsRef.current.set(currentSession.id, operation);
      let requestUnknown = false;
      const ensureSubmissionCurrent = () => {
        if (operation.cancelled || currentGatewaySessionKeyRef.current !== targetSessionKey) {
          throw new Error('The message submission context changed');
        }
      };
      const startedAt = Date.now();
      const clientTurnId = `justdo-${startedAt}-${crypto.randomUUID()}`;
      let runTimingId: string | null = null;
      return submitCoworkMessage(
        async () => {
          ensureSubmissionCurrent();
          const permission = await coworkService.reconcileSessionPermissionMode(currentSession.id);
          if (!permission.success) {
            throw new Error(permission.error || i18nService.t('permissionModeSaveFailed'));
          }
          ensureSubmissionCurrent();
          const timing = await coworkService.beginSessionRun({
            sessionId: currentSession.id,
            clientTurnId,
            startedAt,
          });
          runTimingId = timing.id;
          operation.receiptId = timing.id;
          ensureSubmissionCurrent();
          const chatWrapper = chatWrapperRef.current;
          if (!chatWrapper) throw new Error('Chat controller is not ready');
          await chatWrapper.sendMessage(prompt, attachments, gatewayPrompt, {
            propagateRequestFailure: true,
            expectedSessionKey: targetSessionKey,
            isCancelled: () => operation.cancelled,
            onRequestUnknown: async runId => {
              operation.runId = runId;
              requestUnknown = true;
              operation.unknown = true;
              await coworkService.markSessionRunUnknown({
                sessionId: currentSession.id,
                id: timing.id,
                cancelled: operation.cancelled,
              });
              operation.unknownMarked = true;
            },
            clientTurnId,
            onRunBound: async runId => {
              await bindSessionSubmissionRun(operation, runId, () =>
                coworkService.bindSessionRun(timing.id, runId, currentSession.id),
              );
            },
          });
        },
        err => {
          if (runTimingId && !requestUnknown)
            void coworkService.failSessionRun(currentSession.id, runTimingId);
          else {
            void coworkService.refreshSessionRuntimeActivity(currentSession.id, {
              includeSubagents: true,
              forceRefresh: true,
              fullScan: true,
            });
          }
          if ((goalEdit && !requestUnknown) || operation.cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: requestUnknown
                ? i18nService.t('coworkSendOutcomeUnknown')
                : i18nService.t('coworkErrorSessionStartFailed').replace('{error}', message),
            }),
          );
        },
      ).finally(() => {
        operation.finish();
        if (
          !operation.stopping &&
          !operation.unknown &&
          pendingMessageSubmissionsRef.current.get(currentSession.id) === operation
        ) {
          pendingMessageSubmissionsRef.current.delete(currentSession.id);
        }
      });
    };

    const handleAssistantMessageFork = async (entryId: string): Promise<boolean> => {
      const sourceSession = currentSession;
      const sourceSessionId = sourceSession.id;
      if (sourceSessionId.startsWith('temp-') || sessionTranscriptMutationRef.current) {
        return false;
      }
      const operation = { kind: 'fork' as const, sessionId: sourceSessionId };
      sessionTranscriptMutationRef.current = operation;
      setSessionTranscriptMutation(operation);
      try {
        const runtime = await coworkService.getSessionRuntimeStatus(sourceSessionId, {
          includeSubagents: true,
          forceRefresh: true,
          fullScan: true,
        });
        if (currentSessionIdRef.current !== sourceSessionId) return false;
        if (!runtime.known || runtime.running) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t(
                runtime.running
                  ? 'coworkForkWaitForCompletion'
                  : 'coworkMessageHistoryActivityUnknown',
              ),
            }),
          );
          return false;
        }
        const canNavigate = await requestFilePreviewTransition();
        if (!canNavigate || currentSessionIdRef.current !== sourceSessionId) return false;
        const forked = await coworkService.forkSession(sourceSession, entryId);
        if (!forked) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkForkSessionFailed'),
            }),
          );
          return false;
        }
        dispatch(setDraftPrompt({ sessionId: forked.session.id, draft: forked.draft.text }));
        dispatch(
          setDraftAttachments({
            draftKey: forked.session.id,
            attachments: restoredDraftAttachments(forked.draft),
          }),
        );
        dispatch(clearDraftBrowserAnnotations({ draftKey: forked.session.id }));
        for (const annotation of forked.draft.browserAnnotations ?? []) {
          dispatch(addDraftBrowserAnnotation({ draftKey: forked.session.id, annotation }));
        }
        if (forked.draft.browserRecording)
          dispatch(
            setDraftBrowserRecording({
              draftKey: forked.session.id,
              recording: { ...forked.draft.browserRecording, sessionId: forked.session.id },
            }),
          );
        if (store.getState().cowork.currentSession?.id === forked.session.id) {
          requestAnimationFrame(() => {
            promptInputRef.current?.setValue(forked.draft.text);
            promptInputRef.current?.focus();
          });
        }
        return true;
      } catch (error) {
        console.error('[CoworkView] Failed to fork from an assistant response:', error);
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkForkSessionFailed'),
          }),
        );
        return false;
      } finally {
        if (sessionTranscriptMutationRef.current === operation) {
          sessionTranscriptMutationRef.current = null;
          setSessionTranscriptMutation(null);
        }
      }
    };

    const handleOpenForkSource = async (): Promise<void> => {
      const sourceSessionId = currentSession.forkSource?.sessionId;
      const sourceEntryId = currentSession.forkSource?.entryId;
      if (!sourceSessionId || !sourceEntryId) return;
      const canNavigate = await requestFilePreviewTransition();
      if (!canNavigate || currentSessionIdRef.current !== currentSession.id) return;
      const loaded = await coworkService.loadSession(sourceSessionId);
      if (!loaded) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkBranchSourceUnavailable'),
          }),
        );
      } else {
        setPendingSourceReveal({ sessionId: sourceSessionId, entryId: sourceEntryId });
      }
    };

    const performLastUserMessageAction = async ({
      action,
      entryId,
      sourceSessionId,
      editedText,
    }: PendingMessageHistoryAction): Promise<boolean> => {
      if (currentSessionIdRef.current !== sourceSessionId || sessionTranscriptMutationRef.current) {
        return false;
      }
      const operation = { kind: 'message' as const, sessionId: sourceSessionId };
      sessionTranscriptMutationRef.current = operation;
      setSessionTranscriptMutation(operation);
      try {
        const runtime = await coworkService.getSessionRuntimeStatus(sourceSessionId, {
          includeSubagents: true,
          forceRefresh: true,
          fullScan: true,
        });
        if (currentSessionIdRef.current !== sourceSessionId) return false;
        if (!runtime.known || runtime.running) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t(
                runtime.running
                  ? 'coworkMessageHistoryWaitForCompletion'
                  : 'coworkMessageHistoryActivityUnknown',
              ),
            }),
          );
          return false;
        }
        if (action === 'edit' && store.getState().cowork.draftBrowserRecordings[sourceSessionId]) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', { detail: i18nService.t('recordingExisting') }),
          );
          return false;
        }
        const draft = await chatWrapperRef.current?.rewindToUserMessage(entryId);
        if (!draft) throw new Error('Chat controller is not ready');
        if (action === 'edit') {
          const nextText = editedText ?? draft.text;
          const attachments = [
            ...draft.attachments,
            ...(draft.browserRecording
              ? recordingImagesInStepOrder(draft.browserRecording)
              : []
            ).flatMap(image => {
              const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(image.dataUrl);
              return match
                ? [{ name: image.fileName, mimeType: match[1], base64Data: match[2] }]
                : [];
            }),
          ];
          const recordingIssue = recordingSubmissionIssue(
            draft.browserRecording,
            attachments,
            !!promptInputRef.current?.supportsImages(),
          );
          if (recordingIssue)
            window.dispatchEvent(
              new CustomEvent('app:showToast', { detail: i18nService.t(recordingIssue) }),
            );
          const sent = recordingIssue
            ? false
            : await handleSendMessage(
                nextText,
                attachments,
                composeBrowserGatewayPrompt(
                  appendMediaDirectiveLines(nextText, draft.filePaths),
                  [],
                  draft.browserRecording,
                ),
              );
          if (sent === false) {
            dispatch(setDraftPrompt({ sessionId: sourceSessionId, draft: nextText }));
            dispatch(
              setDraftAttachments({
                draftKey: sourceSessionId,
                attachments: restoredDraftAttachments(draft),
              }),
            );
            dispatch(clearDraftBrowserAnnotations({ draftKey: sourceSessionId }));
            if (draft.browserRecording)
              dispatch(
                setDraftBrowserRecording({
                  draftKey: sourceSessionId,
                  recording: { ...draft.browserRecording, sessionId: sourceSessionId },
                }),
              );
            if (currentSessionIdRef.current === sourceSessionId) {
              promptInputRef.current?.setValue(nextText);
              requestAnimationFrame(() => promptInputRef.current?.focus());
            }
          }
        }
        return true;
      } catch (error) {
        console.error('[CoworkView] Failed to update the last user message:', error);
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkMessageHistoryMutationFailed'),
          }),
        );
        return false;
      } finally {
        if (sessionTranscriptMutationRef.current === operation) {
          sessionTranscriptMutationRef.current = null;
          setSessionTranscriptMutation(null);
        }
      }
    };

    const handleLastUserMessageAction = (
      action: 'edit' | 'withdraw',
      entryId: string,
      editedText?: string,
    ): boolean | Promise<boolean> => {
      const sourceSessionId = currentSession.id;
      if (sessionTranscriptMutationRef.current) return false;
      if (action === 'edit') {
        return performLastUserMessageAction({
          action,
          entryId,
          sourceSessionId,
          confirmationKey: '',
          editedText,
        });
      }
      setPendingMessageHistoryAction({
        action,
        entryId,
        sourceSessionId,
        confirmationKey: 'coworkWithdrawLastMessageConfirm',
      });
      return true;
    };

    const handleExportSession = async (includeRawData: boolean): Promise<boolean> => {
      try {
        const snapshot = chatWrapperRef.current?.getExportSnapshot();
        if (!snapshot || snapshot.isLoading) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkExportHistoryLoading'),
            }),
          );
          return false;
        }
        const document = createSessionExportDocument({
          session: currentSession,
          messages: snapshot.messages,
          model: sessionSelectedModel?.id ?? sessionSelectedModel?.name,
          runtimeSessionId: snapshot.runtimeSessionId,
          includeRawData,
        });
        const result = await window.electron.dialog.saveTextFile({
          title: i18nService.t('collaborationExportMain'),
          defaultFileName: buildSessionExportFileName(currentSession.title),
          content: `${JSON.stringify({ ...document, scope: 'main', exportedAt: new Date().toISOString() }, null, 2)}\n`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (!result.success) {
          const errorKey =
            result.errorCode === SaveTextFileErrorCode.FileTooLarge
              ? 'coworkExportTooLarge'
              : 'coworkExportFailed';
          window.dispatchEvent(
            new CustomEvent('app:showToast', { detail: i18nService.t(errorKey) }),
          );
          return false;
        }
        if (result.canceled) return false;
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('coworkExportSuccess') }),
        );
        return true;
      } catch (error) {
        console.error('[CoworkView] Failed to export session:', error);
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkExportFailed'),
          }),
        );
        return false;
      }
    };

    const planPreviewLabel = visiblePlanInteraction
      ? typeof visiblePlanInteraction.toolInput.title === 'string' &&
        visiblePlanInteraction.toolInput.title.trim()
        ? visiblePlanInteraction.toolInput.title.trim()
        : i18nService.t('planReviewTitle')
      : '';
    const displayTabs: CoworkDisplayTab[] = [
      ...recordingReviewTabs.tabs,
      ...(isBrowserPanelOpen
        ? browserTabs.map(tab => ({
            id: browserDisplayTabId(tab.targetId),
            label: getBrowserTabDisplayTitle(tab),
            icon: tab.faviconUrl ? (
              <img src={tab.faviconUrl} alt="" className="h-4 w-4 rounded-sm object-contain" />
            ) : (
              <GlobeAltIcon className="h-4 w-4" />
            ),
            onSelect: () => handleBrowserTargetChange(tab.targetId),
            onClose: () => browserPanelRefs.current.get(displaySessionKey)?.closeTab(tab.targetId),
            onContextMenu: (
              { x, y }: { x: number; y: number },
              closeActions: CoworkDisplayTabCloseActions,
            ) =>
              browserPanelRefs.current
                .get(displaySessionKey)
                ?.openTabContextMenu(tab.targetId, x, y, closeActions),
          }))
        : []),
      ...terminalTabs.map(tab => ({
        id: tab.id,
        label: tab.label,
        icon: <CommandLineIcon className="h-4 w-4" />,
        onSelect: () => {
          setIsWorkspaceFilesOpen(false);
          setPreferredDisplayTabId(tab.id);
        },
        onClose: () => closeTerminalTab(tab.id),
        contextMenuItems: [
          {
            id: 'open-system-terminal',
            label: getSystemTerminalLabel(),
            icon: <ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0" />,
            onSelect: () => handleOpenSystemTerminal(tab.cwd),
          },
        ],
      })),
      ...filePreviews.map(preview => ({
        id: fileDisplayTabId(preview.filePath),
        label:
          preview.kind === 'image'
            ? preview.label || i18nService.t('coworkImagePreviewTitle')
            : preview.filePath.split(/[\\/]/).pop() || preview.filePath,
        icon:
          preview.kind === 'image' ? (
            <PhotoIcon className="h-4 w-4" />
          ) : (
            <DocumentTextIcon className="h-4 w-4" />
          ),
        onSelect: () => setPreferredDisplayTabId(fileDisplayTabId(preview.filePath)),
        onClose: () => closeFilePreview(preview.filePath),
      })),
      ...unsupportedFilePreviews.map(filePath => ({
        id: fileDisplayTabId(filePath),
        label: filePath.split(/[\\/]/).pop() || filePath,
        icon: <DocumentTextIcon className="h-4 w-4" />,
        onSelect: () => setPreferredDisplayTabId(fileDisplayTabId(filePath)),
        onClose: () => closeUnsupportedFilePreview(filePath),
      })),
      ...(visiblePlanInteraction
        ? [
            {
              id: PLAN_DISPLAY_TAB_ID,
              label: planPreviewLabel,
              icon: <ClipboardDocumentCheckIcon className="h-4 w-4" />,
              onSelect: () => {
                setIsWorkspaceFilesOpen(false);
                setPreferredDisplayTabId(PLAN_DISPLAY_TAB_ID);
              },
              ...(planPreviewReadOnly
                ? {
                    onClose: () => {
                      dispatchPlanPreview({ type: 'closed' });
                      selectAdjacentDisplayTabAfterClose(PLAN_DISPLAY_TAB_ID);
                    },
                  }
                : {}),
            },
          ]
        : []),
      ...(selectedSubagent
        ? [
            {
              id: SUBAGENT_DISPLAY_TAB_ID,
              label: selectedSubagent.label,
              icon: <QueueListIcon className="h-4 w-4" />,
              onSelect: () => {
                setIsWorkspaceFilesOpen(false);
                setPreferredDisplayTabId(SUBAGENT_DISPLAY_TAB_ID);
              },
              onClose: () => {
                setSelectedSubagent(null);
                selectAdjacentDisplayTabAfterClose(SUBAGENT_DISPLAY_TAB_ID);
              },
            },
          ]
        : []),
      ...(collaborationSessionId === currentSession.id
        ? [
            {
              id: COLLABORATION_DISPLAY_TAB_ID,
              label: i18nService.t('collaborationTab'),
              icon: <ChatBubbleLeftEllipsisIcon className="h-4 w-4" />,
              onSelect: () => setPreferredDisplayTabId(COLLABORATION_DISPLAY_TAB_ID),
              onClose: () => {
                setCollaborationSessionId(null);
                selectAdjacentDisplayTabAfterClose(COLLABORATION_DISPLAY_TAB_ID);
              },
            },
          ]
        : []),
      ...sideChatTabs.map(tab => ({
        id: tab.id,
        label: tab.label,
        icon: <ChatBubbleLeftEllipsisIcon className="h-4 w-4" />,
        onSelect: () => setPreferredDisplayTabId(tab.id),
        onClose: () => closeSideChat(tab.id),
      })),
    ];

    return (
      <div className="relative flex-1 flex flex-col h-full">
        {windowHeader}
        <div className="cowork-display-host relative flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="cowork-workspace-header relative flex shrink-0 items-center justify-between border-b border-border px-2">
              <div className="non-draggable flex h-7 min-w-0 flex-1 items-center overflow-hidden">
                {isSidebarCollapsed && (
                  <div className="mr-2 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={onToggleSidebar}
                      className="inline-flex h-7 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
                    >
                      <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
                    </button>
                    <button
                      type="button"
                      onClick={onNewChat}
                      className="inline-flex h-7 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
                    >
                      <ComposeIcon className="h-4 w-4" />
                    </button>
                  </div>
                )}
                <h1
                  className="cowork-session-title max-w-[min(34vw,28rem)] truncate text-sm font-semibold text-foreground"
                  title={currentSession.title}
                >
                  {currentSession.title}
                </h1>
                {currentSession.handoffSource && (
                  <button
                    type="button"
                    className="ml-2 max-w-48 truncate text-xs text-secondary"
                    disabled={!currentSession.handoffSource.sessionId}
                    onClick={() =>
                      void (async () => {
                        const sourceId = currentSession.handoffSource?.sessionId;
                        if (sourceId && (await requestFilePreviewTransition()))
                          await coworkService.loadSession(sourceId);
                      })()
                    }
                  >
                    {i18nService
                      .t('agentHandoffFrom')
                      .replace('{title}', currentSession.handoffSource.title)}
                  </button>
                )}
                {currentSession.forkSource &&
                  (currentSession.forkSource.sessionId ? (
                    <button
                      type="button"
                      onClick={() => void handleOpenForkSource()}
                      className="ml-2 inline-flex min-w-0 max-w-[min(24vw,18rem)] items-center gap-1 rounded-md px-1.5 py-1 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                      title={i18nService
                        .t('coworkOpenBranchSource')
                        .replace('{title}', currentSession.forkSource.title)}
                      aria-label={i18nService
                        .t('coworkOpenBranchSource')
                        .replace('{title}', currentSession.forkSource.title)}
                    >
                      <ArrowUturnLeftIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        {i18nService
                          .t('coworkBranchedFrom')
                          .replace('{title}', currentSession.forkSource.title)}
                      </span>
                    </button>
                  ) : (
                    <span
                      className="ml-2 inline-flex min-w-0 max-w-[min(24vw,18rem)] items-center gap-1 px-1.5 py-1 text-xs text-muted"
                      title={i18nService.t('coworkBranchSourceUnavailable')}
                    >
                      <ArrowUturnLeftIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        {i18nService
                          .t('coworkBranchedFrom')
                          .replace('{title}', currentSession.forkSource.title)}
                      </span>
                    </span>
                  ))}
              </div>
              <div className="non-draggable flex shrink-0 items-center gap-1">
                {currentSessionFolderPath && currentSessionFolderName && (
                  <button
                    type="button"
                    onClick={handleOpenCurrentSessionFolder}
                    className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg px-2.5 text-sm text-secondary transition-colors hover:bg-surface-raised hover:text-primary"
                    title={`${i18nService.t('coworkOpenFolder')}: ${currentSessionFolderPath}`}
                    aria-label={`${i18nService.t('coworkOpenFolder')}: ${currentSessionFolderName}`}
                  >
                    <FolderIcon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{currentSessionFolderName}</span>
                  </button>
                )}
                <button
                  type="button"
                  onMouseDown={event => event.stopPropagation()}
                  onClick={event => {
                    event.stopPropagation();
                    setAreProcessSummariesExpanded(expanded => !expanded);
                  }}
                  className={`inline-flex h-7 w-8 items-center justify-center rounded-lg transition-colors ${
                    areProcessSummariesExpanded
                      ? 'bg-surface-raised text-primary'
                      : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                  }`}
                  title={i18nService.t(
                    areProcessSummariesExpanded
                      ? 'coworkCollapseAllProcessDetails'
                      : 'coworkExpandAllProcessDetails',
                  )}
                  aria-label={i18nService.t(
                    areProcessSummariesExpanded
                      ? 'coworkCollapseAllProcessDetails'
                      : 'coworkExpandAllProcessDetails',
                  )}
                  aria-pressed={areProcessSummariesExpanded}
                >
                  <BrainIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onMouseDown={event => event.stopPropagation()}
                  onClick={event => {
                    event.stopPropagation();
                    setIsSessionSearchOpen(open => !open);
                  }}
                  className={`inline-flex h-7 w-8 items-center justify-center rounded-lg transition-colors ${
                    isSessionSearchOpen
                      ? 'text-primary hover:bg-surface-raised'
                      : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                  }`}
                  title={i18nService.t('coworkSearchInSession')}
                  aria-label={i18nService.t('coworkSearchInSession')}
                >
                  <SearchIcon className="h-4 w-4" />
                </button>
                {progressCard && (
                  <button
                    type="button"
                    onMouseDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      if (progressCardVisibility.visible) {
                        progressCardVisibility.hide();
                      } else {
                        progressCardVisibility.show();
                      }
                    }}
                    className={`relative inline-flex h-7 w-8 items-center justify-center rounded-lg transition-colors ${
                      progressCardVisibility.visible
                        ? 'bg-surface-raised text-primary'
                        : progressCardComplete
                          ? 'text-green-500 hover:bg-surface-raised'
                          : progressCardRunState === 'failed'
                            ? 'text-destructive hover:bg-surface-raised'
                            : progressCardPaused
                              ? 'text-amber-500 hover:bg-surface-raised'
                              : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                    }`}
                    title={i18nService.t(
                      progressCardVisibility.visible
                        ? 'coworkProgressCardHide'
                        : 'coworkProgressCardShow',
                    )}
                    aria-label={i18nService.t(
                      progressCardVisibility.visible
                        ? 'coworkProgressCardHide'
                        : 'coworkProgressCardShow',
                    )}
                    aria-expanded={progressCardVisibility.visible}
                    aria-controls="cowork-progress-card-overlay"
                  >
                    {progressCardComplete ? (
                      <CheckCircleIcon className="h-[18px] w-[18px]" />
                    ) : progressCardRunState === 'running' ? (
                      <ArrowPathIcon className="h-[18px] w-[18px] animate-spin" />
                    ) : progressCardRunState === 'failed' ? (
                      <XCircleIcon className="h-[18px] w-[18px]" />
                    ) : progressCardRunState === 'aborted' ? (
                      <StopCircleIcon className="h-[18px] w-[18px]" />
                    ) : progressCardPaused ? (
                      <PauseCircleSolidIcon className="h-[18px] w-[18px]" />
                    ) : (
                      <ClipboardDocumentCheckIcon className="h-[18px] w-[18px]" />
                    )}
                    {!progressCardVisibility.visible && !progressCardComplete && (
                      <span
                        className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                )}
                <CollaborationMemberLinks
                  sessionId={currentSession.id}
                  onOpen={() => {
                    setIsSubtaskListOpen(false);
                    setCollaborationMemberId(undefined);
                    setCollaborationSessionId(currentSession.id);
                    setPreferredDisplayTabId(COLLABORATION_DISPLAY_TAB_ID);
                    setIsDisplayPanelOpen(true);
                    setIsWorkspaceFilesOpen(false);
                  }}
                />
                <div className="relative">
                  <button
                    ref={subtaskListToggleRef}
                    type="button"
                    onMouseDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      setIsSubtaskListOpen(open => !open);
                    }}
                    className={`relative inline-flex h-7 w-8 items-center justify-center rounded-lg transition-colors ${
                      isSubtaskListOpen
                        ? 'bg-surface-raised text-primary'
                        : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                    }`}
                    title={i18nService.t(isSubtaskListOpen ? 'subtaskHide' : 'subtaskShow')}
                    aria-label={i18nService.t(isSubtaskListOpen ? 'subtaskHide' : 'subtaskShow')}
                    aria-expanded={isSubtaskListOpen}
                    aria-controls="cowork-subtask-list"
                  >
                    <QueueListIcon className="h-[18px] w-[18px]" />
                    {!isSubtaskListOpen && activeSubtaskCount > 0 && (
                      <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-white">
                        {activeSubtaskCount}
                      </span>
                    )}
                  </button>
                  <SubtaskListPanel
                    sessionId={currentSession.id}
                    isOpen={isSubtaskListOpen}
                    parentRunning={currentSessionRuntimeRunning}
                    anchorRef={subtaskListToggleRef}
                    onClose={closeSubtaskList}
                    onOpenSubtask={openSubtask}
                    onSubtasksChange={handleSubtasksChange}
                  />
                </div>
                {!isDisplayPanelOpen && (
                  <button
                    ref={displayPanelToggleRef}
                    type="button"
                    onMouseDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      openDisplayPanel();
                    }}
                    className="relative inline-flex h-7 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                    title={i18nService.t('coworkDisplayPanelOpen')}
                    aria-label={i18nService.t('coworkDisplayPanelOpen')}
                    aria-expanded={false}
                    aria-controls="cowork-display-panel"
                  >
                    <RightSidebarIcon className="h-[18px] w-[18px]" />
                  </button>
                )}
              </div>
              {isSessionSearchOpen && (
                <div
                  ref={sessionSearchPanelRef}
                  className="non-draggable absolute right-2 top-full z-40 mt-2 flex min-h-9 max-w-[calc(100vw-5rem)] items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 shadow-popover"
                >
                  <SearchIcon className="h-4 w-4 shrink-0 text-muted" />
                  <input
                    ref={sessionSearchInputRef}
                    value={sessionSearchQuery}
                    onChange={event => {
                      setSessionSearchQuery(event.target.value);
                      setSessionSearchActiveIndex(-1);
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        navigateSessionSearch(event.shiftKey ? -1 : 1);
                      }
                    }}
                    className="h-7 w-48 bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
                    placeholder={i18nService.t('coworkSearchInSessionPlaceholder')}
                  />
                  <label className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-secondary hover:bg-surface-raised">
                    <input
                      type="checkbox"
                      checked={sessionSearchIgnoreCase}
                      onChange={event => {
                        setSessionSearchIgnoreCase(event.target.checked);
                        setSessionSearchActiveIndex(-1);
                      }}
                      className="h-3.5 w-3.5 rounded border-border accent-primary"
                    />
                    <span className="whitespace-nowrap">{i18nService.t('ignoreCase')}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => navigateSessionSearch(-1)}
                    disabled={sessionSearchMatchCount === 0}
                    className="h-7 rounded-md px-2 text-xs text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-secondary"
                  >
                    {i18nService.t('previous')}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateSessionSearch(1)}
                    disabled={sessionSearchMatchCount === 0}
                    className="h-7 rounded-md px-2 text-xs text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-secondary"
                  >
                    {i18nService.t('next')}
                  </button>
                  <span className="min-w-[88px] text-center text-xs tabular-nums text-muted">
                    {sessionSearchMatchCountText}
                  </span>
                </div>
              )}
            </div>
            {/* Messages */}
            <JustDoChatWrapper
              ref={chatWrapperRef}
              className="flex-1 min-h-0"
              assistantName={assistantName}
              workingDirectory={currentSessionFolderPath}
              searchQuery={isSessionSearchOpen ? sessionSearchQuery : ''}
              searchCaseSensitive={!sessionSearchIgnoreCase}
              searchNavigationToken={sessionSearchNavigation.token}
              searchNavigationDirection={sessionSearchNavigation.direction}
              processSummariesExpanded={areProcessSummariesExpanded}
              onSearchMatchCountChange={handleSessionSearchMatchCountChange}
              onActivityChange={setGoalRunProgress}
              onContextUsageChange={setContextUsage}
              onProgressCardChange={setProgressCardState}
              onSideChatResult={handleSideChatResult}
              onSideChatStream={handleSideChatStream}
              onSessionKeyChange={sessionKey =>
                setReportedGatewaySessionKey({ sessionId: currentSession.id, sessionKey })
              }
              onLastUserMessageAction={
                sessionTranscriptMutation === null &&
                !(goalPresence.sessionId === currentSession.id && goalPresence.hasGoal)
                  ? handleLastUserMessageAction
                  : undefined
              }
              onAssistantMessageFork={
                sessionTranscriptMutation === null &&
                !collaborationRooms.some(room =>
                  room.members.some(member => member.sessionId === currentSession.id),
                ) &&
                !currentSessionRuntimeRunning &&
                !currentSession.id.startsWith('temp-')
                  ? handleAssistantMessageFork
                  : undefined
              }
              runTimings={sessionRunTimings[currentSession.id] ?? []}
            />
            {/* Input */}
            <div className="shrink-0 pb-4 pt-2">
              <div className="cowork-content-width mx-auto min-w-0 space-y-1.5">
                {currentSession.external?.readOnly ? (
                  <div className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-center text-xs leading-5 text-secondary">
                    {i18nService.t('multicaSessionReadOnly')}
                  </div>
                ) : (
                  <div className="relative isolate rounded-2xl">
                    <div className="shadow-glow-accent rounded-2xl">
                      <CoworkPromptInput
                        ref={promptInputRef}
                        onSubmit={handleSendMessage}
                        onStop={handleStopSession}
                        stopOperationKey={getSessionStopOperationKey(
                          currentSession.id,
                          pendingStartRef.current,
                        )}
                        isStreaming={currentSessionRuntimeRunning}
                        disabled={
                          !isEngineReady ||
                          isQuestionInputBlocked ||
                          currentSessionAgent?.enabled === false
                        }
                        placeholder={i18nService.t(
                          currentSessionAgent?.enabled === false
                            ? 'agentUnavailable'
                            : 'coworkContinuePlaceholder',
                        )}
                        size="large"
                        showModelSelector={true}
                        sessionId={currentSession.id}
                        workingDirectory={currentSessionFolderPath}
                        modelAgentId={currentSession.agentId}
                        slashCommandSessionKey={currentGatewaySessionKey ?? undefined}
                        sessionModelRef={currentSession.modelRef}
                        contextUsage={contextUsage}
                        initialGoalObjective={initialGoalObjective}
                        goalRunProgress={goalRunProgress}
                        onGoalResumeAccepted={handleGoalResumeAccepted}
                        onGoalPresenceChange={handleGoalPresenceChange}
                      />
                    </div>
                    {isQuestionInputBlocked && (
                      <div
                        className="mt-2 flex items-center justify-center text-center"
                        role="status"
                        aria-live="polite"
                      >
                        <span className="rounded-full border border-border bg-surface/95 px-3 py-1.5 text-xs font-medium text-secondary shadow-subtle">
                          {inputBlockedMessage ?? i18nService.t('coworkQuestionInputBlocked')}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <p className="px-1 text-center text-[11px] font-light leading-4 text-muted">
                  {i18nService.t('aiGeneratedDisclaimer')}
                </p>
              </div>
            </div>
            {progressCard && progressCardVisibility.visible && (
              <div className="pointer-events-none absolute left-3 right-3 top-3 z-40 sm:left-auto sm:w-[min(340px,calc(100%-24px))]">
                <div
                  className="pointer-events-auto"
                  onPointerDownCapture={progressCardVisibility.show}
                  onFocusCapture={progressCardVisibility.show}
                >
                  <SessionProgressCard
                    key={`floating:${progressCard.sessionKey}`}
                    card={progressCard}
                    runState={progressCardRunState}
                    onClose={progressCardVisibility.hide}
                  />
                </div>
              </div>
            )}
          </div>
          {(isDisplayPanelOpen ||
            hasBrowserPanelOpened ||
            displayTabs.length > 0 ||
            hasRetainedRuntimePanels) && (
            <CoworkDisplayPanel
              key="cowork-display-panel"
              activeTabId={activeDisplayTabId ?? ''}
              isOpen={isDisplayPanelOpen}
              onClose={closeDisplayPanel}
              width={browserPanelWidth}
              onWidthChange={width =>
                setSessionField(displaySessionKey, 'browserPanelWidth', width)
              }
              showEmptyState={displayTabs.length === 0}
              tabs={displayTabs}
              emptyState={
                isWorkspaceFilesOpen ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-6 text-center">
                    <FolderIcon className="h-7 w-7 text-muted" />
                    <div className="text-sm font-semibold text-foreground">
                      {i18nService.t('coworkWorkspaceFilesOpenTitle')}
                    </div>
                    <div className="text-xs text-secondary">
                      {i18nService.t('coworkWorkspaceFilesOpenDescription')}
                    </div>
                  </div>
                ) : (
                  <DisplayPanelLauncher
                    browserDisabled={
                      currentSession.id.startsWith('temp-') ||
                      browserTabs.length >= MAX_BROWSER_TABS
                    }
                    filesDisabled={
                      !currentSessionFolderPath || currentSession.id.startsWith('temp-')
                    }
                    onCreateBrowser={handleCreateBrowserTab}
                    onCreateSideChat={handleCreateSideChat}
                    onCreateTerminal={handleCreateTerminalTab}
                    onOpenFiles={handleOpenWorkspaceFiles}
                    sideChatDisabled={currentSession.id.startsWith('temp-') || !isOpenClawEngine}
                    terminalDisabled={
                      !terminalWorkingDirectory || terminalTabs.length >= MAX_TERMINAL_TABS
                    }
                  />
                )
              }
              sidePanel={
                isWorkspaceFilesOpen && currentSessionFolderPath ? (
                  <WorkspaceFilesPanel
                    key={`${currentSession.id}:${currentSessionFolderPath}`}
                    activeFilePath={activeFilePreview?.filePath ?? activeUnsupportedFilePath}
                    sessionId={currentSession.id}
                    onOpenFile={filePath => {
                      window.dispatchEvent(
                        new CustomEvent('cowork:preview-file', {
                          detail: {
                            filePath,
                            keepWorkspaceFilesOpen: true,
                            workingDirectory: currentSessionFolderPath,
                          },
                        }),
                      );
                    }}
                  />
                ) : undefined
              }
              actions={
                <NewDisplayTabMenu
                  browserDisabled={
                    currentSession.id.startsWith('temp-') || browserTabs.length >= MAX_BROWSER_TABS
                  }
                  filesDisabled={!currentSessionFolderPath || currentSession.id.startsWith('temp-')}
                  onCreateBrowser={handleCreateBrowserTab}
                  onCreateSideChat={handleCreateSideChat}
                  onCreateTerminal={handleCreateTerminalTab}
                  sideChatDisabled={currentSession.id.startsWith('temp-') || !isOpenClawEngine}
                  onOpenFiles={handleOpenWorkspaceFiles}
                  terminalDisabled={
                    !terminalWorkingDirectory || terminalTabs.length >= MAX_TERMINAL_TABS
                  }
                />
              }
            >
              {retainedRuntimePanels}
              {recordingReviewTabs.panels(activeDisplayTabId)}
              {collaborationSessionId === currentSession.id &&
                activeDisplayTabId === COLLABORATION_DISPLAY_TAB_ID && (
                  <CollaborationPanel
                    key={currentSession.id}
                    source={currentSession}
                    selectedMemberId={collaborationMemberId}
                    onSelect={setCollaborationMemberId}
                    onOpenSubtask={openSubtask}
                  />
                )}
              <SubagentMessageDrawer
                parentSessionId={selectedSubagent?.parentSessionId ?? currentSession.id}
                subagent={selectedSubagent}
                onClose={() => {
                  setSelectedSubagent(null);
                  selectAdjacentDisplayTabAfterClose(SUBAGENT_DISPLAY_TAB_ID);
                }}
                embedded
                isObscured={activeDisplayTabId !== SUBAGENT_DISPLAY_TAB_ID}
              />
              {filePreviews.map(preview => (
                <FilePreviewDrawer
                  key={fileDisplayTabId(preview.filePath)}
                  ref={drawer => {
                    const tabId = fileDisplayTabId(preview.filePath);
                    if (drawer) filePreviewDrawerRefs.current.set(tabId, drawer);
                    else filePreviewDrawerRefs.current.delete(tabId);
                  }}
                  preview={preview}
                  onClose={() => void closeFilePreview(preview.filePath)}
                  isObscured={activeFilePreview?.filePath !== preview.filePath}
                  embedded
                />
              ))}
              {unsupportedFilePreviews.map(filePath => (
                <UnsupportedFilePreview
                  key={fileDisplayTabId(filePath)}
                  filePath={filePath}
                  onClose={() => closeUnsupportedFilePreview(filePath)}
                  isObscured={activeUnsupportedFilePath !== filePath}
                />
              ))}
              {visiblePlanInteraction && (
                <PlanApprovalDrawer
                  key={`${visiblePlanInteraction.requestId}:${planPreviewReadOnly ? 'readonly' : 'approval'}`}
                  interaction={visiblePlanInteraction}
                  onRespond={planPreviewReadOnly ? undefined : handlePlanRespond}
                  readOnly={planPreviewReadOnly}
                  onClose={
                    planPreviewReadOnly
                      ? () => {
                          dispatchPlanPreview({ type: 'closed' });
                          selectAdjacentDisplayTabAfterClose(PLAN_DISPLAY_TAB_ID);
                        }
                      : undefined
                  }
                  embedded
                  isObscured={activeDisplayTabId !== PLAN_DISPLAY_TAB_ID}
                />
              )}
              {activeSideChatTab && (
                <SideChatPanel
                  key={activeSideChatTab.id}
                  assistantName={assistantName}
                  disabled={!isEngineReady}
                  draftKey={activeSideChatTab.id}
                  messages={activeSideChatTab.messages}
                  modelAgentId={currentSession.agentId}
                  onSubmit={question =>
                    handleSendSideChat(activeSideChatTab.id, question, currentSession.modelRef)
                  }
                  sessionId={activeSideChatTab.sessionId}
                  sessionModelRef={currentSession.modelRef}
                  workingDirectory={currentSessionFolderPath}
                />
              )}
            </CoworkDisplayPanel>
          )}
          <ExportSessionModal
            isOpen={isSessionExportOpen}
            sessionTitle={currentSession.title}
            messageCount={sessionExportMessageCount}
            onClose={() => setIsSessionExportOpen(false)}
            onExport={handleExportSession}
          />
          {pendingMessageHistoryAction && (
            <Modal
              onClose={() => setPendingMessageHistoryAction(null)}
              className="mx-4 w-full max-w-md overflow-hidden rounded-2xl bg-surface shadow-xl"
            >
              <div className="px-5 py-4">
                <h2 className="text-base font-semibold text-foreground">
                  {i18nService.t(
                    pendingMessageHistoryAction.action === 'edit'
                      ? 'coworkEditLastMessageConfirmTitle'
                      : 'coworkWithdrawLastMessageConfirmTitle',
                  )}
                </h2>
                <p className="mt-3 text-sm leading-6 text-secondary">
                  {i18nService.t(pendingMessageHistoryAction.confirmationKey)}
                </p>
              </div>
              <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
                <button
                  type="button"
                  onClick={() => setPendingMessageHistoryAction(null)}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const pending = pendingMessageHistoryAction;
                    setPendingMessageHistoryAction(null);
                    void performLastUserMessageAction(pending);
                  }}
                  className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                    pendingMessageHistoryAction.action === 'withdraw'
                      ? 'bg-red-500 hover:bg-red-600'
                      : 'bg-primary hover:opacity-90'
                  }`}
                >
                  {i18nService.t('confirm')}
                </button>
              </div>
            </Modal>
          )}
        </div>
      </div>
    );
  }

  const homeDisplayTabs: CoworkDisplayTab[] = [
    ...recordingReviewTabs.tabs,
    ...(isBrowserPanelOpen
      ? browserTabs.map(tab => ({
          id: browserDisplayTabId(tab.targetId),
          label: getBrowserTabDisplayTitle(tab),
          icon: tab.faviconUrl ? (
            <img src={tab.faviconUrl} alt="" className="h-4 w-4 rounded-sm object-contain" />
          ) : (
            <GlobeAltIcon className="h-4 w-4" />
          ),
          onSelect: () => handleBrowserTargetChange(tab.targetId),
          onClose: () => browserPanelRefs.current.get(displaySessionKey)?.closeTab(tab.targetId),
          onContextMenu: (
            { x, y }: { x: number; y: number },
            closeActions: CoworkDisplayTabCloseActions,
          ) =>
            browserPanelRefs.current
              .get(displaySessionKey)
              ?.openTabContextMenu(tab.targetId, x, y, closeActions),
        }))
      : []),
    ...terminalTabs.map(tab => ({
      id: tab.id,
      label: tab.label,
      icon: <CommandLineIcon className="h-4 w-4" />,
      onSelect: () => setPreferredDisplayTabId(tab.id),
      onClose: () => closeTerminalTab(tab.id),
      contextMenuItems: [
        {
          id: 'open-system-terminal',
          label: getSystemTerminalLabel(),
          icon: <ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0" />,
          onSelect: () => handleOpenSystemTerminal(tab.cwd),
        },
      ],
    })),
    ...filePreviews.map(preview => ({
      id: fileDisplayTabId(preview.filePath),
      label:
        preview.kind === 'image'
          ? preview.label || i18nService.t('coworkImagePreviewTitle')
          : preview.filePath.split(/[\\/]/).pop() || preview.filePath,
      icon:
        preview.kind === 'image' ? (
          <PhotoIcon className="h-4 w-4" />
        ) : (
          <DocumentTextIcon className="h-4 w-4" />
        ),
      onSelect: () => setPreferredDisplayTabId(fileDisplayTabId(preview.filePath)),
      onClose: () => closeFilePreview(preview.filePath),
    })),
    ...unsupportedFilePreviews.map(filePath => ({
      id: fileDisplayTabId(filePath),
      label: filePath.split(/[\\/]/).pop() || filePath,
      icon: <DocumentTextIcon className="h-4 w-4" />,
      onSelect: () => setPreferredDisplayTabId(fileDisplayTabId(filePath)),
      onClose: () => closeUnsupportedFilePreview(filePath),
    })),
  ];

  // Home view - no current session
  return (
    <div className="cowork-home flex-1 flex flex-col h-full">
      {windowHeader}
      <div className="cowork-display-host relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {homeConversationHeader}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center px-4 py-10">
              <div className="space-y-12">
                {/* Welcome Section */}
                <div className="text-center space-y-5">
                  <img src={logoUrl} alt="logo" className="mx-auto h-[5.333rem] w-[5.333rem]" />
                  <h2 className="text-3xl font-bold tracking-tight text-foreground">
                    {i18nService.t(greetingKey)}
                  </h2>
                  <p className="text-sm text-secondary max-w-md mx-auto">
                    {i18nService.t('coworkGreetingSupport')}
                  </p>
                </div>

                {/* Prompt Input Area - Large version with folder selector */}
                <div className="space-y-3">
                  <div className="shadow-glow-accent rounded-2xl">
                    <CoworkPromptInput
                      ref={promptInputRef}
                      onSubmit={handleStartSession}
                      onStop={handleStopSession}
                      isStreaming={isStreaming}
                      disabled={!isEngineReady}
                      placeholder={i18nService.t('coworkPlaceholder')}
                      size="large"
                      workingDirectory={config.workingDirectory}
                      onWorkingDirectoryChange={async (dir: string) => {
                        await coworkService.updateConfig({ workingDirectory: dir });
                      }}
                      showFolderSelector={true}
                      showModelSelector={true}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {(isDisplayPanelOpen ||
          hasBrowserPanelOpened ||
          terminalTabs.length > 0 ||
          filePreviews.length > 0 ||
          unsupportedFilePreviews.length > 0 ||
          recordingReviewTabs.tabs.length > 0 ||
          hasRetainedRuntimePanels) && (
          <CoworkDisplayPanel
            key="cowork-display-panel"
            activeTabId={activeDisplayTabId ?? ''}
            isOpen={isDisplayPanelOpen}
            onClose={closeDisplayPanel}
            width={browserPanelWidth}
            onWidthChange={width =>
              setSessionField(displaySessionKey, 'browserPanelWidth', width)
            }
            showEmptyState={homeDisplayTabs.length === 0}
            tabs={homeDisplayTabs}
            emptyState={
              isWorkspaceFilesOpen ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-6 text-center">
                  <FolderIcon className="h-7 w-7 text-muted" />
                  <div className="text-sm font-semibold text-foreground">
                    {i18nService.t('coworkWorkspaceFilesOpenTitle')}
                  </div>
                  <div className="text-xs text-secondary">
                    {i18nService.t('coworkWorkspaceFilesOpenDescription')}
                  </div>
                </div>
              ) : (
                <DisplayPanelLauncher
                  browserDisabled={browserTabs.length >= MAX_BROWSER_TABS}
                  onCreateBrowser={handleCreateBrowserTab}
                  onCreateTerminal={handleCreateTerminalTab}
                  onOpenFiles={homeWorkspaceFolderPath ? handleOpenWorkspaceFiles : undefined}
                  terminalDisabled={
                    !terminalWorkingDirectory || terminalTabs.length >= MAX_TERMINAL_TABS
                  }
                />
              )
            }
            sidePanel={
              isWorkspaceFilesOpen && homeWorkspaceFolderPath ? (
                <WorkspaceFilesPanel
                  key={`${HOME_WORKSPACE_SESSION_ID}:${homeWorkspaceFolderPath}`}
                  activeFilePath={activeFilePreview?.filePath ?? activeUnsupportedFilePath}
                  sessionId={HOME_WORKSPACE_SESSION_ID}
                  onOpenFile={filePath => {
                    window.dispatchEvent(
                      new CustomEvent('cowork:preview-file', {
                        detail: {
                          filePath,
                          keepWorkspaceFilesOpen: true,
                          workingDirectory: homeWorkspaceFolderPath,
                        },
                      }),
                    );
                  }}
                />
              ) : undefined
            }
            actions={
              <NewDisplayTabMenu
                browserDisabled={browserTabs.length >= MAX_BROWSER_TABS}
                onCreateBrowser={handleCreateBrowserTab}
                onCreateTerminal={handleCreateTerminalTab}
                onOpenFiles={homeWorkspaceFolderPath ? handleOpenWorkspaceFiles : undefined}
                terminalDisabled={
                  !terminalWorkingDirectory || terminalTabs.length >= MAX_TERMINAL_TABS
                }
              />
            }
          >
            {retainedRuntimePanels}
            {recordingReviewTabs.panels(activeDisplayTabId)}
            {filePreviews.map(preview => (
              <FilePreviewDrawer
                key={fileDisplayTabId(preview.filePath)}
                ref={drawer => {
                  const tabId = fileDisplayTabId(preview.filePath);
                  if (drawer) filePreviewDrawerRefs.current.set(tabId, drawer);
                  else filePreviewDrawerRefs.current.delete(tabId);
                }}
                preview={preview}
                onClose={() => void closeFilePreview(preview.filePath)}
                isObscured={activeFilePreview?.filePath !== preview.filePath}
                embedded
              />
            ))}
            {unsupportedFilePreviews.map(filePath => (
              <UnsupportedFilePreview
                key={fileDisplayTabId(filePath)}
                filePath={filePath}
                onClose={() => closeUnsupportedFilePreview(filePath)}
                isObscured={activeUnsupportedFilePath !== filePath}
              />
            ))}
          </CoworkDisplayPanel>
        )}
      </div>
    </div>
  );
});

CoworkView.displayName = 'CoworkView';

export default CoworkView;
