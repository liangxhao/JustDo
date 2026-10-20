import {
  AdjustmentsHorizontalIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  ChatBubbleLeftEllipsisIcon,
  ClipboardDocumentCheckIcon,
  CommandLineIcon,
  DocumentPlusIcon,
  DocumentTextIcon,
  LinkIcon,
  PhotoIcon,
  QueueListIcon,
  ShareIcon,
} from '@heroicons/react/24/outline';
import { MAIN_USER_AGENT_ID } from '@shared/agents/agents';
import { SaveTextFileErrorCode } from '@shared/app/dialogIpc';
import {
  BROWSER_ANNOTATION_CONTEXT_MAX_LENGTH,
  type BrowserAgentInteractionState,
  type BrowserAnnotationDraft,
  composeBrowserGatewayPrompt,
  serializeBrowserAnnotationContext,
} from '@shared/browser/browser';
import { BrowserLinkTarget, isWebBrowserLink } from '@shared/browser/browserLinkOpening';
import { recordingImagesInStepOrder } from '@shared/browser/browserRecording';
import { DEFAULT_MAX_RETAINED_DISPLAY_TABS } from '@shared/cowork/displayTabRetention';
import { CoworkInteractionKind } from '@shared/cowork/interactions/interactions';
import {
  COWORK_PLAN_PREVIEW_EVENT,
  isCoworkPlanPreview,
} from '@shared/cowork/interactions/planPreview';
import { getMessageTitleInput } from '@shared/cowork/messageInput';
import { REVIEW_OPEN_EVENT, REVIEW_TAB_ID } from '@shared/cowork/sessionReview';
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { isGoalEditCommand } from '@shared/cowork/slashCommands';
import { ExternalSessionSource } from '@shared/integrations/externalSession';
import { type ProgressCard, type ProgressCardViewState } from '@shared/openclaw/progressCard';
import { OpenClawToolName } from '@shared/plugins/nativeIds';
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

import { observeChatContentWidth } from '@/app/chatContentWidth';
import RestoredHistoryNotice from '@/app/shell/startup/history/RestoredHistoryNotice';
import ApplicationLoading, {
  useInitialWorkspaceReadiness,
} from '@/app/shell/startup/routing/ApplicationLoading';
import { RendererStartupActivity } from '@/app/shell/startup/routing/startupPresentation';
import {
  getEngineReadinessSnapshot,
  useEngineReadiness,
} from '@/app/shell/startup/routing/useEngineReadiness';
import {
  BROWSER_ANNOTATION_MAX_COUNT,
  BROWSER_ANNOTATION_MAX_IMAGE_BYTES,
  browserAnnotationDataBytes,
} from '@/features/browser/annotation/browserAnnotation';
import BrowserPanel, {
  BROWSER_PANEL_DEFAULT_WIDTH,
  type BrowserPanelHandle,
  getBrowserTabDisplayTitle,
} from '@/features/browser/BrowserPanel';
import {
  type PendingBrowserAgentPanelState,
  promoteBrowserPanelTabs,
  promotePendingBrowserPanelItems,
} from '@/features/browser/browserPanelRetention';
import BrowserTabIcon from '@/features/browser/BrowserTabIcon';
import { browserTaskStopped } from '@/features/browser/intervention/browserTaskStopped';
import { MessageBrowserEvent } from '@/features/browser/messageBrowserLinks';
import { recordingSubmissionIssue } from '@/features/browser/recording/browserRecordingSubmission';
import { getBrowserTabLimit, useBrowserTabLimit } from '@/features/browser/useBrowserTabLimit';
import PlanApprovalDrawer from '@/features/cowork/components/approvals/PlanApprovalDrawer';
import {
  initialPlanPreviewState,
  planPreviewReducer,
  retainedPlanForSession,
} from '@/features/cowork/components/approvals/planPreviewState';
import JustDoChatWrapper, {
  type JustDoChatWrapperRef,
} from '@/features/cowork/components/chat/JustDoChatWrapper';
import SideChatPanel from '@/features/cowork/components/chat/SideChatPanel';
import CoworkPromptInput, {
  appendMediaDirectiveLines,
  type CoworkPromptInputRef,
} from '@/features/cowork/components/composer/CoworkPromptInput';
import { COMPOSER_FRAME_CLASS } from '@/features/cowork/components/composer/draft/composerStyles';
import { resolveAgentModelSelection } from '@/features/cowork/components/composer/selection/agentModelSelection';
import { captureHomeComposerModelRef } from '@/features/cowork/components/composer/selection/homeModelSelection';
import {
  type ComposerSubmissionMetadata,
  resolveComposerSubmissionStartedAt,
} from '@/features/cowork/components/composer/submission/composerSubmissionTiming';
import { submitCoworkMessage } from '@/features/cowork/components/composer/submission/coworkMessageSubmit';
import { QueuedInputCards } from '@/features/cowork/components/composer/submission/QueuedInputCards';
import CoworkDisplayPanel, {
  type CoworkDisplayTab,
  type CoworkDisplayTabCloseActions,
} from '@/features/cowork/components/display/CoworkDisplayPanel';
import DisplayPanelLauncher from '@/features/cowork/components/display/DisplayPanelLauncher';
import SessionSummaryPanel from '@/features/cowork/components/display/summary/SessionSummaryPanel';
import SessionSummaryResourceList from '@/features/cowork/components/display/summary/SessionSummaryResourceList';
import { useSessionSummaryVisibility } from '@/features/cowork/components/display/summary/useSessionSummaryVisibility';
import { getAdjacentDisplayTabId } from '@/features/cowork/components/display/tabs/displayTabSelection';
import NewDisplayTabButton from '@/features/cowork/components/display/tabs/NewDisplayTabButton';
import { useDisplayTabOrder } from '@/features/cowork/components/display/tabs/useDisplayTabOrder';
import { useMcpAppTabs } from '@/features/cowork/components/display/tabs/useMcpAppTabs';
import { useRecordingReviewTabs } from '@/features/cowork/components/display/tabs/useRecordingReviewTabs';
import {
  HOME_DISPLAY_SESSION_KEY,
  useSessionDisplayState,
} from '@/features/cowork/components/display/tabs/useSessionDisplayState';
import { WORKSPACE_PRESENTATION_EVENT } from '@/features/cowork/components/display/workspace/useWorkspacePortal';
import { inferInitialGoalObjective } from '@/features/cowork/components/goals/goalPendingObjective';
import { useSessionRunProgress } from '@/features/cowork/components/goals/useSessionRunProgress';
import type { OpenMcpAppFile } from '@/features/cowork/components/mcpApps/fileApps';
import type { McpAppComposerMenu } from '@/features/cowork/components/mcpApps/McpAppsControls';
import { saveAppMessageAttachments } from '@/features/cowork/components/mcpApps/messageAttachments';
import { useHomeFileApps } from '@/features/cowork/components/mcpApps/useHomeFileApps';
import FilePreviewDrawer, {
  type FilePreviewDrawerHandle,
} from '@/features/cowork/components/preview/FilePreviewDrawer';
import {
  type FilePreviewNavigationOptions,
  isFilePreviewWithinPath,
} from '@/features/cowork/components/preview/filePreviewNavigation';
import { IMAGE_PREVIEW_EVENT } from '@/features/cowork/components/preview/imageFilePreview';
import { MessageFileLinkContext } from '@/features/cowork/components/preview/messageFileLinks';
import { openSummaryResource } from '@/features/cowork/components/preview/openSummaryResource';
import {
  SummaryMediaPreview,
  type SummaryMediaPreviewSource,
} from '@/features/cowork/components/preview/SummaryMediaPreview';
import UnsupportedFilePreview from '@/features/cowork/components/preview/UnsupportedFilePreview';
import { useFilePreviewEvents } from '@/features/cowork/components/preview/useFilePreviewEvents';
import { useMessageFileLinkNavigation } from '@/features/cowork/components/preview/useMessageFileLinkNavigation';
import WorkspaceFilesPanel from '@/features/cowork/components/preview/WorkspaceFilesPanel';
import ExportSessionModal from '@/features/cowork/components/sessions/ExportSessionModal';
import { getCompactFolderName, getLastPathSegment } from '@/features/cowork/components/shared/path';
import WorkspaceFileIcon from '@/features/cowork/components/shared/WorkspaceFileIcon';
import { CoworkPet } from '@/features/cowork/components/status/CoworkPet';
import { isCoworkRunActive } from '@/features/cowork/components/status/coworkRunActivity';
import {
  resolveBackgroundRuntimeDiscoverySessionIds,
  resolveBackgroundRuntimeSessionIds,
} from '@/features/cowork/components/status/runtimePolling';
import type { ProgressCardRunState } from '@/features/cowork/components/status/SessionProgressCard';
import { loadSpawnedSubtask } from '@/features/cowork/components/subagents/spawnedSubtask';
import SubagentMessageDrawer from '@/features/cowork/components/subagents/SubagentMessageDrawer';
import SubtaskListPanel from '@/features/cowork/components/subagents/SubtaskListPanel';
import type { Subtask } from '@/features/cowork/components/subagents/subtaskPresentation';
import TerminalPanel from '@/features/cowork/components/terminal/TerminalPanel';
import {
  selectCoworkConfig,
  selectCurrentSession,
  selectCurrentSessionMainRuntimeRunning,
  selectDraftBrowserAnnotations,
  selectIsOpenClawEngine,
  selectIsStreaming,
  selectSessionDirectory,
  selectSessionRuntimeActivity,
  selectSessionRunTimings,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import { addDraftMessageQuote, removeDraftMessageQuotes } from '@/features/cowork/coworkSlice';
import {
  addDraftBrowserAnnotation,
  clearCurrentSession,
  clearDraftBrowserAnnotations,
  type DraftAttachment,
  setCurrentSession,
  setDraftAttachments,
  setDraftBrowserRecording,
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
} from '@/features/cowork/coworkTypes';
import {
  buildSessionExportFileName,
  createSessionExportDocument,
} from '@/features/cowork/sessionExport';
import { type CoworkSessionListActionDetail } from '@/features/cowork/sessionListActions';
import { AppPluginSlot } from '@/features/plugins/app/AppPluginSlot';
import { useAppWorkspace } from '@/features/plugins/app/useAppWorkspace';
import { clearActiveSkills } from '@/features/plugins/skills/skillSlice';
import type { SettingsOpenOptions } from '@/features/settings/Settings';
import type {
  ChatContextUsageSnapshot,
  RewindEditorDraft,
} from '@/libs/openclaw-chat/gateway/chat-controller';
import type { QueuedInputSnapshot } from '@/libs/openclaw-chat/gateway/input/chat-pending-inputs';
import type {
  SessionSummaryResources,
  SummaryResource,
} from '@/libs/openclaw-chat/model/timeline/session-summary-resources';
import { OPEN_SPAWNED_AGENT_EVENT } from '@/libs/openclaw-chat/model/tools/spawn-tool-target';
import { i18nService } from '@/services/i18n';
import { getGreetingPeriod, pickHomeGreeting } from '@/services/i18n/homeGreetings';
import BrainIcon from '@/shared/components/icons/BrainIcon';
import FolderIcon from '@/shared/components/icons/FolderIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import Modal from '@/shared/components/ui/Modal';
import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';
import { type RootState, store } from '@/store';

import type { AppSubmission } from '../../../../../packages/app-plugin-sdk/contracts';
import { readAppInput } from '../../../../../plugins/extensions/runtime-services/contracts/app-input';
import { renderCoworkHomeWorkspace } from './chat/CoworkHomeWorkspace';
import { useCoworkSideChats } from './chat/useCoworkSideChats';
import type { MessageQuoteHandler } from './composer/draft/messageQuote';
import {
  bindSessionSubmissionRun,
  createSessionSubmission,
  getSessionStopOperationKey,
  type SessionSubmission,
  stopSessionSubmission,
} from './composer/submission/sessionSubmission';
import {
  BROWSER_DISPLAY_TAB_PREFIX,
  browserDisplayTabId,
  FILE_DISPLAY_TAB_PREFIX,
  fileDisplayTabId,
  MAX_TERMINAL_TABS,
  PLAN_DISPLAY_TAB_ID,
  SUBAGENT_DISPLAY_TAB_ID,
  SUBAGENTS_DISPLAY_TAB_ID,
  SUMMARY_RESOURCE_DISPLAY_TAB_IDS,
  type SummaryResourceListKind,
  TERMINAL_DISPLAY_TAB_PREFIX,
  WORKSPACE_FILES_DISPLAY_TAB_ID,
} from './display/tabs/displayTabIds';
import { useCoworkBrowserPanels } from './display/tabs/useCoworkBrowserPanels';
import { useMcpAppReferenceTabs } from './display/tabs/useMcpAppReferenceTabs';
import { useWebpageEmbedTabs } from './display/tabs/useWebpageEmbedTabs';
import { useWidgetReferenceTabs } from './display/tabs/useWidgetReferenceTabs';
import SessionReviewPanel from './review/SessionReviewPanel';
import type { SessionTranscriptMutation } from './sessions/useCoworkSessionActions';
import {
  getSessionTranscriptActionError,
  useCoworkSessionActions,
} from './sessions/useCoworkSessionActions';
import { useCoworkRuntimePolling } from './status/useCoworkRuntimePolling';
import { useSessionFocusRefresh } from './status/useSessionFocusRefresh';

const DEBUG_COWORK_VIEW =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_COWORK_VIEW === 'true';

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
  onNewChat?: () => void;
  planInteraction?: CoworkInteractionRequest | null;
  onPlanRespond?: (result: CoworkInteractionResult) => Promise<boolean>;
}

