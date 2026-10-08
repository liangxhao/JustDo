import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { CoworkInteractionKind } from '@shared/cowork/interactions/interactions';
import { BuiltinModelIpc } from '@shared/providers/builtinModels';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResolved,
} from '@shared/security/approvals';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { applyAppearanceConfig } from '@/app/appearance';
import { defaultConfig, getProviderDisplayName } from '@/app/config';
import BottomRightStatusStack from '@/app/shell/BottomRightStatusStack';
import Sidebar from '@/app/shell/Sidebar';
import { SidebarView } from '@/app/shell/sidebarNavigation';
import StartupLoading from '@/app/shell/StartupLoading';
import Toast, { type ToastContent } from '@/app/shell/Toast';
import WindowHeader from '@/app/shell/window/WindowHeader';
import { WorkspaceNotifications } from '@/app/shell/WorkspaceNotifications';
import { agentService } from '@/features/agents/agentService';
import {
  loadPendingApprovalsWithRetry,
  markApprovalResolved,
  reconcilePendingApprovalSnapshot,
  removePendingApproval,
  upsertPendingApproval,
} from '@/features/cowork/approvalQueue';
import { CoworkView, type CoworkViewHandle } from '@/features/cowork/components';
import ExecApprovalModal from '@/features/cowork/components/approvals/ExecApprovalModal';
import { workspaceKeyboardDocument } from '@/features/cowork/components/display/useWorkspacePortal';
import {
  type FilePreviewNavigationOptions,
  runGuardedFilePreviewNavigation,
} from '@/features/cowork/components/preview/filePreviewNavigation';
import CoworkInteractionModal from '@/features/cowork/components/questions/CoworkInteractionModal';
import CoworkQuestionFloatingWindow, {
  shouldShowCoworkQuestionWindow,
} from '@/features/cowork/components/questions/CoworkQuestionFloatingWindow';
import EngineStartupStatusBar from '@/features/cowork/components/status/EngineStartupStatusBar';
import {
  selectCurrentSessionId,
  selectPendingInteractions,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import type { CoworkInteractionResult } from '@/features/cowork/coworkTypes';
import MemoryView from '@/features/memory/MemoryView';
import {
  BUILTIN_MODELS_UPDATED_EVENT,
  getEnabledProviderModels,
} from '@/features/models/modelConfig';
import { setConfiguredModels } from '@/features/models/modelSlice';
import PluginsView from '@/features/plugins/PluginsView';
import { CronView } from '@/features/scheduled-tasks/components';
import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import Settings, { type SettingsOpenOptions } from '@/features/settings/Settings';
import AppUpdateToast from '@/features/settings/updates/AppUpdateToast';
import {
  type AppUpdateToastState,
  selectAppUpdateToastState,
} from '@/features/settings/updates/appUpdateToastState';
import WorkboardView from '@/features/workboard/components/WorkboardView';
import { useWorkboardAvailability } from '@/features/workboard/useWorkboardAvailability';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { matchesShortcut } from '@/services/shortcuts';
import { themeService } from '@/services/theme';
import { isDomHTMLElement } from '@/shared/dom/ownerDocument';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  const [mainView, setMainView] = useState<SidebarView>(SidebarView.Home);
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastContent | null>(null);
  const [updateToast, setUpdateToast] = useState<AppUpdateToastState>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const workboardEnabled = useWorkboardAvailability(isInitialized);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const resolvedApprovalIdsRef = useRef(new Map<string, number>());
  const dismissedUpdateRevisionRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const coworkViewRef = useRef<CoworkViewHandle>(null);
  const hasInitialized = useRef(false);
  const dispatch = useDispatch();
  const currentSessionId = useSelector(selectCurrentSessionId);
  const pendingInteractions = useSelector(selectPendingInteractions);
  const isWindows = window.electron.platform === 'win32';

  const dismissApproval = useCallback((approval: Pick<ApprovalRequest, 'id' | 'kind'>) => {
    markApprovalResolved(resolvedApprovalIdsRef.current, approval);
    setPendingApprovals(current => removePendingApproval(current, approval));
  }, []);

  const enqueueApproval = useCallback((request: ApprovalRequest) => {
    if (
      !request?.id ||
      !request.request ||
      !Number.isFinite(request.expiresAtMs) ||
      request.expiresAtMs <= Date.now()
    ) {
      return;
    }
    setPendingApprovals(current =>
      upsertPendingApproval(current, request, resolvedApprovalIdsRef.current),
    );
  }, []);

  const applyApprovalSnapshot = useCallback((requests: ApprovalRequest[]) => {
    setPendingApprovals(reconcilePendingApprovalSnapshot(requests, resolvedApprovalIdsRef.current));
  }, []);

  const waitWithTimeout = useCallback(
    async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        promise.then(
          value => {
            window.clearTimeout(timer);
            resolve(value);
          },
          error => {
            window.clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
    [],
  );

  // 初始化应用
  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const initializeApp = async () => {
      try {
        console.info('[App] initializeApp: start');
        // 标记平台，用于 CSS 条件样式（如 Windows 标题栏按钮区域留白）
        document.documentElement.classList.add(`platform-${window.electron.platform}`);

        // 初始化配置
        console.info('[App] initializeApp: configService.init');
        await waitWithTimeout(configService.init(), 5000, 'configService.init');
        applyAppearanceConfig(configService.getConfig().appearance);

        // 初始化主题
        console.info('[App] initializeApp: themeService.initialize');
        themeService.initialize();

        // 初始化语言
        console.info('[App] initializeApp: i18nService.initialize');
        await waitWithTimeout(i18nService.initialize(), 5000, 'i18nService.initialize');

        console.info('[App] initializeApp: configService.getConfig');
        const config = await configService.getConfig();

        // 从 providers 配置中加载可用模型列表到 Redux
        const providerModels: {
          id: string;
          name: string;
          provider?: string;
          providerKey?: string;
          supportsImage?: boolean;
          contextLength?: number;
          maxTokens?: number;
        }[] = [];
        if (config.providers) {
          Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
            if (providerConfig.enabled && providerConfig.models) {
              providerConfig.models.forEach(
                (model: {
                  id: string;
                  name: string;
                  enabled?: boolean;
                  supportsImage?: boolean;
                  contextLength?: number;
                  maxTokens?: number;
                }) => {
                  if (!model?.id || model.enabled === false) {
                    return;
                  }
                  providerModels.push({
                    id: model.id,
                    name: model.name,
                    provider: getProviderDisplayName(providerName, providerConfig),
                    providerKey: providerName,
                    supportsImage: model.supportsImage ?? false,
                    contextLength: model.contextLength,
                    maxTokens: model.maxTokens,
                  });
                },
              );
            }
          });
        }
        const fallbackModels = config.model.availableModels
          .filter(model => model?.id)
          .map(model => ({
            id: model.id,
            name: model.name,
            providerKey: undefined,
            supportsImage: model.supportsImage ?? false,
            contextLength: model.contextLength,
            maxTokens: model.maxTokens,
          }));
        const resolvedModels = providerModels.length > 0 ? providerModels : fallbackModels;
        dispatch(setConfiguredModels({ models: resolvedModels, ...config.model }));

        setIsInitialized(true);
        console.info('[App] initializeApp: shell ready');

        // 初始化定时任务服务，但不阻塞首屏
        void waitWithTimeout(scheduledTaskService.init(), 10000, 'scheduledTaskService.init').catch(
          error => {
            console.error('[App] initializeApp: scheduledTaskService.init failed:', error);
          },
        );

        // 加载 agents 列表，不阻塞首屏
        void agentService.loadAgents();
      } catch (error) {
        console.error('Failed to initialize app:', error);
        setInitError(i18nService.t('initializationError'));
        setIsInitialized(true);
      }
    };

    void initializeApp();
  }, [dispatch, waitWithTimeout]);

  useEffect(
    () =>
      window.electron?.cowork?.onSessionsChanged(() => {
        void agentService.loadAgents();
      }),
    [],
  );

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh(prev => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!workboardEnabled && mainView === 'workboard') setMainView('cowork');
  }, [mainView, workboardEnabled]);

  useEffect(() => {
    const approvals = window.electron.openclaw.approvals;
    type ApprovalEvent =
      | { type: 'requested'; request: ApprovalRequest }
      | { type: 'resolved'; resolved: ApprovalResolved }
      | { type: 'snapshot'; requests: ApprovalRequest[] };
    const bufferedEvents: ApprovalEvent[] = [];
    let loadingInitialSnapshot = true;
    const remove = (resolved: ApprovalResolved) => {
      if (!resolved?.id) return;
      dismissApproval(resolved);
    };
    const dispatchApprovalEvent = (event: ApprovalEvent) => {
      if (event.type === 'requested') enqueueApproval(event.request);
      else if (event.type === 'resolved') remove(event.resolved);
      else applyApprovalSnapshot(event.requests);
    };
    const receiveApprovalEvent = (event: ApprovalEvent) => {
      if (loadingInitialSnapshot) bufferedEvents.push(event);
      else dispatchApprovalEvent(event);
    };
    const stopRequested = approvals.onRequested(request =>
      receiveApprovalEvent({ type: 'requested', request }),
    );
    const stopResolved = approvals.onResolved(resolved =>
      receiveApprovalEvent({ type: 'resolved', resolved }),
    );
    const stopSnapshot = approvals.onSnapshot(requests =>
      receiveApprovalEvent({ type: 'snapshot', requests }),
    );
    let cancelled = false;
    const loadPendingApprovals = async () => {
      const result = await loadPendingApprovalsWithRetry({
        list: approvals.list,
        wait: delayMs => new Promise(resolve => window.setTimeout(resolve, delayMs)),
        isCancelled: () => cancelled,
      });
      if (!result) return;
      if (result.success) {
        applyApprovalSnapshot(result.requests);
      } else {
        console.error('[App] Failed to load pending approvals:', result.error);
      }
      loadingInitialSnapshot = false;
      bufferedEvents.splice(0).forEach(dispatchApprovalEvent);
    };
    void loadPendingApprovals();
    return () => {
      cancelled = true;
      stopRequested();
      stopResolved();
      stopSnapshot();
    };
  }, [applyApprovalSnapshot, dismissApproval, enqueueApproval]);

  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on(BuiltinModelIpc.Changed, () => {
      void configService
        .reloadFromStore()
        .then(config => {
          dispatch(
            setConfiguredModels({
              models: getEnabledProviderModels(config.providers),
              ...config.model,
            }),
          );
          window.dispatchEvent(new CustomEvent(BUILTIN_MODELS_UPDATED_EVENT));
        })
        .catch(error => {
          console.error('[App] Failed to reload models after authentication change:', error);
        });
    });
    return unsubscribe;
  }, [dispatch]);

  useEffect(() => {
    let active = true;
    const applyUpdateState = (state: Parameters<typeof selectAppUpdateToastState>[1]) => {
      if (!active) return;
      setUpdateToast(current =>
        selectAppUpdateToastState(current, state, dismissedUpdateRevisionRef.current),
      );
    };
    const unsubscribe = window.electron.appUpdate.onStateChanged(applyUpdateState);
    void window.electron.appUpdate
      .getState()
      .then(applyUpdateState)
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      console.log('[Renderer] Network online');
      window.electron.networkStatus.send('online');
    };

    const handleOffline = () => {
      console.log('[Renderer] Network offline');
      window.electron.networkStatus.send('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions({
      initialTab: options?.initialTab,
      browserPage: options?.browserPage,
      notice: options?.notice,
    });
    setShowSettings(true);
  }, []);

  const handleShowCowork = useCallback(() => {
    setMainView('cowork');
  }, []);

  const requestCoworkNavigation = useCallback(
    async (options?: FilePreviewNavigationOptions): Promise<boolean> => {
      return (await coworkViewRef.current?.requestFilePreviewTransition(options)) ?? true;
    },
    [],
  );

  const handleShowScheduledTasks = useCallback(async () => {
    await runGuardedFilePreviewNavigation(
      requestCoworkNavigation,
      () => setMainView('scheduledTasks'),
      { preserveTabs: true },
    );
  }, [requestCoworkNavigation]);

  const handleShowWorkboard = useCallback(async () => {
    if (!workboardEnabled) return;
    await runGuardedFilePreviewNavigation(requestCoworkNavigation, () => setMainView('workboard'), {
      preserveTabs: true,
    });
  }, [requestCoworkNavigation, workboardEnabled]);

  const handleShowPlugins = useCallback(async () => {
    await runGuardedFilePreviewNavigation(requestCoworkNavigation, () => setMainView('plugins'), {
      preserveTabs: true,
    });
  }, [requestCoworkNavigation]);

  const handleShowMemory = useCallback(async () => {
    await runGuardedFilePreviewNavigation(requestCoworkNavigation, () => setMainView('memory'), {
      preserveTabs: true,
    });
  }, [requestCoworkNavigation]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed(prev => !prev);
  }, []);

  const handlePreparedNewChat = useCallback(
    async (prepare?: () => Promise<boolean>): Promise<boolean> => {
      return runGuardedFilePreviewNavigation(
        requestCoworkNavigation,
        () => {
          const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
          coworkService.clearSession();
          setMainView('cowork');
          window.setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent('cowork:focus-input', {
                detail: { clear: shouldClearInput },
              }),
            );
          }, 0);
        },
        { preserveTabs: true },
        prepare,
      );
    },
    [mainView, currentSessionId, requestCoworkNavigation],
  );
  const handleNewChat = useCallback(() => handlePreparedNewChat(), [handlePreparedNewChat]);

  const showToast = useCallback((content: string | ToastContent) => {
    const nextToast = typeof content === 'string' ? { message: content } : content;
    setToast(nextToast);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, nextToast.duration ?? 2600);
  }, []);

  const handleDownloadAppUpdate = useCallback(async () => {
    try {
      const result = await window.electron.appUpdate.download();
      if (!result.success) {
        setUpdateToast(current =>
          current ? { ...current, state: result.state, installError: false } : current,
        );
      }
    } catch {
      setUpdateToast(current =>
        current
          ? {
              ...current,
              state: {
                ...current.state,
                revision: current.state.revision + 1,
                phase: 'error',
                errorCode: 'DOWNLOAD_FAILED',
              },
              installError: false,
            }
          : current,
      );
    }
  }, []);

  const handleInstallAppUpdate = useCallback(async () => {
    setUpdateToast(current =>
      current ? { ...current, installing: true, installError: false } : current,
    );
    try {
      const result = await window.electron.appUpdate.quitAndInstall();
      if (!result.success) {
        setUpdateToast(current =>
          current ? { ...current, installing: false, installError: true } : current,
        );
      }
    } catch {
      setUpdateToast(current =>
        current ? { ...current, installing: false, installError: true } : current,
      );
    }
  }, []);

  const handleDismissAppUpdate = useCallback(() => {
    setUpdateToast(current => {
      dismissedUpdateRevisionRef.current = current?.state.revision ?? null;
      return null;
    });
  }, []);

  const handleInteractionResponse = useCallback(
    async (requestId: string, result: CoworkInteractionResult): Promise<boolean> => {
      try {
        const success = await coworkService.respondToInteraction(requestId, result);
        if (!success) {
          showToast(i18nService.t('coworkInteractionResponseFailed'));
        }
        return success;
      } catch (error) {
        console.error('Failed to respond to interaction:', error);
        showToast(i18nService.t('coworkInteractionResponseFailed'));
        return false;
      }
    },
    [showToast],
  );

  const handleCloseSettings = () => {
    setShowSettings(false);
    const config = configService.getConfig();

    if (config.providers) {
      const allModels: {
        id: string;
        name: string;
        provider?: string;
        providerKey?: string;
        supportsImage?: boolean;
        contextLength?: number;
        maxTokens?: number;
      }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach(
            (model: {
              id: string;
              name: string;
              enabled?: boolean;
              supportsImage?: boolean;
              contextLength?: number;
              maxTokens?: number;
            }) => {
              if (!model?.id || model.enabled === false) {
                return;
              }
              allModels.push({
                id: model.id,
                name: model.name,
                provider: getProviderDisplayName(providerName, providerConfig),
                providerKey: providerName,
                supportsImage: model.supportsImage ?? false,
                contextLength: model.contextLength,
                maxTokens: model.maxTokens,
              });
            },
          );
        }
      });
      dispatch(setConfiguredModels({ models: allModels, ...config.model }));
    }
  };

  const isShortcutInputActive = (event?: Event) => {
    const activeElement = ((event && workspaceKeyboardDocument.get(event)) ?? document)
      .activeElement;
    if (!isDomHTMLElement(activeElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        pendingApprovals.length > 0 ||
        isShortcutInputActive(event)
      )
        return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      if (matchesShortcut(event, activeShortcuts.newChat)) {
        event.preventDefault();
        handleNewChat();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.search)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:search'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.settings)) {
        event.preventDefault();
        handleShowSettings();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.terminal)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:terminal'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.browser)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:browser'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.sideChat)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:side-chat'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.review)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:review'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.files)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:files'));
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleShowSettings, handleNewChat, pendingApprovals.length]);

  useEffect(() => {
    if (!isInitialized) return;
    const syncPanelShortcuts = () => {
      const shortcuts = {
        ...defaultConfig.shortcuts!,
        ...(configService.getConfig().shortcuts ?? {}),
      };
      window.electron.browser.setPanelShortcuts({
        terminal: shortcuts.terminal,
        browser: shortcuts.browser,
        'side-chat': shortcuts.sideChat,
        files: shortcuts.files,
        review: shortcuts.review,
      });
    };
    syncPanelShortcuts();
    window.addEventListener('config-updated', syncPanelShortcuts);
    const unsubscribe = window.electron.browser.onPanelShortcutAction(action => {
      if (pendingApprovals.length > 0 || isShortcutInputActive()) return;
      window.dispatchEvent(new CustomEvent(`cowork:shortcut:${action}`));
    });
    return () => {
      window.removeEventListener('config-updated', syncPanelShortcuts);
      unsubscribe();
    };
  }, [isInitialized, pendingApprovals.length]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Listen for toast events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string | ToastContent>).detail;
      if (typeof detail === 'string' ? detail : detail?.message) showToast(detail);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // 监听托盘菜单打开设置的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:openSettings', () => {
      handleShowSettings();
    });
    return unsubscribe;
  }, [handleShowSettings]);

  // 监听托盘菜单新建任务的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:newTask', () => {
      handleNewChat();
    });
    return unsubscribe;
  }, [handleNewChat]);

  const activePlanInteraction = pendingInteractions.find(
    interaction =>
      interaction.interactionKind === CoworkInteractionKind.PLAN_APPROVAL &&
      interaction.sessionId === currentSessionId,
  );
  const structuredQuestionInteractions = useMemo(
    () =>
      pendingInteractions.filter(
        interaction => interaction.interactionKind === CoworkInteractionKind.STRUCTURED_QUESTION,
      ),
    [pendingInteractions],
  );
  const activeQuestionInteraction = structuredQuestionInteractions.find(interaction =>
    shouldShowCoworkQuestionWindow(
      interaction.sessionId,
      currentSessionId,
      !showSettings && mainView === 'cowork',
    ),
  );
  const activeQuestionRequestId = activeQuestionInteraction?.requestId ?? null;
  const isQuestionWindowVisible = activeQuestionRequestId !== null;
  const displayedPlanInteraction = isQuestionWindowVisible ? undefined : activePlanInteraction;
  const modalInteraction =
    displayedPlanInteraction || isQuestionWindowVisible
      ? undefined
      : pendingInteractions.find(
          interaction =>
            interaction.interactionKind !== CoworkInteractionKind.STRUCTURED_QUESTION &&
            interaction.interactionKind !== CoworkInteractionKind.PLAN_APPROVAL,
        );

  const questionWindows = useMemo(() => {
    return structuredQuestionInteractions.map(interaction => (
      <CoworkQuestionFloatingWindow
        key={interaction.requestId}
        interaction={interaction}
        isVisible={interaction.requestId === activeQuestionRequestId}
        onRespond={result => handleInteractionResponse(interaction.requestId, result)}
      />
    ));
  }, [structuredQuestionInteractions, activeQuestionRequestId, handleInteractionResponse]);

  const interactionModal = useMemo(() => {
    if (!modalInteraction) return null;

    return (
      <CoworkInteractionModal
        key={modalInteraction.requestId}
        interaction={modalInteraction}
        onRespond={result => handleInteractionResponse(modalInteraction.requestId, result)}
      />
    );
  }, [modalInteraction, handleInteractionResponse]);

  const activeApproval = pendingApprovals[0] ?? null;

  const resolveExecApproval = useCallback(
    async (decision: ApprovalDecision) => {
      if (!activeApproval) return;
      const result = await window.electron.openclaw.approvals.resolve(
        activeApproval.id,
        decision,
        activeApproval.kind,
      );
      if (!result.success) {
        const message = result.error || i18nService.t('execApprovalFailed');
        if (/unknown|expired|not found|already resolved/i.test(message)) {
          dismissApproval(activeApproval);
          return;
        }
        throw new Error(message);
      }
      dismissApproval(activeApproval);
    },
    [activeApproval, dismissApproval],
  );
  const windowsStandaloneTitleBar = isWindows ? <WindowHeader /> : null;

  if (!isInitialized) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <StartupLoading />
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {!showSettings && windowsStandaloneTitleBar}
        {showSettings ? (
          <div className="min-h-0 flex-1 bg-background">
            <Settings
              onClose={handleCloseSettings}
              initialTab={settingsOptions.initialTab}
              notice={settingsOptions.notice}
            />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center bg-background">
            <div className="flex flex-col items-center space-y-6 max-w-md px-6">
              <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
                <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
              </div>
              <div className="text-foreground text-xl font-medium text-center">{initError}</div>
              <button
                onClick={() => handleShowSettings()}
                className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-xl shadow-md transition-colors text-sm font-medium"
              >
                {i18nService.t('openSettings')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-surface-raised">
      {/* Bridge the shell's top inset to the view title bars, including while
          the gateway is starting. Keep this strip clear of window controls. */}
      <div aria-hidden="true" className="draggable fixed inset-x-0 top-0 z-40 h-1.5 select-none" />
      <WorkspaceNotifications>
        <BottomRightStatusStack>
          <EngineStartupStatusBar />
          {updateToast && (
            <AppUpdateToast
              state={updateToast.state}
              installing={updateToast.installing}
              installError={updateToast.installError}
              onDownload={() => void handleDownloadAppUpdate()}
              onInstall={() => void handleInstallAppUpdate()}
              onDismiss={handleDismissAppUpdate}
            />
          )}
        </BottomRightStatusStack>
        {toast && <Toast {...toast} onClose={() => setToast(null)} />}
      </WorkspaceNotifications>
      <div
        className={`${showSettings ? 'flex' : 'grid grid-cols-[2.75rem_auto_minmax(0,1fr)] grid-rows-[2.25rem_minmax(0,1fr)]'} flex-1 min-h-0 overflow-hidden`}
      >
        {showSettings && (
          <div className="flex-1 min-w-0 p-1.5">
            <div className="relative h-full min-h-0 overflow-hidden rounded-xl bg-background">
              <Settings
                onClose={handleCloseSettings}
                initialTab={settingsOptions.initialTab}
                notice={settingsOptions.notice}
              />
            </div>
          </div>
        )}
        {!showSettings && (
          <Sidebar
            onShowSettings={handleShowSettings}
            activeView={mainView}
            onShowCowork={handleShowCowork}
            onShowScheduledTasks={handleShowScheduledTasks}
            onShowWorkboard={handleShowWorkboard}
            showWorkboard={workboardEnabled}
            onShowMemory={handleShowMemory}
            onShowPlugins={handleShowPlugins}
            onNewChat={handleNewChat}
            onBeforeCoworkNavigation={requestCoworkNavigation}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={handleToggleSidebar}
            onRevealSearchMatch={match => coworkViewRef.current?.revealSearchMatch(match)}
          />
        )}
        {!showSettings && (
          <div
            className={`col-start-2 col-span-2 row-start-1 min-w-0 pt-1.5 pr-1.5 ${isSidebarCollapsed || mainView !== SidebarView.Home ? 'pl-1.5' : ''}`}
          >
            <div className="overflow-hidden rounded-t-xl bg-background">
              <WindowHeader />
            </div>
          </div>
        )}
        <div
          className={`${showSettings ? 'hidden' : ''} col-start-3 row-start-2 min-h-0 min-w-0 pb-1.5 pr-1.5 ${isSidebarCollapsed || mainView !== SidebarView.Home ? 'pl-1.5' : ''}`}
        >
          <div className="relative h-full min-h-0 rounded-b-xl bg-background overflow-hidden">
            {mainView === 'scheduledTasks' && (
              <CronView
                isSidebarCollapsed={false}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
              />
            )}
            {mainView === 'workboard' && workboardEnabled && (
              <WorkboardView
                isSidebarCollapsed={false}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
              />
            )}
            {mainView === 'plugins' && (
              <PluginsView
                isSidebarCollapsed={false}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
              />
            )}
            {mainView === 'memory' && (
              <MemoryView
                isSidebarCollapsed={false}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
              />
            )}
            <div className={mainView === 'cowork' ? 'h-full' : 'hidden'}>
              <CoworkView
                ref={coworkViewRef}
                onRequestAppSettings={handleShowSettings}
                isQuestionInputBlocked={
                  isQuestionWindowVisible || displayedPlanInteraction !== undefined
                }
                inputBlockedMessage={
                  displayedPlanInteraction ? i18nService.t('coworkPlanInputBlocked') : undefined
                }
                onNewChat={handleNewChat}
                planInteraction={displayedPlanInteraction}
                onPlanRespond={result =>
                  displayedPlanInteraction
                    ? handleInteractionResponse(displayedPlanInteraction.requestId, result)
                    : Promise.resolve(false)
                }
              />
            </div>
          </div>
        </div>
      </div>
      {questionWindows}
      {interactionModal}
      {activeApproval && (
        <ExecApprovalModal
          approval={activeApproval}
          onExpire={() => dismissApproval(activeApproval)}
          onResolve={resolveExecApproval}
        />
      )}
    </div>
  );
};

export default App;
