import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { quickActionService } from '../../services/quickAction';
import { RootState } from '../../store';
import {
  selectCoworkConfig,
  selectCurrentSession,
  selectIsOpenClawEngine,
  selectIsStreaming,
} from '../../store/selectors/coworkSelectors';
import {
  addMessage,
  clearCurrentSession,
  setCurrentSession,
  setStreaming,
  updateSessionStatus,
} from '../../store/slices/coworkSlice';
import { clearSelection, setActions } from '../../store/slices/quickActionSlice';
import { clearActiveSkills } from '../../store/slices/skillSlice';
import type {
  CoworkImageAttachment,
  CoworkSession,
  OpenClawEngineStatus,
} from '../../types/cowork';
import { getCompactFolderName } from '../../utils/path';
import ComposeIcon from '../icons/ComposeIcon';
import FolderIcon from '../icons/FolderIcon';
import SearchIcon from '../icons/SearchIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import { PromptPanel } from '../quick-actions';
import type { SettingsOpenOptions } from '../Settings';
import WindowTitleBar from '../window/WindowTitleBar';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import JustDoChatWrapper, { type JustDoChatWrapperRef } from './JustDoChatWrapper';
import SubagentMenu, { type Subagent } from './SubagentMenu';
import SubagentMessageDrawer from './SubagentMessageDrawer';

export interface CoworkViewProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
}

