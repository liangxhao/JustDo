import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { SaveTextFileErrorCode } from '@shared/dialogIpc';
import { isGoalEditCommand } from '@shared/slashCommands';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import WindowTitleBar from '@/app/shell/window/WindowTitleBar';
import { resolveAgentModelSelection } from '@/features/cowork/components/agentModelSelection';
import { submitCoworkMessage } from '@/features/cowork/components/coworkMessageSubmit';
import CoworkPromptInput, {
  type CoworkPromptInputRef,
} from '@/features/cowork/components/CoworkPromptInput';
import ExportSessionModal from '@/features/cowork/components/ExportSessionModal';
import FilePreviewDrawer, {
  type FilePreview,
  type FilePreviewDrawerHandle,
} from '@/features/cowork/components/FilePreviewDrawer';
import { isCurrentFilePreviewRequest } from '@/features/cowork/components/filePreviewNavigation';
import { inferInitialGoalObjective } from '@/features/cowork/components/goalPendingObjective';
import type { GoalRunProgress } from '@/features/cowork/components/goalRunProgress';
import JustDoChatWrapper, {
  type JustDoChatWrapperRef,
} from '@/features/cowork/components/JustDoChatWrapper';
import {
  resolveBackgroundRuntimeDiscoverySessionIds,
  resolveBackgroundRuntimeSessionIds,
  shouldContinueFullRuntimeScan,
} from '@/features/cowork/components/runtimePolling';
import SubagentMenu, { type Subagent } from '@/features/cowork/components/SubagentMenu';
import SubagentMessageDrawer from '@/features/cowork/components/SubagentMessageDrawer';
import {
  selectCoworkConfig,
  selectCoworkSessions,
  selectCurrentSession,
  selectIsOpenClawEngine,
  selectIsStreaming,
  selectSessionRuntimeActivity,
  selectSessionRunTimings,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import { setCurrentSession, setStreaming, updateSessionStatus } from '@/features/cowork/coworkSlice';
import type {
  CoworkAttachmentPayload,
  CoworkSession,
  OpenClawEngineStatus,
} from '@/features/cowork/coworkTypes';
import {
  buildSessionExportFileName,
  createSessionExportDocument,
} from '@/features/cowork/sessionExport';
import { clearActiveSkills } from '@/features/plugins/slices/skillSlice';
import type { SettingsOpenOptions } from '@/features/settings/Settings';
import type { ChatContextUsageSnapshot } from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';
import BrainIcon from '@/shared/components/icons/BrainIcon';
import ComposeIcon from '@/shared/components/icons/ComposeIcon';
import FolderIcon from '@/shared/components/icons/FolderIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import SidebarToggleIcon from '@/shared/components/icons/SidebarToggleIcon';
import { RootState } from '@/store';
import { getCompactFolderName } from '@/utils/path';

import logoUrl from '../../../../../resources/logo.png';

const DEBUG_COWORK_VIEW =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_COWORK_VIEW === 'true';

const CURRENT_SESSION_RUNNING_POLL_MS = 3_000;
const CURRENT_SESSION_IDLE_POLL_MS = 10_000;
const BACKGROUND_SESSION_POLL_MS = 30_000;
const BACKGROUND_DISCOVERY_POLL_MS = 60_000;
const HIDDEN_DISCOVERY_POLL_MS = 120_000;
const HIDDEN_WINDOW_POLL_MS = 60_000;

function debugLog(...args: unknown[]): void {
  if (DEBUG_COWORK_VIEW) {
    console.debug(...args);
  }
}

export interface CoworkViewProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  isQuestionInputBlocked?: boolean;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
}

export interface CoworkViewHandle {
  requestFilePreviewTransition: () => Promise<boolean>;
}

