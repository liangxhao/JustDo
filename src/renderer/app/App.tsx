import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { BuiltinModelIpc } from '@shared/builtinModels';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResolved,
} from '@shared/openclaw/approvals';
import { CoworkInteractionKind } from '@shared/openclaw/extensions';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { applyAppearanceConfig } from '@/app/appearance';
import { defaultConfig, getProviderDisplayName } from '@/app/config';
import Sidebar from '@/app/shell/Sidebar';
import Toast from '@/app/shell/Toast';
import WindowTitleBar from '@/app/shell/window/WindowTitleBar';
import { agentService } from '@/features/agents/agentService';
import {
  loadPendingApprovalsWithRetry,
  markApprovalResolved,
  reconcilePendingApprovalSnapshot,
  removePendingApproval,
  upsertPendingApproval,
} from '@/features/cowork/approvalQueue';
import { CoworkView, type CoworkViewHandle } from '@/features/cowork/components';
import CoworkInteractionModal from '@/features/cowork/components/CoworkInteractionModal';
import CoworkQuestionFloatingWindow, {
  shouldShowCoworkQuestionWindow,
} from '@/features/cowork/components/CoworkQuestionFloatingWindow';
import EngineStartupStatusBar from '@/features/cowork/components/EngineStartupStatusBar';
import ExecApprovalModal from '@/features/cowork/components/ExecApprovalModal';
import { runGuardedFilePreviewNavigation } from '@/features/cowork/components/filePreviewNavigation';
import {
  selectCurrentSessionId,
  selectPendingInteractions,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import type { CoworkInteractionResult } from '@/features/cowork/coworkTypes';
import {
  BUILTIN_MODELS_UPDATED_EVENT,
  getEnabledProviderModels,
} from '@/features/models/modelConfig';
import { setAvailableModels, setSelectedModel } from '@/features/models/modelSlice';
import PluginsView from '@/features/plugins/components/PluginsView';
import { CronView } from '@/features/scheduled-tasks/components';
import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import {
  type AppUpdateToastState,
  selectAppUpdateToastState,
} from '@/features/settings/appUpdateToastState';
import AppUpdateToast from '@/features/settings/components/AppUpdateToast';
import Settings, { type SettingsOpenOptions } from '@/features/settings/Settings';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { matchesShortcut } from '@/services/shortcuts';
import { themeService } from '@/services/theme';
import { RootState, store } from '@/store';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  const [mainView, setMainView] = useState<'cowork' | 'scheduledTasks' | 'plugins'>('cowork');
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [updateToast, setUpdateToast] = useState<AppUpdateToastState>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [developerModeAvailable, setDeveloperModeAvailable] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const resolvedApprovalIdsRef = useRef(new Map<string, number>());
  const dismissedUpdateRevisionRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const coworkViewRef = useRef<CoworkViewHandle>(null);
  const hasInitialized = useRef(false);
  const dispatch = useDispatch();
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const pendingInteractions = useSelector(selectPendingInteractions);
  const pendingInteraction = pendingInteractions[0] ?? null;
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

        try {
          const developerConfig = await waitWithTimeout(
            window.electron.developerConfig.get(),
            5000,
            'developerConfig.get',
          );
          setDeveloperModeAvailable(developerConfig.showDeveloperMode === true);
        } catch {
          setDeveloperModeAvailable(false);
        }

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
        dispatch(setAvailableModels(resolvedModels));
        if (resolvedModels.length > 0) {
          // Restore previously selected model if available
          // so that a previously selected model is correctly restored.
          const allModels = store.getState().model.availableModels;
          const preferredModel =
            allModels.find(
              model =>
                model.id === config.model.defaultModel &&
                (!config.model.defaultModelProvider ||
                  model.providerKey === config.model.defaultModelProvider),
            ) ?? allModels[0];
          dispatch(setSelectedModel(preferredModel));
        }

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

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh(prev => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

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
          dispatch(setAvailableModels(getEnabledProviderModels(config.providers)));
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

  useEffect(() => {
    if (!isInitialized || !selectedModel?.id) return;
    const config = configService.getConfig();
    if (
      config.model.defaultModel === selectedModel.id &&
      (config.model.defaultModelProvider ?? '') === (selectedModel.providerKey ?? '')
    ) {
      return;
    }
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: selectedModel.id,
        defaultModelProvider: selectedModel.providerKey,
      },
    });
  }, [isInitialized, selectedModel?.id, selectedModel?.providerKey]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions({
      initialTab: options?.initialTab,
      notice: options?.notice,
    });
    setShowSettings(true);
  }, []);

  const handleShowCowork = useCallback(() => {
    setMainView('cowork');
  }, []);

  const requestCoworkNavigation = useCallback(async (): Promise<boolean> => {
    return (await coworkViewRef.current?.requestFilePreviewTransition()) ?? true;
  }, []);

  const handleShowScheduledTasks = useCallback(async () => {
    await runGuardedFilePreviewNavigation(requestCoworkNavigation, () =>
      setMainView('scheduledTasks'),
    );
  }, [requestCoworkNavigation]);

  const handleShowPlugins = useCallback(async () => {
    await runGuardedFilePreviewNavigation(requestCoworkNavigation, () => setMainView('plugins'));
  }, [requestCoworkNavigation]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed(prev => !prev);
  }, []);

  const handleNewChat = useCallback(async (): Promise<boolean> => {
    return runGuardedFilePreviewNavigation(requestCoworkNavigation, () => {
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
    });
  }, [mainView, currentSessionId, requestCoworkNavigation]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
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
    async (requestId: string, result: CoworkInteractionResult) => {
      await coworkService.respondToInteraction(requestId, result);
    },
    [],
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
      dispatch(setAvailableModels(allModels));
    }
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || pendingApprovals.length > 0 || isShortcutInputActive()) return;

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
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleShowSettings, handleNewChat, pendingApprovals.length]);

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
      const message = (e as CustomEvent<string>).detail;
      if (message) showToast(message);
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

  const isStructuredQuestionInteraction =
    pendingInteraction?.interactionKind === CoworkInteractionKind.STRUCTURED_QUESTION;
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
    if (!pendingInteraction) return null;
    if (isStructuredQuestionInteraction) return null;

    return (
      <CoworkInteractionModal
        key={pendingInteraction.requestId}
        interaction={pendingInteraction}
        onRespond={result => handleInteractionResponse(pendingInteraction.requestId, result)}
      />
    );
  }, [pendingInteraction, isStructuredQuestionInteraction, handleInteractionResponse]);

  const activeApproval = pendingApprovals[0] ?? null;
  const isOverlayActive = interactionModal !== null || activeApproval !== null;

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
  const windowsStandaloneTitleBar = isWindows ? (
    <div className="draggable relative h-9 shrink-0 bg-surface-raised">
      <WindowTitleBar isOverlayActive={isOverlayActive} />
    </div>
  ) : null;

  if (!isInitialized) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex items-center justify-center bg-background">
          <div className="flex flex-col items-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-primary-hover flex items-center justify-center shadow-glow-accent animate-pulse">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="w-24 h-1 rounded-full bg-primary/20 overflow-hidden">
              <div className="h-full w-1/2 rounded-full bg-primary animate-shimmer" />
            </div>
            <div className="text-foreground text-xl font-medium">{i18nService.t('loading')}</div>
          </div>
        </div>
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
              developerModeAvailable={developerModeAvailable}
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
      {toastMessage && <Toast message={toastMessage} onClose={() => setToastMessage(null)} />}
      {updateToast && (
        <AppUpdateToast
          availableVersion={updateToast.state.availableVersion}
          installing={updateToast.installing}
          installError={updateToast.installError}
          onInstall={() => void handleInstallAppUpdate()}
          onDismiss={handleDismissAppUpdate}
        />
      )}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {showSettings ? (
          <div className="flex-1 min-w-0 p-1.5">
            <div className="relative h-full min-h-0 overflow-hidden rounded-xl bg-background">
              <Settings
                onClose={handleCloseSettings}
                developerModeAvailable={developerModeAvailable}
                initialTab={settingsOptions.initialTab}
                notice={settingsOptions.notice}
              />
            </div>
          </div>
        ) : (
          <>
            <Sidebar
              onShowSettings={handleShowSettings}
              activeView={mainView}
              onShowCowork={handleShowCowork}
              onShowScheduledTasks={handleShowScheduledTasks}
              onShowPlugins={handleShowPlugins}
              onNewChat={handleNewChat}
              onBeforeCoworkNavigation={requestCoworkNavigation}
              isCollapsed={isSidebarCollapsed}
              onToggleCollapse={handleToggleSidebar}
              developerModeAvailable={developerModeAvailable}
            />
            <div className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
              <div className="relative h-full min-h-0 rounded-xl bg-background overflow-hidden">
                <EngineStartupStatusBar />
                {mainView === 'scheduledTasks' ? (
                  <CronView
                    isSidebarCollapsed={isSidebarCollapsed}
                    onToggleSidebar={handleToggleSidebar}
                    onNewChat={handleNewChat}
                  />
                ) : mainView === 'plugins' ? (
                  <PluginsView
                    isSidebarCollapsed={isSidebarCollapsed}
                    onToggleSidebar={handleToggleSidebar}
                    onNewChat={handleNewChat}
                  />
                ) : (
                  <CoworkView
                    ref={coworkViewRef}
                    onRequestAppSettings={handleShowSettings}
                    isQuestionInputBlocked={isQuestionWindowVisible}
                    isSidebarCollapsed={isSidebarCollapsed}
                    onToggleSidebar={handleToggleSidebar}
                    onNewChat={handleNewChat}
                  />
                )}
              </div>
            </div>
          </>
        )}
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