const CoworkView: React.FC<CoworkViewProps> = ({
  onRequestAppSettings,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const [isInitialized, setIsInitialized] = useState(false);
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawEngineStatus | null>(null);
  const [isRestartingGateway, setIsRestartingGateway] = useState(false);
  const [selectedSubagent, setSelectedSubagent] = useState<Subagent | null>(null);
  const [isSessionSearchOpen, setIsSessionSearchOpen] = useState(false);
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
  // Ref for JustDoChatWrapper (to call sendMessage)
  const chatWrapperRef = useRef<JustDoChatWrapperRef>(null);
  // Buffer for pending user message when JustDoChatWrapper isn't mounted yet
  const pendingPromptRef = useRef<string | null>(null);

  const currentSession = useSelector(selectCurrentSession);
  const isStreaming = useSelector(selectIsStreaming);
  const config = useSelector(selectCoworkConfig);
  const isOpenClawEngine = useSelector(selectIsOpenClawEngine);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const quickActions = useSelector((state: RootState) => state.quickAction.actions);
  const selectedActionId = useSelector((state: RootState) => state.quickAction.selectedActionId);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);

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

  const resolveEngineStatusText = (status: OpenClawEngineStatus): string => {
    switch (status.phase) {
      case 'not_installed':
        return i18nService.t('coworkOpenClawNotInstalledNotice');
      case 'installing':
        return i18nService.t('coworkOpenClawInstalling');
      case 'ready':
        return i18nService.t('coworkOpenClawReadyNotice');
      case 'starting':
        return i18nService.t('coworkOpenClawStarting');
      case 'error':
        return i18nService.t('coworkOpenClawError');
      case 'running':
      default:
        return i18nService.t('coworkOpenClawRunning');
    }
  };

  const isOpenClawReadyForSession = (status: OpenClawEngineStatus | null): boolean => {
    if (!status) return false;
    return status.phase === 'running' || status.phase === 'ready';
  };

  const handleRestartGateway = async () => {
    if (isRestartingGateway) return;
    setIsRestartingGateway(true);
    try {
      await coworkService.restartOpenClawGateway();
    } catch (error) {
      console.error('[CoworkView] Failed to restart gateway:', error);
    } finally {
      setIsRestartingGateway(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      await coworkService.init();
      const initialEngineStatus = await coworkService.getOpenClawEngineStatus();
      if (initialEngineStatus) {
        setOpenClawStatus(initialEngineStatus);
      }
      // Load quick actions with localization
      try {
        quickActionService.initialize();
        const actions = await quickActionService.getLocalizedActions();
        dispatch(setActions(actions));
      } catch (error) {
        console.error('Failed to load quick actions:', error);
      }
      try {
        const apiConfig = await coworkService.checkApiConfig();
        if (apiConfig && !apiConfig.hasConfig) {
          onRequestAppSettings?.({
            initialTab: 'model',
            ...buildApiConfigNotice(apiConfig.error),
          });
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }
      setIsInitialized(true);
    };
    init();

    const unsubscribeOpenClawStatus = coworkService.onOpenClawEngineStatus(status => {
      setOpenClawStatus(status);
    });

    // Subscribe to language changes to reload quick actions
    const unsubscribe = quickActionService.subscribe(async () => {
      try {
        const actions = await quickActionService.getLocalizedActions();
        dispatch(setActions(actions));
      } catch (error) {
        console.error('Failed to reload quick actions:', error);
      }
    });

    return () => {
      unsubscribe();
      unsubscribeOpenClawStatus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  const handleStartSession = async (
    prompt: string,
    imageAttachments?: CoworkImageAttachment[],
  ): Promise<boolean | void> => {
    if (isOpenClawEngine && openClawStatus && !isOpenClawReadyForSession(openClawStatus)) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('coworkErrorEngineNotReady') }),
      );
      return false;
    }
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

      // Capture active skill IDs before clearing them
      const sessionSkillIds = [...activeSkillIds];

      const tempSession: CoworkSession = {
        id: tempSessionId,
        title: fallbackTitle,
        claudeSessionId: null,
        status: 'running',
        pinned: false,
        createdAt: now,
        updatedAt: now,
        cwd: config.workingDirectory || '',
        executionMode: config.executionMode || 'local',
        activeSkillIds: sessionSkillIds,
        agentId: currentAgentId,
        messages: [
          {
            id: `msg-${now}`,
            type: 'user',
            content: prompt,
            timestamp: now,
            metadata:
              sessionSkillIds.length > 0 || (imageAttachments && imageAttachments.length > 0)
                ? {
                    ...(sessionSkillIds.length > 0 ? { skillIds: sessionSkillIds } : {}),
                    ...(imageAttachments && imageAttachments.length > 0
                      ? { imageAttachments }
                      : {}),
                  }
                : undefined,
          },
        ],
      };

      // Immediately show the session detail page with user message
      dispatch(setCurrentSession(tempSession));
      dispatch(setStreaming(true));

      // Set the pending user message on the ChatController so it appears
      // immediately in the Lit chat element, surviving session transitions.
      // Buffer in ref first (survives across renders), then try immediate apply.
      pendingPromptRef.current = prompt;
      const wrapperSet = chatWrapperRef.current;
      console.log('[CoworkView] handleStartSession:', {
        prompt: prompt.slice(0, 60),
        wrapperRefExists: !!wrapperSet,
        tempSessionId: tempSessionId,
      });
      wrapperSet?.setPendingUserMessage(prompt);

      // Clear active skills and quick action selection after starting session
      // so they don't persist to next session
      dispatch(clearActiveSkills());
      dispatch(clearSelection());

      // Start the actual session immediately with fallback title
      const { session: startedSession, error: startError } = await coworkService.startSession({
        prompt,
        title: fallbackTitle,
        cwd: config.workingDirectory || undefined,
        activeSkillIds: sessionSkillIds,
        agentId: currentAgentId,
        imageAttachments,
      });

      if (!startedSession && startError) {
        // Show the error as a system message in the temp session
        dispatch(
          addMessage({
            sessionId: tempSessionId,
            message: {
              id: `error-${Date.now()}`,
              type: 'system',
              content: i18nService
                .t('coworkErrorSessionStartFailed')
                .replace('{error}', startError),
              timestamp: Date.now(),
            },
          }),
        );
        dispatch(updateSessionStatus({ sessionId: tempSessionId, status: 'error' }));
        chatWrapperRef.current?.clearSending();
        return;
      }

      // Generate title in the background and update when ready
      if (startedSession) {
        coworkService
          .generateSessionTitle(prompt)
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
    if (!currentSession) return;
    if (currentSession.id.startsWith('temp-') && pendingStartRef.current) {
      pendingStartRef.current.cancelled = true;
      pendingStartRef.current.cancellationAction = 'stop';
    }
    await coworkService.stopSession(currentSession.id);
  };

  const handleSubagentsChange = useCallback((subagents: Subagent[]) => {
    setSelectedSubagent(current => {
      if (!current) return null;
      return subagents.find(subagent => subagent.id === current.id) ?? current;
    });
  }, []);

  // Get selected quick action
  const selectedAction = React.useMemo(() => {
    return quickActions.find(action => action.id === selectedActionId);
  }, [quickActions, selectedActionId]);

  // When the mapped skill is deactivated from input area, restore the QuickActionBar
  useEffect(() => {
    if (!selectedActionId) return;
    const action = quickActions.find(a => a.id === selectedActionId);
    if (action) {
      const skillStillActive = activeSkillIds.includes(action.skillMapping);
      if (!skillStillActive) {
        dispatch(clearSelection());
      }
    }
  }, [activeSkillIds, dispatch, quickActions, selectedActionId]);

  // Handle prompt selection from QuickAction
  const handleQuickActionPromptSelect = (prompt: string) => {
    // Fill the prompt into input
    promptInputRef.current?.setValue(prompt);
    promptInputRef.current?.focus();
  };

  useEffect(() => {
    const handleNewSession = () => {
      dispatch(clearCurrentSession());
      dispatch(clearSelection());
      window.dispatchEvent(
        new CustomEvent('cowork:focus-input', {
          detail: { clear: true },
        }),
      );
    };
    window.addEventListener('cowork:shortcut:new-session', handleNewSession);
    return () => {
      window.removeEventListener('cowork:shortcut:new-session', handleNewSession);
    };
  }, [dispatch]);

  useEffect(() => {
    if (!isOpenClawEngine) return;
    if (!currentSession || currentSession.status !== 'running') return;

    const runningSessionId = currentSession.id;
    const handleWindowFocus = () => {
      void coworkService.loadSession(runningSessionId);
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [currentSession, isOpenClawEngine]);

  useEffect(() => {
    setSelectedSubagent(null);
  }, [currentSession?.id]);

  useEffect(() => {
    setIsSessionSearchOpen(false);
    setSessionSearchQuery('');
    setSessionSearchMatchCount(0);
    setSessionSearchActiveIndex(-1);
    setSessionSearchNavigation({ token: 0, direction: 1 });
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
          detail:
            error instanceof Error ? error.message : i18nService.t('coworkOpenFolderFailed'),
        }),
      );
    }
  }, [currentSessionFolderPath]);

  // Apply pending prompt to ChatController once the wrapper is mounted
  useEffect(() => {
    if (!pendingPromptRef.current || !chatWrapperRef.current) return;
    console.log('[CoworkView] useEffect applying pendingPrompt:', pendingPromptRef.current.slice(0, 60));
    chatWrapperRef.current.setPendingUserMessage(pendingPromptRef.current);
    pendingPromptRef.current = null;
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

  const shouldShowEngineStatus = Boolean(
    isOpenClawEngine && openClawStatus && openClawStatus.phase !== 'running',
  );
  const isEngineError = openClawStatus?.phase === 'error';
  const isEngineReady = isOpenClawEngine ? isOpenClawReadyForSession(openClawStatus) : true;

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

  // Engine status banner for error/non-running states (starting overlay is now global in App.tsx)
  const engineStatusBanner =
    shouldShowEngineStatus && openClawStatus && openClawStatus.phase !== 'starting' ? (
      <div
        className={`shrink-0 flex items-center justify-between px-4 py-2 text-xs ${
          isEngineError
            ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
            : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
        }`}
      >
        <div className="flex items-center gap-2">
          <span>{resolveEngineStatusText(openClawStatus)}</span>
          {typeof openClawStatus.progressPercent === 'number' && (
            <span className="opacity-70">({Math.round(openClawStatus.progressPercent)}%)</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleRestartGateway}
          disabled={isRestartingGateway}
          className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            isEngineError
              ? 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600'
              : 'bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600'
          }`}
        >
          {i18nService.t('coworkOpenClawRestartGateway')}
        </button>
      </div>
    ) : null;

  // When there's a current session, show the session detail view
  if (currentSession) {
    const handleSendMessage = async (prompt: string) => {
      try {
        await chatWrapperRef.current?.sendMessage(prompt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkErrorSessionStartFailed').replace('{error}', message),
          }),
        );
      }
    };

    return (
      <div className="relative flex-1 flex flex-col h-full">
        {engineStatusBanner}
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
            <SubagentMenu
              sessionId={currentSession.id}
              onOpenSubagent={setSelectedSubagent}
              onSubagentsChange={handleSubagentsChange}
              shouldRefresh={selectedSubagent !== null}
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
            searchQuery={isSessionSearchOpen ? sessionSearchQuery : ''}
            searchCaseSensitive={!sessionSearchIgnoreCase}
            searchNavigationToken={sessionSearchNavigation.token}
            searchNavigationDirection={sessionSearchNavigation.direction}
            onSearchMatchCountChange={handleSessionSearchMatchCountChange}
          />
          {/* Input */}
          <div className="shrink-0 pb-4 pt-2">
            <div
              className="mx-auto min-w-0 space-y-1.5"
              style={{ width: 'clamp(320px, 75%, 1120px)', maxWidth: 'calc(100% - 32px)' }}
            >
              <div className="shadow-glow-accent rounded-2xl">
                <CoworkPromptInput
                  onSubmit={handleSendMessage}
                  onStop={handleStopSession}
                  isStreaming={isStreaming}
                  disabled={!isEngineReady}
                  placeholder={i18nService.t('coworkContinuePlaceholder')}
                  size="large"
                  showModelSelector={true}
                  sessionId={currentSession.id}
                />
              </div>
              <p className="px-1 text-center text-[11px] font-light leading-4 text-muted">
                {i18nService.t('aiGeneratedDisclaimer')}
              </p>
            </div>
          </div>
          <SubagentMessageDrawer
            subagent={selectedSubagent}
            onClose={() => setSelectedSubagent(null)}
          />
        </div>
      </div>
    );
  }

  // Home view - no current session
  return (
    <div className="flex-1 flex flex-col bg-background h-full">
      {/* Engine status banner for error states */}
      {engineStatusBanner}

      {/* Header */}
      {homeHeader}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center px-4 py-10">
          <div className="space-y-12">
            {/* Welcome Section */}
            <div className="text-center space-y-5">
              <img src="logo.png" alt="logo" className="w-16 h-16 mx-auto" />
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

            {/* Quick Actions - temporarily hidden */}
            <div className="space-y-4">
              {selectedAction ? (
                <PromptPanel
                  action={selectedAction}
                  onPromptSelect={handleQuickActionPromptSelect}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CoworkView;