export interface CoworkViewHandle {
  requestFilePreviewTransition: (options?: FilePreviewNavigationOptions) => Promise<boolean>;
  revealSearchMatch: (
    match: import('@shared/cowork/sessionSearch').CoworkSessionMessageSearchMatch,
  ) => void;
}

// Keep the last greeting across home view remounts in this app session.
let lastHomeGreeting: string | undefined;

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
    onNewChat,
    planInteraction = null,
    onPlanRespond,
  } = props;
  const dispatch = useDispatch();
  const currentSession = useSelector(selectCurrentSession);
  const currentSessionId = currentSession?.id ?? null;
  const chatWidthCleanupRef = useRef<(() => void) | null>(null);
  const bindChatContentWidth = useCallback((pane: HTMLDivElement | null): void => {
    chatWidthCleanupRef.current?.();
    chatWidthCleanupRef.current = null;
    if (!pane?.parentElement) return;
    const observer = observeChatContentWidth(pane, window.electron?.window, pane.parentElement);
    chatWidthCleanupRef.current = observer.dispose;
  }, []);
  const [isWorkspaceDetached, setIsWorkspaceDetached] = useState(false);
  const sessions = useSelector(selectSessionDirectory);
  const config = useSelector(selectCoworkConfig);
  const [isInitialized, setIsInitialized] = useState(false);
  const [startupActivity, setStartupActivity] = useState<RendererStartupActivity>(
    RendererStartupActivity.Conversations,
  );
  const [startupError, setStartupError] = useState<string | null>(null);
  useInitialWorkspaceReadiness(isInitialized, startupError);
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
  const [subtaskSnapshot, setSubtaskSnapshot] = useState<{
    sessionId: string | null;
    tasks: Subtask[];
  }>();
  const subtasks = subtaskSnapshot?.sessionId === currentSessionId ? subtaskSnapshot.tasks : [];
  const [subagentsPortalTarget, setSubagentsPortalTarget] = useState<HTMLDivElement | null>(null);
  const [summaryResources, setSummaryResources] = useState<SessionSummaryResources | null>(null);
  const {
    sessionKey: displaySessionKey,
    states: displayStates,
    state: {
      selectedSubagent,
      isSubagentsTabOpen,
      summaryResourceTabs,
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
      isWorkspaceFilesTabOpen,
      isReviewOpen,
      reviewFocusPath,
      reviewFocusVersion,
      filesRevealPath,
      filesRevealVersion,
      filePreviews,
      unsupportedFilePreviews,
    },
    setters: {
      setSelectedSubagent,
      setIsSubagentsTabOpen,
      setSummaryResourceTabs,
      setIsDisplayPanelOpen,
      setIsBrowserPanelOpen,
      setHasBrowserPanelOpened,
      setBrowserPanelTargetId,
      setBrowserTabCreationSequence,
      setTerminalTabs,
      setPreferredDisplayTabId,
      setSideChatTabs,
      setIsWorkspaceFilesOpen,
      setIsWorkspaceFilesTabOpen,
      setIsReviewOpen,
      setReviewFocusPath,
      setReviewFocusVersion,
      setFilesRevealPath,
      setFilesRevealVersion,
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
  const isWorkspaceVisible = isDisplayPanelOpen || isWorkspaceDetached;
  const detachedRef = useRef(false);
  useEffect(() => {
    const listener = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail === true;
      if (detachedRef.current && !next) setIsDisplayPanelOpen(true);
      detachedRef.current = next;
      setIsWorkspaceDetached(next);
    };
    window.addEventListener(WORKSPACE_PRESENTATION_EVENT, listener);
    return () => window.removeEventListener(WORKSPACE_PRESENTATION_EVENT, listener);
  }, [setIsDisplayPanelOpen]);
  const summaryToggleRef = useRef<HTMLButtonElement>(null);
  const displayPanelToggleRef = useRef<HTMLButtonElement>(null);
  const [planPreviewState, dispatchPlanPreview] = useReducer(
    planPreviewReducer,
    initialPlanPreviewState,
  );
  const [queuedInputs, setQueuedInputs] = useState<QueuedInputSnapshot | null>(null);
  const [goalPresence, setGoalPresence] = useState<{
    sessionId: string | undefined;
    hasGoal: boolean;
    ready: boolean;
    objective?: string;
  }>({ sessionId: undefined, hasGoal: false, ready: false });
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
    nativeSessionKey?: string;
    nativeSessionId?: string;
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
  const maximumBrowserTabs = useBrowserTabLimit();
  const continueBrowserTaskRef = useRef<
    | ((
        sessionId: string,
        prompt: string,
      ) => Promise<import('@shared/browser/browserIntervention').BrowserContinueResult>)
    | null
  >(null);
  continueBrowserTaskRef.current = null;
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
      getBrowserTabLimit(),
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
  const [mcpAppMenu, setMcpAppMenu] = useState<McpAppComposerMenu | null>(null);
  const [historyReadiness, setHistoryReadiness] = useState<{
    sessionKey: string;
    ready: boolean;
  } | null>(null);
  const handleHistoryReadyChange = useCallback((sessionKey: string, ready: boolean) => {
    setHistoryReadiness({ sessionKey, ready });
  }, []);
  const pendingMessageSubmissionsRef = useRef(new Map<string, SessionSubmission>());
  // Buffer for pending user message when JustDoChatWrapper isn't mounted yet
  const pendingPromptRef = useRef<string | null>(null);
  const pendingAttachmentsRef = useRef<CoworkAttachmentPayload[]>([]);
  const pendingGatewayPromptRef = useRef<string | undefined>(undefined);
  const pendingInitialGoalRef = useRef<{ sessionId: string; objective: string } | null>(null);

  const handleGoalPresenceChange = useCallback(
    (sessionId: string | undefined, hasGoal: boolean, ready: boolean, objective?: string) => {
      setGoalPresence(current =>
        current.sessionId === sessionId &&
        current.hasGoal === hasGoal &&
        current.ready === ready &&
        current.objective === objective
          ? current
          : { sessionId, hasGoal, ready, objective },
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
  const mcpAppTabs = useMcpAppTabs(
    displaySessionKey,
    id => {
      setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(id);
    },
    () => setIsDisplayPanelOpen(true),
  );
  const mcpAppReferences = useMcpAppReferenceTabs(
    displaySessionKey,
    id => {
      setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(id);
    },
    () => setIsDisplayPanelOpen(true),
    mcpAppMenu?.sessionId === currentSessionId ? mcpAppMenu.fileCatalog : undefined,
    isInitialized ? sessions.map(session => session.id) : undefined,
  );
  const widgetReferences = useWidgetReferenceTabs(
    displaySessionKey,
    id => {
      setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(id);
    },
    () => setIsDisplayPanelOpen(true),
    isInitialized ? sessions.map(session => session.id) : undefined,
  );
  const webpageReferences = useWebpageEmbedTabs(
    displaySessionKey,
    id => {
      setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(id);
    },
    () => setIsDisplayPanelOpen(true),
    isInitialized ? sessions.map(session => session.id) : undefined,
  );
  const appFileOpenerRef = useRef<OpenMcpAppFile>(async () => false);
  const homeFileOpenerRef = useRef<OpenMcpAppFile>(async () => false);
  appFileOpenerRef.current = async request => {
    if (!request.isCurrent()) return false;
    if (mcpAppTabs.focusFile(request.filePath)) return true;
    if (!currentSessionId) return homeFileOpenerRef.current(request);
    return mcpAppMenu?.sessionId === currentSessionId
      ? ((await mcpAppMenu.openFile?.(request)) ?? false)
      : false;
  };
  const openAppFile = useCallback<OpenMcpAppFile>(request => appFileOpenerRef.current(request), []);
  const openAppWorkspace = useCallback(
    (id: string) => {
      setPreferredDisplayTabId(id);
      setIsDisplayPanelOpen(true);
      setIsWorkspaceFilesOpen(false);
    },
    [setPreferredDisplayTabId, setIsDisplayPanelOpen, setIsWorkspaceFilesOpen],
  );
  const appWorkspace = useAppWorkspace(currentSessionId, openAppWorkspace);
  const unorderedDisplayTabIds = useMemo(
    () => [
      ...(isBrowserPanelOpen ? browserTabs.map(tab => browserDisplayTabId(tab.targetId)) : []),
      ...terminalTabs.map(tab => tab.id),
      ...(isWorkspaceFilesTabOpen ? [WORKSPACE_FILES_DISPLAY_TAB_ID] : []),
      ...filePreviews.map(preview => fileDisplayTabId(preview.filePath)),
      ...unsupportedFilePreviews.map(fileDisplayTabId),
      ...(visiblePlanInteraction ? [PLAN_DISPLAY_TAB_ID] : []),
      ...(selectedSubagent ? [SUBAGENT_DISPLAY_TAB_ID] : []),
      ...(isSubagentsTabOpen ? [SUBAGENTS_DISPLAY_TAB_ID] : []),
      ...summaryResourceTabs.map(kind => SUMMARY_RESOURCE_DISPLAY_TAB_IDS[kind]),
      ...appWorkspace.views.map(view => view.tabId),
      ...(isReviewOpen ? [REVIEW_TAB_ID] : []),
      ...sideChatTabs.map(tab => tab.id),
      ...recordingReviewTabs.tabs.map(tab => tab.id),
      ...mcpAppTabs.tabs.map(tab => tab.id),
      ...mcpAppReferences.tabs.map(tab => tab.id),
      ...widgetReferences.tabs.map(tab => tab.id),
      ...webpageReferences.tabs.map(tab => tab.id),
    ],
    [
      appWorkspace.views,
      browserTabs,
      filePreviews,
      isBrowserPanelOpen,
      isWorkspaceFilesTabOpen,
      selectedSubagent,
      isSubagentsTabOpen,
      summaryResourceTabs,
      isReviewOpen,
      sideChatTabs,
      terminalTabs,
      unsupportedFilePreviews,
      visiblePlanInteraction,
      recordingReviewTabs.tabs,
      mcpAppTabs.tabs,
      mcpAppReferences.tabs,
      widgetReferences.tabs,
      webpageReferences.tabs,
    ],
  );
  const { orderedIds: availableDisplayTabIds, replaceTab } = useDisplayTabOrder(
    displayStates[displaySessionKey]?.runtimeId ?? displaySessionKey,
    unorderedDisplayTabIds,
  );
  const sortDisplayTabs = (tabs: CoworkDisplayTab[]) => {
    const positions = new Map(availableDisplayTabIds.map((id, index) => [id, index]));
    return [...tabs].sort(
      (a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity),
    );
  };
  const openReview = useCallback(
    (filePath = '') => {
      if (!currentSessionId) return;
      setIsReviewOpen(true);
      setReviewFocusPath(filePath);
      setReviewFocusVersion(value => value + 1);
      setIsDisplayPanelOpen(true);
      setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(REVIEW_TAB_ID);
    },
    [
      currentSessionId,
      setIsReviewOpen,
      setReviewFocusPath,
      setReviewFocusVersion,
      setIsDisplayPanelOpen,
      setIsWorkspaceFilesOpen,
      setPreferredDisplayTabId,
    ],
  );
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; path: string }>).detail;
      if (detail?.sessionId === currentSessionId) openReview(detail.path);
    };
    window.addEventListener(REVIEW_OPEN_EVENT, listener);
    return () => window.removeEventListener(REVIEW_OPEN_EVENT, listener);
  }, [currentSessionId, openReview]);
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
        dispatch(removeDraftMessageQuotes({ draftKey: tab.id }));
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
      void chatWrapperRef.current
        ?.revealMessage(pendingSourceReveal.entryId, {
          sessionKey: pendingSourceReveal.nativeSessionKey,
          sessionId: pendingSourceReveal.nativeSessionId,
          isCurrent: () =>
            !cancelled && currentSessionIdRef.current === pendingSourceReveal.sessionId,
        })
        .then(revealed => {
          if (!cancelled && !revealed && pendingSourceReveal.nativeSessionId) {
            window.dispatchEvent(
              new CustomEvent('app:showToast', {
                detail: i18nService.t('searchMessageUnavailable'),
              }),
            );
          }
        })
        .catch(() => {
          if (!cancelled && pendingSourceReveal.nativeSessionId) {
            window.dispatchEvent(
              new CustomEvent('app:showToast', {
                detail: i18nService.t('searchMessageUnavailable'),
              }),
            );
          }
        })
        .finally(() => {
          if (!cancelled)
            setPendingSourceReveal(previous =>
              previous === pendingSourceReveal ? null : previous,
            );
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
  const engineReadiness = useEngineReadiness();
  const isEngineReady = !isOpenClawEngine || engineReadiness.ready;
  const engineUnavailableMessage = isEngineReady
    ? undefined
    : i18nService.t(engineReadiness.pending ? 'enginePreparingSend' : 'engineUnavailableSend');
  const agentState = useSelector((state: RootState) => state.agent);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const currentAgentId = config.allowMainAgentSwitch
    ? agentState.currentAgentId
    : MAIN_USER_AGENT_ID;
  const homeApps = useHomeFileApps({
    currentSessionId,
    sessionIds: sessions.map(session => session.id),
    sessionInteractive:
      sessionTranscriptMutation === null &&
      !currentSession?.external?.readOnly &&
      !currentSession?.branchCreationPending,
    enabled: !currentSessionId,
    cwd: config.workingDirectory.trim(),
    agentId: currentAgentId,
    permissionMode: config.permissionMode,
    addDraft: async text => {
      const active = store.getState().cowork.currentSession;
      if (
        (active?.id !== currentSessionIdRef.current && Boolean(currentSessionIdRef.current)) ||
        active?.external?.readOnly ||
        active?.branchCreationPending ||
        sessionTranscriptMutationRef.current !== null ||
        active?.id.startsWith('temp-') ||
        !text.trim() ||
        text.length > 4000 ||
        /^\s*[!/]/.test(text)
      )
        return false;
      if (promptInputRef.current) promptInputRef.current.appendValue(text);
      else {
        const draftKey = active?.id ?? HOME_DISPLAY_SESSION_KEY;
        const previous = store.getState().cowork.draftPrompts[draftKey] ?? '';
        dispatch(
          setDraftPrompt({
            sessionId: draftKey,
            draft: previous ? `${previous}\n\n${text}` : text,
          }),
        );
      }
      return true;
    },
  });
  homeFileOpenerRef.current = homeApps.openFile;
  const currentSessionMainRunning = useSelector(selectCurrentSessionMainRuntimeRunning);
  const currentSessionRuntimeRunning = currentSession
    ? currentSession.id.startsWith('temp-')
      ? currentSession.status === 'running'
      : sessionRuntimeActivity[currentSession.id] === true
    : isStreaming;
  const currentSessionRuntimeRunningRef = useRef(currentSessionRuntimeRunning);
  currentSessionRuntimeRunningRef.current = currentSessionRuntimeRunning;
  const canonicalGatewaySessionKey = currentSession
    ? currentSession.nativeSessionKey ||
      currentSession.external?.sessionKey ||
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
  const { progress: goalRunProgress, onActivityChange } =
    useSessionRunProgress(currentGatewaySessionKey);
  const summaryNavigationScope = useRef({ sessionKey: currentGatewaySessionKey, generation: 0 });
  if (summaryNavigationScope.current.sessionKey !== currentGatewaySessionKey) {
    summaryNavigationScope.current = {
      sessionKey: currentGatewaySessionKey,
      generation: summaryNavigationScope.current.generation + 1,
    };
  }
  const summaryResourceRequest = useRef(0);
  const [summaryMediaPreview, setSummaryMediaPreview] = useState<{
    source: SummaryMediaPreviewSource;
    scope: typeof summaryNavigationScope.current;
  } | null>(null);
  const currentSummaryResources =
    summaryResources?.sessionKey === currentGatewaySessionKey ? summaryResources : null;
  const summaryObjective =
    goalPresence.sessionId === currentSessionId ? goalPresence.objective : undefined;
  const progressCard =
    progressCardState?.sessionKey === currentGatewaySessionKey ? progressCardState.card : null;
  const summaryVisibility = useSessionSummaryVisibility(
    currentSessionId,
    !!summaryObjective ||
      !!progressCard ||
      subtasks.length > 0 ||
      appWorkspace.hasSummary ||
      appWorkspace.views.length > 0 ||
      !!currentSummaryResources?.outputs.length ||
      !!currentSummaryResources?.sources.length,
  );
  const handleGoalResumeAccepted = useCallback((sessionId: string, runId: string) => {
    if (currentSessionIdRef.current !== sessionId) return;
    const sessionKey = currentGatewaySessionKeyRef.current;
    if (sessionKey) chatWrapperRef.current?.beginGoalResume(sessionKey, runId);
  }, []);
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

  const ensureOpenClawReadyForSubmit = (): boolean => {
    if (!isOpenClawEngine || getEngineReadinessSnapshot().ready) {
      return true;
    }
    window.dispatchEvent(
      new CustomEvent('app:showToast', { detail: i18nService.t('coworkErrorEngineNotReady') }),
    );
    return false;
  };

  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        await coworkService.init();
        if (!active) return;
        setStartupActivity(RendererStartupActivity.EngineStatus);
        await coworkService.getOpenClawEngineStatus();
        if (!active) return;
        setIsInitialized(true);
      } catch (error) {
        console.error('[CoworkView] Workspace initialization failed:', error);
        if (active) setStartupError(i18nService.t('initializationError'));
      }
    };
    init();

    return () => {
      active = false;
    };
  }, [dispatch]);

  const handleStartSession = async (
    prompt: string,
    attachments?: CoworkAttachmentPayload[],
    gatewayPrompt?: string,
    worktree?: boolean,
    _pluginSubmission?: AppSubmission,
    submission?: ComposerSubmissionMetadata,
  ): Promise<boolean | void> => {
    const modelRef = captureHomeComposerModelRef(store.getState(), currentAgentId);
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

      let hasHomeApps = false;
      try {
        hasHomeApps = await mcpAppTabs.prepareContext();
      } catch {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('mcpAppsContextPrepareFailed'),
          }),
        );
        return false;
      }
      if (isPendingStartCancelled()) return false;
      if (hasHomeApps && worktree) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('mcpAppsWorkspaceStartUnavailable'),
          }),
        );
        return false;
      }

      // Create a temporary session with user message to show immediately
      const startInPlanMode = store.getState().cowork.newSessionPlanMode;
      const tempSessionId = `temp-${Date.now()}`;
      let appWorkspaceRequestId: string | undefined;
      try {
        appWorkspaceRequestId = hasHomeApps ? homeApps.beginStart(tempSessionId) : undefined;
      } catch {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('mcpAppsContextPrepareFailed'),
          }),
        );
        return false;
      }
      if (pendingStartRef.current?.requestId === requestId)
        pendingStartRef.current.temporarySessionId = tempSessionId;
      const titleInput = getMessageTitleInput(prompt, attachments, gatewayPrompt);
      const fallbackTitle =
        titleInput.split('\n')[0].slice(0, 50) || i18nService.t('coworkAttachmentSession');
      const now = resolveComposerSubmissionStartedAt(submission);
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
      mcpAppTabs.promote(HOME_DISPLAY_SESSION_KEY, tempSessionId);
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
          appWorkspaceRequestId,
          gatewayPrompt,
          title: fallbackTitle,
          cwd: config.workingDirectory || undefined,
          activeSkillIds: sessionSkillIds,
          agentId: currentAgentId,
          modelRef,
          attachments,
          clientTurnId,
          startedAt: now,
          planMode: startInPlanMode,
          worktree: worktree === true,
        },
        {
          dispatchInitialTurn: async (request, isTransportCancelled) => {
            if (
              isPendingStartCancelled() ||
              isTransportCancelled() ||
              request.clientTurnId !== clientTurnId
            ) {
              throw Object.assign(new Error(i18nService.t('coworkInitialDispatchCancelled')), {
                requestSent: false,
              });
            }
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
              if (isPendingStartCancelled() || isTransportCancelled())
                throw Object.assign(new Error(i18nService.t('coworkInitialDispatchCancelled')), {
                  requestSent: false,
                });
              if (chatWrapperRef.current?.isInitialDispatchReady(request.sessionKey)) {
                if (appWorkspaceRequestId) {
                  try {
                    if (!(await mcpAppTabs.prepareContext()))
                      throw new Error('App context is unavailable');
                  } catch {
                    throw Object.assign(new Error(i18nService.t('mcpAppsContextPrepareFailed')), {
                      requestSent: false,
                    });
                  }
                  if (isPendingStartCancelled() || isTransportCancelled())
                    throw Object.assign(
                      new Error(i18nService.t('coworkInitialDispatchCancelled')),
                      {
                        requestSent: false,
                      },
                    );
                }
                return chatWrapperRef.current!.dispatchInitialTurn(
                  request.params,
                  () => isPendingStartCancelled() || isTransportCancelled(),
                );
              }
              await new Promise(resolve => setTimeout(resolve, 30));
            }
            throw Object.assign(new Error(i18nService.t('coworkInitialDispatchUnavailable')), {
              requestSent: false,
            });
          },
          beforeSessionSelected: session => {
            if (pendingStartRef.current?.requestId === requestId)
              pendingStartRef.current.canonicalSessionId = session.id;
            promoteDisplaySession(tempSessionId, session.id);
            homeApps.promote(tempSessionId, session.id);
            mcpAppTabs.promote(tempSessionId, session.id);
            summaryVisibility.promote(tempSessionId, session.id);
            promoteBrowserPanelTabs(tempSessionId, session.id);
            browserPanelRefs.current.forEach(panel =>
              panel.promoteRecordingSession(tempSessionId, session.id),
            );
            promotePendingBrowserTabs(tempSessionId, session.id);
            const sourceAgentId = currentAgentId?.trim() || 'main';
            const targetAgentId = session.agentId?.trim() || sourceAgentId;
            chatWrapperRef.current?.registerSessionPromotion(
              `agent:${sourceAgentId}:justdo:${tempSessionId}`,
              session.nativeSessionKey ||
                session.external?.sessionKey ||
                `agent:${targetAgentId}:justdo:${session.id}`,
            );
          },
        },
      );

      if (!startedSession && (startError || startCancelled)) {
        if (appWorkspaceRequestId && !pendingStartRef.current?.canonicalSessionId) {
          homeApps.rollback(tempSessionId);
          mcpAppTabs.promote(tempSessionId, HOME_DISPLAY_SESSION_KEY);
          promoteDisplaySession(tempSessionId, HOME_DISPLAY_SESSION_KEY);
          if (store.getState().cowork.currentSession?.id === tempSessionId)
            dispatch(clearCurrentSession());
        }
        const failedSessionId =
          pendingStartRef.current?.requestId === requestId
            ? (pendingStartRef.current.canonicalSessionId ?? tempSessionId)
            : tempSessionId;
        const selected = store.getState().cowork.currentSession;
        const failedSessionKey =
          selected?.id === failedSessionId
            ? selected.nativeSessionKey ||
              selected.external?.sessionKey ||
              `agent:${selected.agentId?.trim() || 'main'}:justdo:${failedSessionId}`
            : `agent:${currentAgentId?.trim() || 'main'}:justdo:${failedSessionId}`;
        dispatch(
          updateSessionStatus({
            sessionId: failedSessionId,
            status: startCancelled ? 'idle' : 'error',
          }),
        );
        chatWrapperRef.current?.clearSending(failedSessionKey);
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
          const sessionKey =
            startedSession.nativeSessionKey ||
            startedSession.external?.sessionKey ||
            `agent:${startedSession.agentId?.trim() || 'main'}:justdo:${startedSession.id}`;
          chatWrapperRef.current?.settleConfirmedRun(
            sessionKey,
            acceptedRunId ?? clientTurnId,
            'aborted',
          );
          chatWrapperRef.current?.clearSending(sessionKey, acceptedRunId ?? clientTurnId);
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
    if (
      pendingStartRef.current &&
      (currentSession.id === pendingStartRef.current.temporarySessionId ||
        currentSession.id === pendingStartRef.current.canonicalSessionId)
    ) {
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
      (timing?.state === 'running' ? (timing.rootRunId ?? timing.clientTurnId) : null);
    const pendingSubmission = pendingMessageSubmissionsRef.current.get(currentSession.id);
    if (pendingSubmission?.unknown && pendingSubmission.receiptId) {
      pendingSubmission.cancelled = true;
      // Persist cancellation intent without delaying the actual native abort.
      // A late unknown-admission report is fenced by the Main stop handler too.
      void coworkService
        .markSessionRunUnknown({
          sessionId: currentSession.id,
          id: pendingSubmission.receiptId,
          cancelled: true,
        })
        .then(() => {
          pendingSubmission.unknownMarked = true;
        })
        .catch(() => {
          // Keep the operation unknown and retryable if persistence is unavailable.
        });
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
      setSubtaskSnapshot({ sessionId: currentSessionId, tasks: nextSubtasks });
      setSelectedSubagent(current => {
        if (!current) return null;
        if (current.parentSessionId && current.parentSessionId !== currentSessionId) return current;
        return nextSubtasks.find(subtask => subtask.id === current.id) ?? null;
      });
    },
    [setSelectedSubagent, currentSessionId],
  );

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
    },
    [
      currentSessionId,
      setIsDisplayPanelOpen,
      setIsWorkspaceFilesOpen,
      setPreferredDisplayTabId,
      setSelectedSubagent,
    ],
  );

  useEffect(() => {
    let disposed = false;
    let request = 0;
    const handleOpenSpawnedAgent = (event: Event) => {
      const key = (event as CustomEvent<{ sessionKey?: unknown }>).detail?.sessionKey;
      if (typeof key !== 'string' || !key.trim() || !currentSessionId) return;
      const currentRequest = ++request;
      void loadSpawnedSubtask(window.electron.cowork.getSubTaskStatus, currentSessionId, key)
        .then(subagent => {
          if (disposed || currentRequest !== request) return;
          if (subagent) {
            openSubtask(subagent);
          } else {
            window.dispatchEvent(
              new CustomEvent('app:showToast', { detail: i18nService.t('subtaskLoadFailed') }),
            );
          }
        })
        .catch(() => {
          if (!disposed && currentRequest === request) {
            window.dispatchEvent(
              new CustomEvent('app:showToast', { detail: i18nService.t('subtaskLoadFailed') }),
            );
          }
        });
    };
    window.addEventListener(OPEN_SPAWNED_AGENT_EVENT, handleOpenSpawnedAgent);
    return () => {
      disposed = true;
      window.removeEventListener(OPEN_SPAWNED_AGENT_EVENT, handleOpenSpawnedAgent);
    };
  }, [currentSessionId, openSubtask]);

  const openDisplayPanel = useCallback(() => {
    setIsDisplayPanelOpen(true);
    if (isWorkspaceDetached) window.electron.workspaceWindow?.focus();
  }, [setIsDisplayPanelOpen, isWorkspaceDetached]);

  const closeDisplayPanel = useCallback(() => {
    filePreviewRequestIdRef.current += 1;
    setIsDisplayPanelOpen(false);
    setIsWorkspaceFilesOpen(false);
    requestAnimationFrame(() => displayPanelToggleRef.current?.focus());
  }, [setIsDisplayPanelOpen, setIsWorkspaceFilesOpen]);

  useEffect(() => {
    const handleNewSession = () => onNewChat?.();
    window.addEventListener('cowork:shortcut:new-session', handleNewSession);
    return () => {
      window.removeEventListener('cowork:shortcut:new-session', handleNewSession);
    };
  }, [onNewChat]);

  useSessionFocusRefresh(currentSession?.id, isOpenClawEngine && currentSessionRuntimeRunning);

  useCoworkRuntimePolling({
    currentSessionId,
    currentSessionRuntimeRunningRef,
    backgroundSessionIdsKey,
    backgroundDiscoverySessionIdsKey,
  });

  const requestFilePreviewTransition = useCallback(
    async (options?: FilePreviewNavigationOptions): Promise<boolean> => {
      if (options?.canCommit?.() === false) return false;
      for (const drawer of filePreviewDrawerRefs.current.values()) {
        if (!(await drawer.requestTransition())) return false;
        if (options?.canCommit?.() === false) return false;
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

  const prepareWorkspaceFileMutation = useCallback(
    async (affectedPaths: string[]): Promise<boolean> => {
      if (!affectedPaths.length) return true;
      const sourceSession = currentSessionIdRef.current;
      const isAffected = (filePath: string) =>
        affectedPaths.some(sourcePath => isFilePreviewWithinPath(filePath, sourcePath));
      const affected = filePreviewsRef.current.filter(preview => isAffected(preview.filePath));
      for (const preview of affected) {
        const drawer = filePreviewDrawerRefs.current.get(fileDisplayTabId(preview.filePath));
        if (drawer && !(await drawer.requestTransition())) return false;
        if (currentSessionIdRef.current !== sourceSession) return false;
      }
      // Edit grants and native viewers still point at the old path. Close only the
      // affected previews after their unsaved-change guards have been resolved.
      filePreviewRequestIdRef.current += 1;
      setFilePreviews(current => current.filter(preview => !isAffected(preview.filePath)));
      setUnsupportedFilePreviews(current => current.filter(filePath => !isAffected(filePath)));
      const affectedTabIds = new Set([
        ...affected.map(preview => fileDisplayTabId(preview.filePath)),
        ...unsupportedFilePreviewsRef.current.filter(isAffected).map(fileDisplayTabId),
      ]);
      setPreferredDisplayTabId(current =>
        current && affectedTabIds.has(current) ? null : current,
      );
      return true;
    },
    [setFilePreviews, setUnsupportedFilePreviews, setPreferredDisplayTabId],
  );

  useImperativeHandle(
    ref,
    () => ({
      requestFilePreviewTransition,
      revealSearchMatch: match =>
        setPendingSourceReveal({
          sessionId: match.sessionId,
          entryId: match.messageId,
          nativeSessionKey: match.nativeSessionKey,
          nativeSessionId: match.nativeSessionId,
        }),
    }),
    [requestFilePreviewTransition],
  );

  useEffect(
    () => () => {
      filePreviewRequestIdRef.current += 1;
    },
    [],
  );

  const { openFilePreview } = useFilePreviewEvents({
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
    openAppFile,
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

  const { handleCreateBrowserTab, openLocalHtml } = useCoworkBrowserPanels({
    filePreviewRequestIdRef,
    pendingBrowserTabsRef,
    displaySessionKey,
    currentSessionId,
    browserTabs,
    isDisplayPanelOpen,
    hasDisplayTabs: availableDisplayTabIds.length > 0,
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
  });

  const openMessageFileLink = useMessageFileLinkNavigation({
    workspaceSessionId:
      currentSessionId ?? (workspaceFilesRootPath ? HOME_WORKSPACE_SESSION_ID : undefined),
    projectRoot: workspaceFilesRootPath,
    filePreviewRequestIdRef,
    openFilePreview,
    openLocalHtml,
  });
  const withMessageFileLinks = (content: React.ReactNode) => (
    <MessageFileLinkContext.Provider value={openMessageFileLink}>
      {content}
    </MessageFileLinkContext.Provider>
  );

  const handleOpenSummaryResourceList = (kind: SummaryResourceListKind) => {
    if (!currentSessionId) return;
    summaryVisibility.close();
    setSummaryResourceTabs(current => (current.includes(kind) ? current : [...current, kind]));
    setPreferredDisplayTabId(SUMMARY_RESOURCE_DISPLAY_TAB_IDS[kind]);
    setIsWorkspaceFilesOpen(false);
    openDisplayPanel();
  };

  const handleOpenSummaryResource = (resource: SummaryResource) => {
    if (!currentGatewaySessionKey) return;
    if (resource.target.kind === 'url' && browserTabs.length >= maximumBrowserTabs) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('coworkSummaryBrowserLimit') }),
      );
      return;
    }
    summaryVisibility.close();
    const sessionKey = currentGatewaySessionKey;
    const scope = summaryNavigationScope.current;
    const request = ++summaryResourceRequest.current;
    const isCurrent = () =>
      summaryNavigationScope.current === scope && summaryResourceRequest.current === request;
    const openFile = (filePath: string) => {
      window.dispatchEvent(
        new CustomEvent(
          /\.(?:html?|xhtml)$/iu.test(filePath)
            ? MessageBrowserEvent.OpenLocalHtml
            : 'cowork:preview-file',
          {
            detail: {
              filePath,
              workingDirectory: currentSessionFolderPath,
              displayTarget: BrowserLinkTarget.Embedded,
              currentSessionOnly: true,
              openUnsupportedInSystem: true,
              isCurrent,
            },
          },
        ),
      );
      if (isWorkspaceDetached) window.electron.workspaceWindow?.focus();
    };
    void openSummaryResource(resource, {
      sessionKey,
      isCurrent,
      resolveArtifact: (target, title) =>
        chatWrapperRef.current?.resolveSummaryArtifact(target, title, sessionKey) ?? null,
      readAttachment: target =>
        chatWrapperRef.current?.readSummaryAttachment(target, sessionKey) ?? null,
      openFile,
      openImage: (src, alt) => {
        window.dispatchEvent(new CustomEvent(IMAGE_PREVIEW_EVENT, { detail: { src, alt } }));
        if (isWorkspaceDetached) window.electron.workspaceWindow?.focus();
      },
      openUrl: url => {
        if (browserTabs.length >= maximumBrowserTabs)
          throw new Error(i18nService.t('coworkSummaryBrowserLimit'));
        handleCreateBrowserTab(url);
        if (isWorkspaceDetached) window.electron.workspaceWindow?.focus();
      },
      openMedia: (url, label, kind) => {
        setSummaryMediaPreview({ source: { url, label, kind, sessionKey }, scope });
      },
    })
      .then(opened => {
        if (!opened && isCurrent())
          throw new Error(i18nService.t('coworkSummaryResourceUnavailable'));
      })
      .catch(() => {
        if (isCurrent())
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkSummaryResourceUnavailable'),
            }),
          );
      });
  };

  const handleCreateTerminalTab = useCallback(() => {
    if (isOpenClawEngine && !getEngineReadinessSnapshot().ready) return;
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
        sessionId: currentSession?.id,
        label: i18nService.t('coworkTerminalTitle').replace('{number}', String(number)),
      },
    ]);
    setPreferredDisplayTabId(id);
    setIsWorkspaceFilesOpen(false);
    setIsDisplayPanelOpen(true);
    return id;
  }, [
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setPreferredDisplayTabId,
    setTerminalTabs,
    terminalTabs.length,
    terminalWorkingDirectory,
    currentSession?.id,
    isOpenClawEngine,
  ]);

  const {
    handleCreateSideChat,
    closeSideChat,
    handleSideChatResult,
    handleSideChatStream,
    handleSendSideChat,
  } = useCoworkSideChats({
    currentSessionId,
    isOpenClawEngine,
    sideChatSequenceRef,
    setSideChatTabs,
    setPreferredDisplayTabId,
    setIsDisplayPanelOpen,
    dispatch,
    selectAdjacentDisplayTabAfterClose,
    chatWrapperRef,
  });

  const handleMessageQuote = useCallback<MessageQuoteHandler>(
    (quote, target) => {
      if (
        currentSession?.external?.readOnly ||
        !currentSessionId ||
        quote.sessionKey !== currentGatewaySessionKeyRef.current
      )
        return;
      const draftKey = target === 'side-chat' ? handleCreateSideChat() : currentSessionId;
      if (!draftKey) return;
      dispatch(addDraftMessageQuote({ draftKey, quote }));
      if (target === 'composer') requestAnimationFrame(() => promptInputRef.current?.focus());
    },
    [currentSessionId, currentSession?.external?.readOnly, dispatch, handleCreateSideChat],
  );

  const handleOpenWorkspaceFiles = useCallback(() => {
    if (!workspaceFilesRootPath || currentSessionId?.startsWith('temp-')) return;
    filePreviewRequestIdRef.current += 1;
    setIsWorkspaceFilesTabOpen(true);
    setIsWorkspaceFilesOpen(true);
    setPreferredDisplayTabId(WORKSPACE_FILES_DISPLAY_TAB_ID);
    setIsDisplayPanelOpen(true);
  }, [
    currentSessionId,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setIsWorkspaceFilesTabOpen,
    setPreferredDisplayTabId,
    workspaceFilesRootPath,
  ]);

  const workspaceFilesDisplayTabs: CoworkDisplayTab[] = isWorkspaceFilesTabOpen
    ? [
        {
          id: WORKSPACE_FILES_DISPLAY_TAB_ID,
          label: i18nService.t('coworkWorkspaceFilesOpenTitle'),
          icon: <DocumentPlusIcon className="h-4 w-4" />,
          onSelect: handleOpenWorkspaceFiles,
          onClose: () => {
            filePreviewRequestIdRef.current += 1;
            setIsWorkspaceFilesTabOpen(false);
            setIsWorkspaceFilesOpen(false);
            selectAdjacentDisplayTabAfterClose(WORKSPACE_FILES_DISPLAY_TAB_ID);
          },
        },
      ]
    : [];

  useEffect(() => {
    if (!workspaceFilesRootPath) {
      setIsWorkspaceFilesOpen(false);
      setIsWorkspaceFilesTabOpen(false);
    } else if (activeDisplayTabId === WORKSPACE_FILES_DISPLAY_TAB_ID) {
      setIsWorkspaceFilesOpen(true);
    }
  }, [
    activeDisplayTabId,
    setIsWorkspaceFilesOpen,
    setIsWorkspaceFilesTabOpen,
    workspaceFilesRootPath,
  ]);

  useEffect(() => {
    const handleTerminalShortcut = () => handleCreateTerminalTab();
    const handleBrowserShortcut = () => handleCreateBrowserTab();
    const handleSideChatShortcut = () => handleCreateSideChat();
    const handleFilesShortcut = () => handleOpenWorkspaceFiles();
    const handleReviewShortcut = () => openReview();
    window.addEventListener('cowork:shortcut:terminal', handleTerminalShortcut);
    window.addEventListener('cowork:shortcut:browser', handleBrowserShortcut);
    window.addEventListener('cowork:shortcut:side-chat', handleSideChatShortcut);
    window.addEventListener('cowork:shortcut:files', handleFilesShortcut);
    window.addEventListener('cowork:shortcut:review', handleReviewShortcut);
    return () => {
      window.removeEventListener('cowork:shortcut:terminal', handleTerminalShortcut);
      window.removeEventListener('cowork:shortcut:browser', handleBrowserShortcut);
      window.removeEventListener('cowork:shortcut:side-chat', handleSideChatShortcut);
      window.removeEventListener('cowork:shortcut:files', handleFilesShortcut);
      window.removeEventListener('cowork:shortcut:review', handleReviewShortcut);
    };
  }, [
    handleCreateBrowserTab,
    handleCreateSideChat,
    handleCreateTerminalTab,
    handleOpenWorkspaceFiles,
    openReview,
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

  useCoworkSessionActions({
    setPendingSessionListAction,
    pendingSessionListAction,
    currentSession,
    setPreferredDisplayTabId,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    currentSessionRuntimeRunning,
    sessions,
    sessionTranscriptMutationRef,
    setSessionTranscriptMutation,
    currentSessionIdRef,
    chatWrapperRef,
    currentGatewaySessionKey,
    setSessionExportMessageCount,
    setIsSessionExportOpen,
    sessionTranscriptMutation,
  });

  if (!isInitialized) {
    if (startupError) {
      return (
        <div className="flex h-full flex-1 items-center justify-center bg-background p-6">
          <div className="max-w-md space-y-4 text-center">
            <p className="text-sm text-red-600 dark:text-red-300" role="alert">
              {startupError}
            </p>
            <button
              className="rounded-lg bg-primary px-4 py-2 text-sm text-white"
              type="button"
              onClick={() => window.location.reload()}
            >
              {i18nService.t('startupReload')}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex-1 h-full flex flex-col bg-background">
        <ApplicationLoading activity={startupActivity} />
      </div>
    );
  }

  const homeConversationHeader = (
    <div className="cowork-workspace-header relative flex shrink-0 items-center justify-between border-b border-border px-2">
      <div className="h-7" />
      <div className="non-draggable flex items-center gap-1">
        {(!isDisplayPanelOpen || isWorkspaceDetached) && (
          <NewDisplayTabButton
            buttonRef={displayPanelToggleRef}
            boxedIcon
            detached={isWorkspaceDetached}
            onCreateTab={openDisplayPanel}
          />
        )}
      </div>
    </div>
  );

  const hasRetainedRuntimePanels =
    mcpAppTabs.hasRetainedPanels ||
    mcpAppReferences.hasRetainedPanels ||
    widgetReferences.hasRetainedPanels ||
    webpageReferences.hasRetainedPanels ||
    Object.values(displayStates).some(
      displayState => displayState.hasBrowserPanelOpened || displayState.terminalTabs.length > 0,
    );
  const renderDisplayLauncher = (onNavigateBrowser?: (url: string) => void) => {
    const replaceStartPage = (openContent: () => string | undefined) => () => {
      const startTab = onNavigateBrowser
        ? browserTabs.find(
            tab =>
              browserDisplayTabId(tab.targetId) === activeDisplayTabId && tab.url === 'about:blank',
          )
        : undefined;
      const replacementId = openContent();
      if (startTab && replacementId) {
        replaceTab(browserDisplayTabId(startTab.targetId), replacementId);
        browserPanelRefs.current
          .get(displaySessionKey)
          ?.closeTab(startTab.targetId, { preserveSelection: true });
      }
    };
    return (
      <DisplayPanelLauncher
        appItems={
          currentSessionId
            ? mcpAppMenu?.sessionId === currentSessionId
              ? mcpAppMenu.items
              : []
            : homeApps.menu.items
        }
        appsDisabled={
          !isEngineReady ||
          Boolean(
            currentSession &&
            (isQuestionInputBlocked ||
              !historyReadiness?.ready ||
              historyReadiness.sessionKey !== currentGatewaySessionKey ||
              currentSessionAgent?.enabled === false),
          )
        }
        visible={isWorkspaceVisible}
        showAddressInput={!onNavigateBrowser}
        onNavigateBrowser={onNavigateBrowser}
        browserDisabled={
          Boolean(currentSessionId?.startsWith('temp-')) || browserTabs.length >= maximumBrowserTabs
        }
        filesDisabled={!workspaceFilesRootPath || Boolean(currentSessionId?.startsWith('temp-'))}
        onCreateBrowser={handleCreateBrowserTab}
        onCreateSideChat={currentSession ? replaceStartPage(handleCreateSideChat) : undefined}
        onCreateTerminal={replaceStartPage(handleCreateTerminalTab)}
        onOpenFiles={
          currentSession || workspaceFilesRootPath
            ? replaceStartPage(() => {
                handleOpenWorkspaceFiles();
                return WORKSPACE_FILES_DISPLAY_TAB_ID;
              })
            : undefined
        }
        onOpenReview={
          currentSession
            ? replaceStartPage(() => {
                openReview();
                return REVIEW_TAB_ID;
              })
            : undefined
        }
        sideChatDisabled={
          !isEngineReady || Boolean(currentSessionId?.startsWith('temp-')) || !isOpenClawEngine
        }
        terminalDisabled={
          !isEngineReady || !terminalWorkingDirectory || terminalTabs.length >= MAX_TERMINAL_TABS
        }
      />
    );
  };
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
                onStopTask={
                  sessionKey === HOME_DISPLAY_SESSION_KEY
                    ? undefined
                    : async () => {
                        if (
                          currentSessionIdRef.current !== sessionKey ||
                          currentSession?.external?.readOnly
                        )
                          return false;
                        if (!(await handleStopSession())) return false;
                        return browserTaskStopped(
                          () => pendingMessageSubmissionsRef.current.has(sessionKey),
                          () =>
                            coworkService.getSessionRuntimeStatus(sessionKey, {
                              includeSubagents: true,
                              forceRefresh: true,
                              fullScan: true,
                            }),
                        );
                      }
                }
                onCheckTaskStopped={() =>
                  browserTaskStopped(
                    () => pendingMessageSubmissionsRef.current.has(sessionKey),
                    () =>
                      coworkService.getSessionRuntimeStatus(sessionKey, {
                        includeSubagents: true,
                        forceRefresh: true,
                        fullScan: true,
                      }),
                  )
                }
                onContinueTask={prompt =>
                  continueBrowserTaskRef.current?.(sessionKey, prompt) ?? Promise.resolve('failed')
                }
                isOpen={isWorkspaceVisible && browserVisible && !sessionKey.startsWith('temp-')}
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
                renderStartPage={isActiveSession ? renderDisplayLauncher : undefined}
                embedded
              />,
            ]
          : []),
        ...displayState.terminalTabs.map(tab => (
          <TerminalPanel
            key={`terminal-runtime:${displayState.runtimeId}:${tab.id}`}
            terminalId={tab.id}
            cwd={tab.cwd}
            sessionId={tab.sessionId}
            isObscured={!isActiveSession || runtimeActiveTabId !== tab.id}
          />
        )),
      ];
    },
  );

  // When there's a current session, show the session detail view
  if (currentSession) {
    const handleQueueMessage = async (
      prompt: string,
      attachments?: CoworkAttachmentPayload[],
      gatewayPrompt?: string,
    ) => {
      if (
        goalPresence.sessionId !== currentSession.id ||
        !goalPresence.ready ||
        goalPresence.hasGoal
      )
        return false;
      if (
        currentSession.branchCreationPending ||
        currentSession.external?.readOnly ||
        currentSessionAgent?.enabled === false
      )
        return false;
      if (!ensureOpenClawReadyForSubmit() || pendingStartRef.current?.cancelled) return false;
      const sessionKey = currentGatewaySessionKey;
      const chat = chatWrapperRef.current;
      if (!sessionKey || !chat || pendingMessageSubmissionsRef.current.has(currentSession.id))
        return false;
      const operation = createSessionSubmission();
      operation.sessionKey = sessionKey;
      pendingMessageSubmissionsRef.current.set(currentSession.id, operation);
      return submitCoworkMessage(
        () => chat.queueMessage(prompt, attachments, gatewayPrompt, sessionKey),
        error => {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
        },
      ).finally(() => {
        operation.finish();
        if (
          !operation.stopping &&
          pendingMessageSubmissionsRef.current.get(currentSession.id) === operation
        )
          pendingMessageSubmissionsRef.current.delete(currentSession.id);
      });
    };

    const handleSendMessage = async (
      prompt: string,
      attachments?: CoworkAttachmentPayload[],
      gatewayPrompt?: string,
      submission?: boolean | { clientTurnId: string; assertCurrent?(): void },
      _pluginSubmission?: AppSubmission,
      composerSubmission?: ComposerSubmissionMetadata,
    ) => {
      if (currentSession.branchCreationPending || currentSession.external?.readOnly) return false;
      if (goalPresence.sessionId !== currentSession.id || !goalPresence.ready) return false;
      if (!ensureOpenClawReadyForSubmit() || pendingStartRef.current?.cancelled) return false;
      const outboundPrompt = gatewayPrompt ?? prompt;
      const explicitPlugin = readAppInput(outboundPrompt) !== undefined;
      // The previous run may have finished while a queue acknowledgement was
      // lost. Preserve its idempotency identity even though the composer is idle.
      if (chatWrapperRef.current?.hasUnconfirmedQueuedInput()) {
        // This exact application suffix is only a restriction hint, not launch
        // authority. A queued native execution has no proven intent lineage yet.
        if (explicitPlugin) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('appPluginSubmitUnavailable'),
            }),
          );
          return false;
        }
        return handleQueueMessage(prompt, attachments, gatewayPrompt);
      }
      const goalEdit = isGoalEditCommand(outboundPrompt);
      const targetSessionKey = currentGatewaySessionKey;
      if (!targetSessionKey || pendingMessageSubmissionsRef.current.has(currentSession.id))
        return false;
      const operation = createSessionSubmission();
      operation.sessionKey = targetSessionKey;
      pendingMessageSubmissionsRef.current.set(currentSession.id, operation);
      let requestUnknown = false;
      let nativeSendIssued = false;
      const ensureSubmissionCurrent = () => {
        if (typeof submission === 'object') submission.assertCurrent?.();
        if (operation.cancelled || currentGatewaySessionKeyRef.current !== targetSessionKey) {
          throw new Error('The message submission context changed');
        }
      };
      const startedAt = resolveComposerSubmissionStartedAt(composerSubmission);
      const clientTurnId =
        typeof submission === 'object'
          ? submission.clientTurnId
          : `justdo-${startedAt}-${crypto.randomUUID()}`;
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
            ...(explicitPlugin ? { pluginPrompt: outboundPrompt } : {}),
          });
          runTimingId = timing.id;
          operation.receiptId = timing.id;
          ensureSubmissionCurrent();
          const chatWrapper = chatWrapperRef.current;
          if (!chatWrapper) throw new Error('Chat controller is not ready');
          if (explicitPlugin) {
            const marked = await window.electron.cowork.markPluginSubmissionStarted({
              sessionId: currentSession.id,
              clientTurnId,
            });
            if (!marked.success)
              throw new Error(marked.error || i18nService.t('appPluginSubmitUnavailable'));
            ensureSubmissionCurrent();
          }
          await chatWrapper.sendMessage(prompt, attachments, gatewayPrompt, {
            propagateRequestFailure: true,
            expectedSessionKey: targetSessionKey,
            isCancelled: () => {
              try {
                ensureSubmissionCurrent();
                return false;
              } catch {
                return true;
              }
            },
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
            onRequestIssued: () => {
              nativeSendIssued = true;
            },
            onRunBound: async runId => {
              await bindSessionSubmissionRun(operation, runId, () =>
                coworkService.bindSessionRun(timing.id, runId, currentSession.id),
              );
            },
          });
        },
        async err => {
          const cancelled = operation.cancelled;
          if (explicitPlugin && !nativeSendIssued) {
            // This failed sender cannot resume. Native abandonment still checks
            // exact user-input absence, dispatcher idle and the generation fence.
            operation.cancelled = true;
            await window.electron.cowork
              .abortPluginSubmissionBeforeSend({ sessionId: currentSession.id, clientTurnId })
              .catch(() => undefined);
          }
          if (runTimingId && !requestUnknown)
            void coworkService.failSessionRun(currentSession.id, runTimingId);
          else {
            void coworkService.refreshSessionRuntimeActivity(currentSession.id, {
              includeSubagents: true,
              forceRefresh: true,
              fullScan: true,
            });
          }
          if ((goalEdit && !requestUnknown) || cancelled) return;
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

    continueBrowserTaskRef.current = async (sessionId, prompt) => {
      if (currentSessionIdRef.current !== sessionId || currentSession.id !== sessionId)
        return 'failed';
      const stopped = await browserTaskStopped(
        () => pendingMessageSubmissionsRef.current.has(sessionId),
        () =>
          coworkService.getSessionRuntimeStatus(sessionId, {
            includeSubagents: true,
            forceRefresh: true,
            fullScan: true,
          }),
      );
      if (!stopped || currentSessionIdRef.current !== sessionId) return 'failed';
      const sent = await handleSendMessage(prompt);
      if (pendingMessageSubmissionsRef.current.get(sessionId)?.unknown) return 'unknown';
      return sent ? 'sent' : 'failed';
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
        const actionError = getSessionTranscriptActionError(
          'export',
          currentSession.id,
          currentSessionRuntimeRunningRef.current,
        );
        if (actionError) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', { detail: i18nService.t(actionError) }),
          );
          return false;
        }
        const snapshot = chatWrapperRef.current?.getExportSnapshot();
        if (
          !snapshot ||
          snapshot.isLoading ||
          currentSessionIdRef.current !== currentSession.id ||
          snapshot.sessionKey !== currentGatewaySessionKey ||
          currentGatewaySessionKeyRef.current !== currentGatewaySessionKey
        ) {
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
          title: i18nService.t('sessionExportMain'),
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
      ...(isReviewOpen
        ? [
            {
              id: REVIEW_TAB_ID,
              label: i18nService.t('reviewTitle'),
              icon: <ClipboardDocumentCheckIcon className="h-4 w-4" />,
              onSelect: () => setPreferredDisplayTabId(REVIEW_TAB_ID),
              onClose: () => {
                setIsReviewOpen(false);
                selectAdjacentDisplayTabAfterClose(REVIEW_TAB_ID);
              },
            },
          ]
        : []),
      ...recordingReviewTabs.tabs,
      ...mcpAppTabs.tabs,
      ...mcpAppReferences.tabs,
      ...widgetReferences.tabs,
      ...webpageReferences.tabs,
      ...(isBrowserPanelOpen
        ? browserTabs.map(tab => ({
            id: browserDisplayTabId(tab.targetId),
            label: getBrowserTabDisplayTitle(tab),
            icon: <BrowserTabIcon faviconUrl={tab.faviconUrl} />,
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
      ...workspaceFilesDisplayTabs,
      ...filePreviews.map(preview => ({
        id: fileDisplayTabId(preview.filePath),
        label:
          preview.kind === 'image'
            ? preview.label || i18nService.t('coworkImagePreviewTitle')
            : preview.filePath.split(/[\\/]/).pop() || preview.filePath,
        icon:
          preview.kind === 'image' && /^(?:https?:|image:)/i.test(preview.filePath) ? (
            <PhotoIcon className="h-4 w-4" />
          ) : (
            <WorkspaceFileIcon fileName={getLastPathSegment(preview.filePath)} />
          ),
        onSelect: () => setPreferredDisplayTabId(fileDisplayTabId(preview.filePath)),
        onClose: () => closeFilePreview(preview.filePath),
      })),
      ...unsupportedFilePreviews.map(filePath => ({
        id: fileDisplayTabId(filePath),
        label: filePath.split(/[\\/]/).pop() || filePath,
        icon: <WorkspaceFileIcon fileName={getLastPathSegment(filePath)} />,
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
      ...(isSubagentsTabOpen
        ? [
            {
              id: SUBAGENTS_DISPLAY_TAB_ID,
              label: i18nService.t('coworkSummarySubagents'),
              icon: <QueueListIcon className="h-4 w-4" />,
              onSelect: () => setPreferredDisplayTabId(SUBAGENTS_DISPLAY_TAB_ID),
              onClose: () => {
                setIsSubagentsTabOpen(false);
                selectAdjacentDisplayTabAfterClose(SUBAGENTS_DISPLAY_TAB_ID);
              },
            },
          ]
        : []),
      ...summaryResourceTabs.map(kind => {
        const id = SUMMARY_RESOURCE_DISPLAY_TAB_IDS[kind];
        return {
          id,
          label: i18nService.t(
            kind === 'outputs' ? 'coworkSummaryOutputs' : 'coworkSummarySources',
          ),
          icon:
            kind === 'outputs' ? (
              <DocumentTextIcon className="h-4 w-4" />
            ) : (
              <LinkIcon className="h-4 w-4" />
            ),
          onSelect: () => setPreferredDisplayTabId(id),
          onClose: () => {
            setSummaryResourceTabs(current => current.filter(value => value !== kind));
            selectAdjacentDisplayTabAfterClose(id);
          },
        };
      }),
      ...appWorkspace.views.map(view => ({
        id: view.tabId,
        label: i18nService.t(view.labelKey),
        icon: view.icon ?? <ShareIcon className="h-4 w-4" />,
        onSelect: () => setPreferredDisplayTabId(view.tabId),
        onClose: () => {
          appWorkspace.close(view.tabId);
          selectAdjacentDisplayTabAfterClose(view.tabId);
        },
      })),
      ...sideChatTabs.map(tab => ({
        id: tab.id,
        label: tab.label,
        icon: <ChatBubbleLeftEllipsisIcon className="h-4 w-4" />,
        onSelect: () => setPreferredDisplayTabId(tab.id),
        onClose: () => closeSideChat(tab.id),
      })),
    ];

    return withMessageFileLinks(
      <div className="relative flex-1 flex flex-col h-full">
        <div className="cowork-display-host relative flex min-h-0 flex-1">
          <div ref={bindChatContentWidth} className="relative flex min-w-0 flex-1 flex-col">
            <div className="cowork-workspace-header relative flex shrink-0 items-center justify-between border-b border-border px-2">
              <div className="non-draggable flex h-7 min-w-0 flex-1 items-center overflow-hidden">
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
              <div className="non-draggable relative flex shrink-0 items-center gap-1">
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
                <AppPluginSlot slot="chat.action" context={{ session: currentSession }} />
                <div>
                  <button
                    ref={summaryToggleRef}
                    type="button"
                    onMouseDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      if (!summaryVisibility.visible)
                        chatWrapperRef.current?.refreshSummaryResources();
                      summaryVisibility.toggle();
                    }}
                    className={`relative inline-flex h-7 w-8 items-center justify-center rounded-lg transition-colors ${
                      summaryVisibility.visible
                        ? 'bg-surface-raised text-primary'
                        : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                    }`}
                    title={i18nService.t('coworkSummaryTitle')}
                    aria-label={i18nService.t('coworkSummaryTitle')}
                    aria-expanded={summaryVisibility.visible}
                    aria-controls="cowork-session-summary"
                  >
                    <AdjustmentsHorizontalIcon className="h-[18px] w-[18px]" />
                  </button>
                  <SessionSummaryPanel
                    sessionId={currentSession.id}
                    visible={summaryVisibility.visible}
                    anchorRef={summaryToggleRef}
                    objective={summaryObjective}
                    progress={
                      progressCard
                        ? {
                            card: progressCard,
                            runState: progressCardRunState,
                            onRefresh: () =>
                              chatWrapperRef.current?.refreshProgressCard() ??
                              Promise.resolve(false),
                          }
                        : undefined
                    }
                    tasks={subtasks}
                    resources={currentSummaryResources}
                    pluginEntries={
                      <AppPluginSlot
                        slot="session.summary"
                        context={{ session: currentSession, onClose: summaryVisibility.close }}
                      />
                    }
                    onClose={summaryVisibility.close}
                    onOpenSubagents={() => {
                      summaryVisibility.close();
                      setIsSubagentsTabOpen(true);
                      setPreferredDisplayTabId(SUBAGENTS_DISPLAY_TAB_ID);
                      setIsWorkspaceFilesOpen(false);
                      openDisplayPanel();
                    }}
                    onOpenResource={handleOpenSummaryResource}
                    onOpenResourceList={handleOpenSummaryResourceList}
                  />
                  <OwnerDocumentContext.Provider
                    value={subagentsPortalTarget?.ownerDocument ?? document}
                  >
                    <SubtaskListPanel
                      sessionId={currentSession.id}
                      embedded
                      portalTarget={subagentsPortalTarget}
                      isOpen={
                        isSubagentsTabOpen &&
                        activeDisplayTabId === SUBAGENTS_DISPLAY_TAB_ID &&
                        isWorkspaceVisible
                      }
                      parentRunning={currentSessionRuntimeRunning}
                      onClose={() => {
                        setIsSubagentsTabOpen(false);
                        selectAdjacentDisplayTabAfterClose(SUBAGENTS_DISPLAY_TAB_ID);
                      }}
                      onOpenSubtask={openSubtask}
                      onSubtasksChange={handleSubtasksChange}
                    />
                  </OwnerDocumentContext.Provider>
                </div>
                {(!isDisplayPanelOpen || isWorkspaceDetached) && (
                  <NewDisplayTabButton
                    buttonRef={displayPanelToggleRef}
                    boxedIcon
                    detached={isWorkspaceDetached}
                    onCreateTab={openDisplayPanel}
                  />
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
            <RestoredHistoryNotice
              key={currentSession.id}
              sessionId={currentSession.id}
              binding={currentSession.historyBinding}
              onWorkspaceChanged={() =>
                coworkService.loadSession(currentSession.id, {
                  canSelect: () => currentSessionIdRef.current === currentSession.id,
                })
              }
            />
            <JustDoChatWrapper
              key="chat-controller"
              onMcpAppMenuChange={setMcpAppMenu}
              onSummaryResourcesChange={setSummaryResources}
              ref={chatWrapperRef}
              mcpAppFilePath={activeFilePreview?.filePath}
              onNewMcpAppDraft={async (text, content) => {
                const sessionId = currentSessionIdRef.current;
                const isCurrent = () =>
                  currentSessionIdRef.current === sessionId &&
                  !store.getState().cowork.currentSession?.external?.readOnly;
                if (!onNewChat || !sessionId || !isCurrent() || !text.trim() || text.length > 4000)
                  return false;
                const attachments = await saveAppMessageAttachments(
                  content,
                  currentSessionFolderPath,
                  isCurrent,
                );
                if (!isCurrent()) return false;
                const previous = store.getState().cowork.draftPrompts.__home__ ?? '';
                dispatch(
                  setDraftPrompt({
                    sessionId: '__home__',
                    draft: previous ? `${previous}\n\n${text}` : text,
                  }),
                );
                const existing = store.getState().cowork.draftAttachments.__home__ ?? [];
                dispatch(
                  setDraftAttachments({
                    draftKey: '__home__',
                    attachments: [...existing, ...attachments],
                  }),
                );
                onNewChat();
                return true;
              }}
              onOpenMcpAppFile={async file => {
                const sessionId = currentSessionIdRef.current;
                if (!sessionId || sessionId !== currentSession.id) return false;
                window.dispatchEvent(
                  new CustomEvent('cowork:preview-file', {
                    detail: {
                      filePath: file.path,
                      workingDirectory: currentSessionFolderPath,
                      currentSessionOnly: true,
                      openUnsupportedInSystem: false,
                      isCurrent: () => currentSessionIdRef.current === sessionId,
                    },
                  }),
                );
                return true;
              }}
              onWidgetLink={(sessionKey, url) => {
                if (
                  currentSessionIdRef.current !== currentSession.id ||
                  currentGatewaySessionKeyRef.current !== sessionKey ||
                  !isWebBrowserLink(url)
                )
                  return;
                handleCreateBrowserTab(url);
                if (isWorkspaceDetached) window.electron.workspaceWindow?.focus();
              }}
              onWidgetDraft={
                sessionTranscriptMutation === null && !currentSession.external?.readOnly
                  ? (sessionKey, text) => {
                      const active = store.getState().cowork.currentSession;
                      if (
                        !active ||
                        active.id !== currentSessionIdRef.current ||
                        sessionKey !== currentGatewaySessionKeyRef.current ||
                        !text.trim() ||
                        text.length > 4000 ||
                        /^\s*[!/]/.test(text)
                      )
                        return false;
                      const composer = promptInputRef.current;
                      if (composer) {
                        composer.appendValue(text);
                      } else {
                        const previous = store.getState().cowork.draftPrompts[active.id] ?? '';
                        const draft = previous ? `${previous}\n\n${text}` : text;
                        dispatch(setDraftPrompt({ sessionId: active.id, draft }));
                      }
                      return true;
                    }
                  : undefined
              }
              onMessageQuote={
                sessionTranscriptMutation === null && !currentSession.external?.readOnly
                  ? handleMessageQuote
                  : undefined
              }
              onHistoryReadyChange={handleHistoryReadyChange}
              className="flex-1 min-h-0"
              assistantName={assistantName}
              workingDirectory={currentSessionFolderPath}
              searchQuery={isSessionSearchOpen ? sessionSearchQuery : ''}
              searchCaseSensitive={!sessionSearchIgnoreCase}
              searchNavigationToken={sessionSearchNavigation.token}
              searchNavigationDirection={sessionSearchNavigation.direction}
              processSummariesExpanded={areProcessSummariesExpanded}
              onSearchMatchCountChange={handleSessionSearchMatchCountChange}
              onActivityChange={onActivityChange}
              onQueuedInputsChange={setQueuedInputs}
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
                (!currentSession.nativeSessionKey || !!currentSession.historyBinding) &&
                !currentSessionRuntimeRunning &&
                !currentSession.id.startsWith('temp-')
                  ? handleAssistantMessageFork
                  : undefined
              }
              runTimings={sessionRunTimings[currentSession.id] ?? []}
            />
            {/* Input */}
            <div className="cowork-composer-viewport shrink-0 pb-4 pt-2">
              <div className="cowork-content-width mx-auto min-w-0 space-y-1.5">
                {!currentSession.external?.readOnly && (
                  <CoworkPet
                    key={currentSession.id}
                    running={isCoworkRunActive(currentSessionRuntimeRunning, goalRunProgress)}
                    waiting={
                      isQuestionInputBlocked ||
                      Boolean(visiblePlanInteraction && !planPreviewReadOnly)
                    }
                    latestRun={currentSessionRunTimings[currentSessionRunTimings.length - 1]}
                  />
                )}
                {currentSession.branchCreationPending || currentSession.external?.readOnly ? (
                  <div className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-center text-xs leading-5 text-secondary">
                    {i18nService.t(
                      currentSession.branchCreationPending
                        ? 'coworkBranchCreationPending'
                        : currentSession.external?.origin === ExternalSessionSource.Cli
                          ? 'agentCliSessionReadOnly'
                          : 'externalClientSessionReadOnly',
                    )}
                  </div>
                ) : (
                  <div className="relative isolate rounded-2xl">
                    {queuedInputs?.sessionKey === currentGatewaySessionKey && (
                      <QueuedInputCards
                        key={currentSession.id}
                        items={queuedInputs.items}
                        workingDirectory={currentSessionFolderPath}
                        getDetail={inputId =>
                          chatWrapperRef.current?.getQueuedInputDetail(
                            inputId,
                            queuedInputs.sessionKey,
                          ) ?? null
                        }
                        onWithdraw={async inputId => {
                          const chat = chatWrapperRef.current;
                          if (!chat) throw new Error(i18nService.t('coworkQueueUnavailable'));
                          await chat.withdrawQueuedInput(inputId, queuedInputs.sessionKey);
                        }}
                      />
                    )}
                    <div className={`${COMPOSER_FRAME_CLASS} relative z-10`}>
                      <CoworkPromptInput
                        ref={promptInputRef}
                        onSubmit={handleSendMessage}
                        onQueue={handleQueueMessage}
                        onStop={handleStopSession}
                        stopOperationKey={getSessionStopOperationKey(
                          currentSession.id,
                          pendingStartRef.current,
                        )}
                        isStreaming={currentSessionMainRunning}
                        allowDraftWhileDisabled={!isEngineReady}
                        disabledMessage={engineUnavailableMessage}
                        disabled={
                          !isEngineReady ||
                          isQuestionInputBlocked ||
                          !historyReadiness?.ready ||
                          historyReadiness.sessionKey !== currentGatewaySessionKey ||
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
              <div className="cowork-composer-scrollbar-gutter" aria-hidden="true" />
            </div>
          </div>
          {(isDisplayPanelOpen ||
            isWorkspaceDetached ||
            hasBrowserPanelOpened ||
            displayTabs.length > 0 ||
            hasRetainedRuntimePanels) && (
            <CoworkDisplayPanel
              key="cowork-display-panel"
              activeTabId={activeDisplayTabId ?? ''}
              referenceContent={
                mcpAppReferences.panel(activeDisplayTabId) ??
                widgetReferences.panel(activeDisplayTabId) ??
                webpageReferences.panel(activeDisplayTabId)
              }
              isOpen={isDisplayPanelOpen}
              onClose={closeDisplayPanel}
              width={browserPanelWidth}
              onWidthChange={width =>
                setSessionField(displaySessionKey, 'browserPanelWidth', width)
              }
              showEmptyState={
                displayTabs.length === 0 || activeDisplayTabId === WORKSPACE_FILES_DISPLAY_TAB_ID
              }
              tabs={sortDisplayTabs(displayTabs)}
              fileAppCatalog={
                mcpAppMenu?.sessionId === currentSession.id ? mcpAppMenu.fileCatalog : undefined
              }
              workspacePath={currentSessionFolderPath ?? undefined}
              fileContextPath={activeFilePreview?.filePath ?? activeUnsupportedFilePath}
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
                  renderDisplayLauncher()
                )
              }
              sidePanel={
                currentSessionFolderPath && !currentSession.id.startsWith('temp-') ? (
                  <WorkspaceFilesPanel
                    key={`${currentSession.id}:${currentSessionFolderPath}`}
                    onBeforeMutation={prepareWorkspaceFileMutation}
                    isVisible={isWorkspaceVisible && isWorkspaceFilesOpen}
                    revealPath={filesRevealPath}
                    revealVersion={filesRevealVersion}
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
              sidePanelVisible={isWorkspaceFilesOpen}
              onSidePanelToggle={() => setIsWorkspaceFilesOpen(open => !open)}
              onSidePanelClose={() => setIsWorkspaceFilesOpen(false)}
              actions={
                <NewDisplayTabButton
                  disabled={
                    currentSession.id.startsWith('temp-') ||
                    browserTabs.length >= maximumBrowserTabs
                  }
                  onCreateTab={() => handleCreateBrowserTab()}
                />
              }
            >
              {/* Keep this first in both layouts: moving an iframe ancestor resets its document. */}
              <div key="mcp-app-panels" className="contents">
                {mcpAppTabs.panels(activeDisplayTabId)}
              </div>
              {isReviewOpen && (
                <SessionReviewPanel
                  key={currentSession.id}
                  sessionId={currentSession.id}
                  visible={isWorkspaceVisible && activeDisplayTabId === REVIEW_TAB_ID}
                  running={currentSessionRuntimeRunning}
                  focusPath={reviewFocusPath}
                  focusVersion={reviewFocusVersion}
                  onOpenFile={(filePath, relative, reveal) => {
                    if (reveal) {
                      setFilesRevealPath(relative);
                      setFilesRevealVersion(value => value + 1);
                      setIsWorkspaceFilesOpen(true);
                    } else
                      window.dispatchEvent(
                        new CustomEvent('cowork:preview-file', {
                          detail: { filePath, workingDirectory: currentSessionFolderPath },
                        }),
                      );
                  }}
                />
              )}
              {retainedRuntimePanels}
              {isSubagentsTabOpen && (
                <div
                  key={`subagents:${currentSession.id}`}
                  ref={setSubagentsPortalTarget}
                  className="absolute inset-0"
                  hidden={activeDisplayTabId !== SUBAGENTS_DISPLAY_TAB_ID}
                />
              )}
              {summaryResourceTabs.map(kind => (
                <div
                  key={`${currentSession.id}:${kind}`}
                  className="absolute inset-0"
                  hidden={activeDisplayTabId !== SUMMARY_RESOURCE_DISPLAY_TAB_IDS[kind]}
                >
                  <SessionSummaryResourceList
                    kind={kind}
                    resources={currentSummaryResources}
                    onOpenResource={handleOpenSummaryResource}
                  />
                </div>
              ))}
              {recordingReviewTabs.panels(activeDisplayTabId)}
              {appWorkspace.views.map(view => (
                <div
                  key={`${view.pluginId}:${view.epoch}:${view.id}`}
                  className="absolute inset-0"
                  hidden={activeDisplayTabId !== view.tabId}
                >
                  <AppPluginSlot
                    slot="workspace.tab"
                    pluginId={view.pluginId}
                    contributionId={view.id}
                    context={{
                      session: currentSession,
                      selection: view.selection,
                      selectionRevision: view.selectionRevision,
                      active: activeDisplayTabId === view.tabId && isWorkspaceVisible,
                      draft: {
                        focus: () => requestAnimationFrame(() => promptInputRef.current?.focus()),
                        append: text =>
                          window.dispatchEvent(
                            new CustomEvent('cowork:append-draft', {
                              detail: { sessionId: currentSession.id, text },
                            }),
                          ),
                      },
                      onOpenSubtask: openSubtask,
                      submitUserTurn: {
                        assertReady: () => {
                          if (
                            currentSessionIdRef.current !== currentSession.id ||
                            currentGatewaySessionKeyRef.current !== currentGatewaySessionKey ||
                            currentSession.external ||
                            currentSessionRuntimeRunningRef.current ||
                            goalPresence.sessionId !== currentSession.id ||
                            !goalPresence.ready ||
                            goalPresence.hasGoal ||
                            pendingMessageSubmissionsRef.current.has(currentSession.id) ||
                            chatWrapperRef.current?.hasUnconfirmedQueuedInput()
                          )
                            throw new Error('appPluginSubmitUnavailable');
                        },
                        supportsImages: () => promptInputRef.current?.supportsImages() === true,
                        send: input =>
                          handleSendMessage(input.display, input.attachments, input.gateway, {
                            clientTurnId: input.clientTurnId,
                            assertCurrent: input.assertCurrent,
                          }),
                        outcomeUnknown: () =>
                          pendingMessageSubmissionsRef.current.get(currentSession.id)?.unknown ===
                          true,
                      },
                    }}
                  />
                </div>
              ))}
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
                  isObscured={
                    !isWorkspaceVisible || activeFilePreview?.filePath !== preview.filePath
                  }
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
          {summaryMediaPreview?.scope === summaryNavigationScope.current && (
            <SummaryMediaPreview
              source={summaryMediaPreview.source}
              onClose={() => setSummaryMediaPreview(null)}
            />
          )}
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
      </div>,
    );
  }

  const homeDisplayTabs: CoworkDisplayTab[] = [
    ...recordingReviewTabs.tabs,
    ...mcpAppTabs.tabs,
    ...mcpAppReferences.tabs,
    ...widgetReferences.tabs,
    ...webpageReferences.tabs,
    ...(isBrowserPanelOpen
      ? browserTabs.map(tab => ({
          id: browserDisplayTabId(tab.targetId),
          label: getBrowserTabDisplayTitle(tab),
          icon: <BrowserTabIcon faviconUrl={tab.faviconUrl} />,
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
    ...workspaceFilesDisplayTabs,
    ...filePreviews.map(preview => ({
      id: fileDisplayTabId(preview.filePath),
      label:
        preview.kind === 'image'
          ? preview.label || i18nService.t('coworkImagePreviewTitle')
          : preview.filePath.split(/[\\/]/).pop() || preview.filePath,
      icon:
        preview.kind === 'image' && /^(?:https?:|image:)/i.test(preview.filePath) ? (
          <PhotoIcon className="h-4 w-4" />
        ) : (
          <WorkspaceFileIcon fileName={getLastPathSegment(preview.filePath)} />
        ),
      onSelect: () => setPreferredDisplayTabId(fileDisplayTabId(preview.filePath)),
      onClose: () => closeFilePreview(preview.filePath),
    })),
    ...unsupportedFilePreviews.map(filePath => ({
      id: fileDisplayTabId(filePath),
      label: filePath.split(/[\\/]/).pop() || filePath,
      icon: <WorkspaceFileIcon fileName={getLastPathSegment(filePath)} />,
      onSelect: () => setPreferredDisplayTabId(fileDisplayTabId(filePath)),
      onClose: () => closeUnsupportedFilePreview(filePath),
    })),
  ];

  // Home view - no current session
  return withMessageFileLinks(
    renderCoworkHomeWorkspace({
      chatController:
        chatWrapperRef.current &&
        (mcpAppTabs.hasRetainedPanels ||
          mcpAppReferences.hasRetainedPanels ||
          widgetReferences.hasRetainedPanels ||
          webpageReferences.hasRetainedPanels) ? (
          <JustDoChatWrapper key="chat-controller" ref={chatWrapperRef} className="hidden" />
        ) : undefined,
      mcpAppMenu: homeApps.menu,
      maximumBrowserTabs,
      homeConversationHeader,
      greetingKey,
      promptInputRef,
      handleStartSession,
      handleStopSession,
      isStreaming,
      isEngineReady,
      engineUnavailableMessage,
      config,
      isDisplayPanelOpen,
      isWorkspaceDetached,
      hasBrowserPanelOpened,
      terminalTabs,
      filePreviews,
      unsupportedFilePreviews,
      recordingReviewTabs,
      mcpAppTabs,
      hasRetainedRuntimePanels,
      activeDisplayTabId,
      closeDisplayPanel,
      browserPanelWidth,
      setSessionField,
      displaySessionKey,
      homeDisplayTabs: sortDisplayTabs(homeDisplayTabs),
      isWorkspaceFilesOpen,
      browserTabs,
      handleCreateBrowserTab,
      handleCreateTerminalTab,
      homeWorkspaceFolderPath,
      handleOpenWorkspaceFiles,
      terminalWorkingDirectory,
      activeFilePreview,
      activeUnsupportedFilePath,
      retainedRuntimePanels,
      filePreviewDrawerRefs,
      closeFilePreview,
      closeUnsupportedFilePreview,
      prepareWorkspaceFileMutation,
    }),
  );
});

CoworkView.displayName = 'CoworkView';

export default CoworkView;