const CoworkView = forwardRef<CoworkViewHandle, CoworkViewProps>((props, ref) => {
  const {
    onRequestAppSettings,
    isQuestionInputBlocked = false,
    isSidebarCollapsed,
    onToggleSidebar,
    onNewChat,
  } = props;
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const [isInitialized, setIsInitialized] = useState(false);
  const openClawStatusRef = useRef<OpenClawEngineStatus | null>(null);
  const [selectedSubagent, setSelectedSubagent] = useState<Subagent | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [goalRunProgress, setGoalRunProgress] = useState<GoalRunProgress | null>(null);
  const [contextUsage, setContextUsage] = useState<ChatContextUsageSnapshot | null>(null);
  const [isSessionSearchOpen, setIsSessionSearchOpen] = useState(false);
  const [areProcessSummariesExpanded, setAreProcessSummariesExpanded] = useState(false);
  const [isSessionExportOpen, setIsSessionExportOpen] = useState(false);
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
  const filePreviewDrawerRef = useRef<FilePreviewDrawerHandle>(null);
  const filePreviewRequestIdRef = useRef(0);
  // Track if we're starting a session to prevent duplicate submissions
  const isStartingRef = useRef(false);
  // Track pending start request so stop can cancel delayed startup.
  const pendingStartRef = useRef<{
    requestId: number;
    cancelled: boolean;
    cancellationAction: 'stop' | 'delete' | null;
  } | null>(null);
  const startRequestIdRef = useRef(0);
  // Ref for CoworkPromptInput
  const promptInputRef = useRef<CoworkPromptInputRef>(null);
  const sessionPromptInputRegionRef = useRef<HTMLDivElement>(null);
  // Ref for JustDoChatWrapper (to call sendMessage)
  const chatWrapperRef = useRef<JustDoChatWrapperRef>(null);
  // Buffer for pending user message when JustDoChatWrapper isn't mounted yet
  const pendingPromptRef = useRef<string | null>(null);
  const pendingAttachmentsRef = useRef<CoworkAttachmentPayload[]>([]);
  const pendingInitialGoalRef = useRef<{ sessionId: string; objective: string } | null>(null);

  const currentSession = useSelector(selectCurrentSession);
  const currentSessionId = currentSession?.id ?? null;
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const isStreaming = useSelector(selectIsStreaming);
  const sessions = useSelector(selectCoworkSessions);
  const sessionRuntimeActivity = useSelector(selectSessionRuntimeActivity);
  const sessionRunTimings = useSelector(selectSessionRunTimings);
  const config = useSelector(selectCoworkConfig);
  const isOpenClawEngine = useSelector(selectIsOpenClawEngine);
  const agentState = useSelector((state: RootState) => state.agent);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const currentSessionRuntimeRunning = currentSession
    ? currentSession.id.startsWith('temp-')
      ? currentSession.status === 'running'
      : sessionRuntimeActivity[currentSession.id] === true
    : isStreaming;
  const currentSessionRuntimeRunningRef = useRef(currentSessionRuntimeRunning);
  currentSessionRuntimeRunningRef.current = currentSessionRuntimeRunning;
  useEffect(() => {
    const inputRegion = sessionPromptInputRegionRef.current;
    if (!inputRegion) return;

    if (isQuestionInputBlocked) {
      inputRegion.setAttribute('inert', '');
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && inputRegion.contains(activeElement)) {
        activeElement.blur();
      }
    } else {
      inputRegion.removeAttribute('inert');
    }

    return () => inputRegion.removeAttribute('inert');
  }, [isQuestionInputBlocked]);
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
    agentModel: currentSession?.modelRef || currentSessionAgent?.model || '',
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
  ): Promise<boolean | void> => {
    if (!ensureOpenClawReadyForSubmit()) return false;
    // Prevent duplicate submissions
    if (isStartingRef.current) return;
    isStartingRef.current = true;
    const requestId = ++startRequestIdRef.current;
    pendingStartRef.current = { requestId, cancelled: false, cancellationAction: null };
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
          return;
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }

      // Create a temporary session with user message to show immediately
      const tempSessionId = `temp-${Date.now()}`;
      const fallbackTitle = prompt.split('\n')[0].slice(0, 50) || i18nService.t('coworkNewSession');
      const now = Date.now();
      const clientTurnId = `justdo-${now}-${crypto.randomUUID()}`;

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
      dispatch(setCurrentSession(tempSession));
      dispatch(setStreaming(true));

      // Buffer the pending user message until the temporary session render has
      // switched the ChatController. Applying it synchronously here can still
      // target the previously selected, running session.
      pendingPromptRef.current = prompt;
      pendingAttachmentsRef.current = attachments ?? [];
      debugLog('[CoworkView] handleStartSession:', {
        prompt: prompt.slice(0, 60),
        wrapperRefExists: !!chatWrapperRef.current,
        tempSessionId: tempSessionId,
      });

      // Clear active skills after starting so they don't persist to the next session.
      dispatch(clearActiveSkills());

      // Start the actual session immediately with fallback title
      const { session: startedSession, error: startError } = await coworkService.startSession(
        {
          prompt,
          title: fallbackTitle,
          cwd: config.workingDirectory || undefined,
          activeSkillIds: sessionSkillIds,
          agentId: currentAgentId,
          attachments,
          clientTurnId,
          startedAt: now,
        },
        {
          beforeSessionSelected: session => {
            const sourceAgentId = currentAgentId?.trim() || 'main';
            const targetAgentId = session.agentId?.trim() || sourceAgentId;
            chatWrapperRef.current?.registerSessionPromotion(
              `agent:${sourceAgentId}:justdo:${tempSessionId}`,
              `agent:${targetAgentId}:justdo:${session.id}`,
            );
          },
        },
      );

      if (!startedSession && startError) {
        dispatch(updateSessionStatus({ sessionId: tempSessionId, status: 'error' }));
        chatWrapperRef.current?.clearSending();
        return;
      }

      // Generate title in the background and update when ready
      if (startedSession) {
        coworkService
          .generateSessionTitle(prompt, startedSession.id)
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
        await coworkService.stopSession(startedSession.id);
        if (getPendingCancellationAction() === 'delete') {
          await coworkService.deleteSession(startedSession.id);
        }
      }
    } finally {
      if (pendingStartRef.current?.requestId === requestId) {
        pendingStartRef.current = null;
      }
      isStartingRef.current = false;
    }
  };

  const handleStopSession = async () => {
    if (!currentSession) return false;
    if (currentSession.id.startsWith('temp-') && pendingStartRef.current) {
      pendingStartRef.current.cancelled = true;
      pendingStartRef.current.cancellationAction = 'stop';
    }
    const stopped = await coworkService.stopSession(currentSession.id);
    if (stopped) chatWrapperRef.current?.clearSending();
    return stopped;
  };

  const handleSubagentsChange = useCallback((subagents: Subagent[]) => {
    setSelectedSubagent(current => {
      if (!current) return null;
      return subagents.find(subagent => subagent.id === current.id) ?? current;
    });
  }, []);

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
    setSelectedSubagent(null);
    setGoalRunProgress(null);
    setFilePreview(null);
  }, [currentSession?.id]);

  const requestFilePreviewTransition = useCallback(async (): Promise<boolean> => {
    const canClose = (await filePreviewDrawerRef.current?.requestTransition()) ?? true;
    if (canClose) {
      filePreviewRequestIdRef.current += 1;
      setFilePreview(null);
    }
    return canClose;
  }, []);

  useImperativeHandle(ref, () => ({ requestFilePreviewTransition }), [
    requestFilePreviewTransition,
  ]);

  useEffect(
    () => () => {
      filePreviewRequestIdRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    const handlePreviewFile = async (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string; workingDirectory?: string }>)
        .detail;
      if (!detail?.filePath) return;
      const sourceSessionId = currentSessionIdRef.current;
      const activeRequestId = ++filePreviewRequestIdRef.current;
      const canReplace = (await filePreviewDrawerRef.current?.requestTransition()) ?? true;
      if (!canReplace) return;
      if (
        !isCurrentFilePreviewRequest(
          activeRequestId,
          filePreviewRequestIdRef.current,
          sourceSessionId,
          currentSessionIdRef.current,
        )
      ) {
        return;
      }
      setFilePreview(null);
      let result: Awaited<ReturnType<typeof window.electron.shell.readPreviewFile>>;
      try {
        result = await window.electron.shell.readPreviewFile(
          detail.filePath,
          detail.workingDirectory,
        );
      } catch {
        if (
          isCurrentFilePreviewRequest(
            activeRequestId,
            filePreviewRequestIdRef.current,
            sourceSessionId,
            currentSessionIdRef.current,
          )
        ) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkFilePreviewFailed'),
            }),
          );
        }
        return;
      }
      if (
        !isCurrentFilePreviewRequest(
          activeRequestId,
          filePreviewRequestIdRef.current,
          sourceSessionId,
          currentSessionIdRef.current,
        )
      ) {
        if (result.success) {
          void window.electron.shell
            .revokePreviewFileEdit(result.editToken)
            .catch((): undefined => undefined);
        }
        return;
      }
      if (result.success) {
        setSelectedSubagent(null);
        setFilePreview({
          content: result.content,
          editToken: result.editToken,
          filePath: result.filePath,
          version: result.version,
        });
        return;
      }
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: result.notFound
            ? i18nService.t('coworkAttachmentNotFound').replace('{filepath}', detail.filePath)
            : result.tooLarge
              ? i18nService.t('coworkFilePreviewTooLarge')
              : result.error || i18nService.t('coworkFilePreviewFailed'),
        }),
      );
    };
    window.addEventListener('cowork:preview-file', handlePreviewFile);
    return () => window.removeEventListener('cowork:preview-file', handlePreviewFile);
  }, []);

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
    if (!pendingPromptRef.current || !chatWrapperRef.current) return;
    debugLog(
      '[CoworkView] useEffect applying pendingPrompt:',
      pendingPromptRef.current.slice(0, 60),
    );
    chatWrapperRef.current.setPendingUserMessage(
      pendingPromptRef.current,
      pendingAttachmentsRef.current,
    );
    pendingPromptRef.current = null;
    pendingAttachmentsRef.current = [];
  });

  if (!isInitialized) {
    return (
      <div className="flex-1 h-full flex flex-col bg-background">
        <div className="draggable flex h-12 items-center justify-end px-4 border-b border-border shrink-0">
          <WindowTitleBar inline />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-secondary">{i18nService.t('loading')}</div>
        </div>
      </div>
    );
  }

  // Gateway lifecycle changes intentionally stay out of React state so a restart
  // cannot force the chat transcript and prompt tree to re-render.
  const isEngineReady = true;

  const homeHeader = (
    <div className="draggable flex h-12 items-center justify-between px-4 border-b border-border shrink-0">
      <div className="non-draggable h-8 flex items-center">
        {isSidebarCollapsed && (
          <div className={`flex items-center gap-1 mr-2 ${isMac ? 'pl-[68px]' : ''}`}>
            <button
              type="button"
              onClick={onToggleSidebar}
              className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
            </button>
            <button
              type="button"
              onClick={onNewChat}
              className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              <ComposeIcon className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <div className="non-draggable flex items-center">
        <WindowTitleBar inline />
      </div>
    </div>
  );

  // When there's a current session, show the session detail view
  if (currentSession) {
    const handleSendMessage = async (
      prompt: string,
      attachments?: CoworkAttachmentPayload[],
      gatewayPrompt?: string,
    ) => {
      if (!ensureOpenClawReadyForSubmit()) return false;
      const goalEdit = isGoalEditCommand(gatewayPrompt ?? prompt);
      const startedAt = Date.now();
      const clientTurnId = `justdo-${startedAt}-${crypto.randomUUID()}`;
      let runTimingId: string | null = null;
      return submitCoworkMessage(
        async () => {
          const timing = await coworkService.beginSessionRun({
            sessionId: currentSession.id,
            clientTurnId,
            startedAt,
            modelRef: currentSession.modelRef,
          });
          runTimingId = timing.id;
          const chatWrapper = chatWrapperRef.current;
          if (!chatWrapper) throw new Error('Chat controller is not ready');
          await chatWrapper.sendMessage(prompt, attachments, gatewayPrompt, {
            propagateRequestFailure: goalEdit,
            clientTurnId,
            onRunBound: runId => coworkService.bindSessionRun(timing.id, runId, currentSession.id),
          });
        },
        err => {
          if (runTimingId) void coworkService.failSessionRun(currentSession.id, runTimingId);
          else {
            void coworkService.refreshSessionRuntimeActivity(currentSession.id, {
              includeSubagents: true,
              forceRefresh: true,
              fullScan: true,
            });
          }
          if (goalEdit) return;
          const message = err instanceof Error ? err.message : String(err);
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkErrorSessionStartFailed').replace('{error}', message),
            }),
          );
        },
      );
    };

    const handleOpenSessionExport = () => {
      const snapshot = chatWrapperRef.current?.getExportSnapshot();
      if (!snapshot || snapshot.isLoading) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkExportHistoryLoading'),
          }),
        );
        return;
      }
      setSessionExportMessageCount(snapshot.messages.length);
      setIsSessionExportOpen(true);
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
          title: i18nService.t('coworkExportSession'),
          defaultFileName: buildSessionExportFileName(currentSession.title),
          content: `${JSON.stringify(document, null, 2)}\n`,
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

    return (
      <div className="relative flex-1 flex flex-col h-full">
        {/* Header */}
        <div className="draggable relative flex h-12 items-center justify-between px-4 border-b border-border shrink-0">
          <div className="non-draggable h-8 flex items-center">
            {isSidebarCollapsed && (
              <div className={`flex items-center gap-1 mr-2 ${isMac ? 'pl-[68px]' : ''}`}>
                <button
                  type="button"
                  onClick={onToggleSidebar}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                >
                  <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
                </button>
                <button
                  type="button"
                  onClick={onNewChat}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                >
                  <ComposeIcon className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
          <div className="non-draggable flex min-w-0 items-center gap-1">
            {currentSessionFolderPath && currentSessionFolderName && (
              <button
                type="button"
                onClick={handleOpenCurrentSessionFolder}
                className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg px-2.5 text-sm text-secondary transition-colors hover:bg-surface-raised hover:text-primary"
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
              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
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
              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                isSessionSearchOpen
                  ? 'text-primary hover:bg-surface-raised'
                  : 'text-secondary hover:bg-surface-raised hover:text-foreground'
              }`}
              title={i18nService.t('coworkSearchInSession')}
              aria-label={i18nService.t('coworkSearchInSession')}
            >
              <SearchIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onMouseDown={event => event.stopPropagation()}
              onClick={event => {
                event.stopPropagation();
                handleOpenSessionExport();
              }}
              disabled={currentSessionRuntimeRunning}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-secondary"
              title={i18nService.t(
                currentSessionRuntimeRunning
                  ? 'coworkExportWaitForCompletion'
                  : 'coworkExportSession',
              )}
              aria-label={i18nService.t(
                currentSessionRuntimeRunning
                  ? 'coworkExportWaitForCompletion'
                  : 'coworkExportSession',
              )}
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
            </button>
            <SubagentMenu
              sessionId={currentSession.id}
              parentRunning={currentSessionRuntimeRunning}
              onOpenSubagent={setSelectedSubagent}
              onSubagentsChange={handleSubagentsChange}
            />
            <WindowTitleBar inline />
          </div>
          {isSessionSearchOpen && (
            <div
              ref={sessionSearchPanelRef}
              className="non-draggable absolute right-16 top-full z-40 mt-2 flex min-h-9 max-w-[calc(100vw-5rem)] items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 shadow-popover"
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
        <div className="relative flex min-h-0 flex-1 flex-col">
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
            runTimings={sessionRunTimings[currentSession.id] ?? []}
          />
          {/* Input */}
          <div className="shrink-0 pb-4 pt-2">
            <div className="cowork-content-width mx-auto min-w-0 space-y-1.5">
              <div className="relative isolate rounded-2xl">
                <div ref={sessionPromptInputRegionRef} className="shadow-glow-accent rounded-2xl">
                  <CoworkPromptInput
                    onSubmit={handleSendMessage}
                    onStop={handleStopSession}
                    isStreaming={currentSessionRuntimeRunning}
                    disabled={!isEngineReady || isQuestionInputBlocked}
                    placeholder={i18nService.t('coworkContinuePlaceholder')}
                    size="large"
                    showModelSelector={true}
                    sessionId={currentSession.id}
                    modelAgentId={currentSession.agentId}
                    sessionModelRef={currentSession.modelRef}
                    contextUsage={contextUsage}
                    initialGoalObjective={initialGoalObjective}
                    goalRunProgress={goalRunProgress}
                  />
                </div>
                {isQuestionInputBlocked && (
                  <div
                    className="absolute inset-0 z-[60] flex cursor-not-allowed items-center justify-center rounded-2xl bg-background/45 backdrop-blur-[1px]"
                    role="status"
                    aria-live="polite"
                  >
                    <span className="rounded-full border border-border bg-surface/95 px-3 py-1.5 text-xs font-medium text-secondary shadow-subtle">
                      {i18nService.t('coworkQuestionInputBlocked')}
                    </span>
                  </div>
                )}
              </div>
              <p className="px-1 text-center text-[11px] font-light leading-4 text-muted">
                {i18nService.t('aiGeneratedDisclaimer')}
              </p>
            </div>
          </div>
          <SubagentMessageDrawer
            parentSessionId={currentSession.id}
            subagent={selectedSubagent}
            onClose={() => setSelectedSubagent(null)}
          />
          {filePreview && (
            <FilePreviewDrawer
              ref={filePreviewDrawerRef}
              preview={filePreview}
              onClose={() => setFilePreview(null)}
            />
          )}
          <ExportSessionModal
            isOpen={isSessionExportOpen}
            sessionTitle={currentSession.title}
            messageCount={sessionExportMessageCount}
            onClose={() => setIsSessionExportOpen(false)}
            onExport={handleExportSession}
          />
        </div>
      </div>
    );
  }

  // Home view - no current session
  return (
    <div className="cowork-home flex-1 flex flex-col h-full">
      {/* Header */}
      {homeHeader}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center px-4 py-10">
          <div className="space-y-12">
            {/* Welcome Section */}
            <div className="text-center space-y-5">
              <img src={logoUrl} alt="logo" className="mx-auto h-[5.333rem] w-[5.333rem]" />
              <h2 className="text-3xl font-bold tracking-tight text-foreground">
                {i18nService.t('coworkWelcome')}
              </h2>
              <p className="text-sm text-secondary max-w-md mx-auto">
                {i18nService.t('coworkDescription')}
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
  );
});

CoworkView.displayName = 'CoworkView';

export default CoworkView;
