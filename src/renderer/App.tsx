import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, store } from './store';
import {
  selectCurrentSessionId,
  selectFirstPendingPermission,
} from './store/selectors/coworkSelectors';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import WindowTitleBar from './components/window/WindowTitleBar';
import { CoworkView } from './components/cowork';
import { ScheduledTasksView } from './components/scheduledTasks';
import CoworkPermissionModal from './components/cowork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/cowork/CoworkQuestionWizard';
import EngineStartupOverlay from './components/cowork/EngineStartupOverlay';
import { configService } from './services/config';
import { apiService } from './services/api';
import { themeService } from './services/theme';
import { coworkService } from './services/cowork';
import { scheduledTaskService } from './services/scheduledTask';
import { defaultConfig, getProviderDisplayName } from './config';
import { setAvailableModels, setSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import type { ApiConfig } from './services/api';
import type { CoworkPermissionResult } from './types/cowork';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from './services/i18n';
import { matchesShortcut } from './services/shortcuts';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  const [mainView, setMainView] = useState<'cowork' | 'scheduledTasks'>('cowork');
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [enterpriseConfig, setEnterpriseConfig] = useState<{
    ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
    disableUpdate?: boolean;
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const hasInitialized = useRef(false);
  const dispatch = useDispatch();
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const pendingPermission = useSelector(selectFirstPendingPermission);
  const isWindows = window.electron.platform === 'win32';

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

        // Load enterprise config if present
        const entConfig = await window.electron.enterprise.getConfig();
        setEnterpriseConfig(entConfig);

        // 初始化主题
        console.info('[App] initializeApp: themeService.initialize');
        themeService.initialize();

        // 初始化语言
        console.info('[App] initializeApp: i18nService.initialize');
        await waitWithTimeout(i18nService.initialize(), 5000, 'i18nService.initialize');

        console.info('[App] initializeApp: configService.getConfig');
        const config = await configService.getConfig();
        const apiConfig: ApiConfig = {
          apiKey: config.api.key,
          baseUrl: config.api.baseUrl,
        };
        apiService.setConfig(apiConfig);

        // 从 providers 配置中加载可用模型列表到 Redux
        const providerModels: {
          id: string;
          name: string;
          provider?: string;
          providerKey?: string;
          supportsImage?: boolean;
          contextLength?: number;
        }[] = [];
        if (config.providers) {
          Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
            if (providerConfig.enabled && providerConfig.models) {
              providerConfig.models.forEach(
                (model: {
                  id: string;
                  name: string;
                  supportsImage?: boolean;
                  contextLength?: number;
                }) => {
                  providerModels.push({
                    id: model.id,
                    name: model.name,
                    provider: getProviderDisplayName(providerName, providerConfig),
                    providerKey: providerName,
                    supportsImage: model.supportsImage ?? false,
                    contextLength: model.contextLength,
                  });
                },
              );
            }
          });
        }
        const fallbackModels = config.model.availableModels.map(model => ({
          id: model.id,
          name: model.name,
          providerKey: undefined,
          supportsImage: model.supportsImage ?? false,
          contextLength: model.contextLength,
        }));
        const resolvedModels = providerModels.length > 0 ? providerModels : fallbackModels;
        if (resolvedModels.length > 0) {
          dispatch(setAvailableModels(resolvedModels));
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
        void waitWithTimeout(scheduledTaskService.init(), 5000, 'scheduledTaskService.init').catch(
          error => {
            console.error('[App] initializeApp: scheduledTaskService.init failed:', error);
          },
        );

        // 加载 agents 列表，不阻塞首屏
        const { agentService } = await import('./services/agent');
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

  // Listen for Copilot token auto-refresh events from the main process
  useEffect(() => {
    const removeListener = window.electron.githubCopilot.onTokenUpdated(({ token, baseUrl }) => {
      console.log('[App] received Copilot token update from main process');
      const currentConfig = configService.getConfig();
      const copilotProvider = currentConfig.providers?.['github-copilot'];
      if (copilotProvider) {
        void configService.updateConfig({
          providers: {
            ...currentConfig.providers,
            'github-copilot': {
              ...copilotProvider,
              apiKey: token,
              ...(baseUrl ? { baseUrl } : {}),
            },
          },
        } as Partial<typeof currentConfig>);
      }
    });
    return removeListener;
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

  const handleShowScheduledTasks = useCallback(() => {
    setMainView('scheduledTasks');
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed(prev => !prev);
  }, []);

  const handleNewChat = useCallback(() => {
    const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
    coworkService.clearSession();
    dispatch(clearSelection());
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('cowork:focus-input', {
          detail: { clear: shouldClearInput },
        }),
      );
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

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

  const handlePermissionResponse = useCallback(
    async (result: CoworkPermissionResult) => {
      if (!pendingPermission) return;
      await coworkService.respondToPermission(pendingPermission.requestId, result);
    },
    [pendingPermission],
  );

  const handleCloseSettings = () => {
    setShowSettings(false);
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    if (config.providers) {
      const allModels: {
        id: string;
        name: string;
        provider?: string;
        providerKey?: string;
        supportsImage?: boolean;
        contextLength?: number;
      }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach(
            (model: {
              id: string;
              name: string;
              supportsImage?: boolean;
              contextLength?: number;
            }) => {
              allModels.push({
                id: model.id,
                name: model.name,
                provider: getProviderDisplayName(providerName, providerConfig),
                providerKey: providerName,
                supportsImage: model.supportsImage ?? false,
                contextLength: model.contextLength,
              });
            },
          );
        }
      });
      if (allModels.length > 0) {
        dispatch(setAvailableModels(allModels));
      }
    }
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isShortcutInputActive()) return;

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
  }, [handleShowSettings, handleNewChat]);

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

  // 根据场景选择使用哪个权限组件
  const permissionModal = useMemo(() => {
    if (!pendingPermission) return null;

    // 检查是否为 AskUserQuestion 且有多个问题 -> 使用向导式组件
    const isQuestionTool = pendingPermission.toolName === 'AskUserQuestion';
    if (isQuestionTool && pendingPermission.toolInput) {
      const rawQuestions = (pendingPermission.toolInput as Record<string, unknown>).questions;
      const hasMultipleQuestions = Array.isArray(rawQuestions) && rawQuestions.length > 1;

      if (hasMultipleQuestions) {
        return (
          <CoworkQuestionWizard
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
          />
        );
      }
    }

    // 其他情况使用原有的权限模态框
    return (
      <CoworkPermissionModal permission={pendingPermission} onRespond={handlePermissionResponse} />
    );
  }, [pendingPermission, handlePermissionResponse]);

  const isOverlayActive = showSettings || pendingPermission !== null;
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
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center bg-background">
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
          {showSettings && (
            <Settings
              onClose={handleCloseSettings}
              initialTab={settingsOptions.initialTab}
              notice={settingsOptions.notice}
              enterpriseConfig={enterpriseConfig}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-surface-raised">
      {toastMessage && <Toast message={toastMessage} onClose={() => setToastMessage(null)} />}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          onShowSettings={handleShowSettings}
          activeView={mainView}
          onShowCowork={handleShowCowork}
          onShowScheduledTasks={handleShowScheduledTasks}
          onNewChat={handleNewChat}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
        />
        <div className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
          <div className="relative h-full min-h-0 rounded-xl bg-background overflow-hidden">
            <EngineStartupOverlay />
            {mainView === 'scheduledTasks' ? (
              <ScheduledTasksView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
              />
            ) : (
              <CoworkView
                onRequestAppSettings={handleShowSettings}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
              />
            )}
          </div>
        </div>
      </div>

      {/* 设置窗口显示在所有主内容之上，但不影响主界面的交互 */}
      {showSettings && (
        <Settings
          onClose={handleCloseSettings}
          initialTab={settingsOptions.initialTab}
          notice={settingsOptions.notice}
          enterpriseConfig={enterpriseConfig}
        />
      )}
      {permissionModal}
    </div>
  );
};

export default App;
