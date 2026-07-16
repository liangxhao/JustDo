import {
  ArrowPathIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  CubeIcon,
  PencilSquareIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { DEFAULT_OPENCLAW_GATEWAY_PORT } from '@shared/openclaw/constants';
import {
  GatewayPortSetErrorCode,
  GatewayPortValidationCode,
  parseGatewayPortInput,
} from '@shared/openclaw/gatewayPort';
import {
  type CustomProxyConfig,
  defaultCustomProxyConfig,
  ProxyMode,
  ProxyProtocol,
} from '@shared/proxy';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';

import {
  type AppConfig,
  defaultConfig,
  getProviderDisplayName,
  getVisibleProviders,
  isBuiltinModelsProvider,
  isCustomProvider,
} from '@/app/config';
import { setAvailableModels } from '@/features/models/modelSlice';
import ModelSettingsTab from '@/features/settings/components/ModelSettingsTab';
import ShortcutsSettings, {
  shortcutLabelMap,
  type ShortcutSettingsValue,
} from '@/features/settings/components/ShortcutsSettings';
import { configService } from '@/services/config';
import { i18nService, LanguageType } from '@/services/i18n';
import { themeService } from '@/services/theme';
import Modal from '@/shared/components/common/Modal';
import ErrorMessage from '@/shared/components/ErrorMessage';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

type TabType = 'general' | 'model' | 'im' | 'shortcuts' | 'help';

const getEnabledSettingsTab = (tab?: TabType): TabType => tab ?? 'general';

export type SettingsOpenOptions = {
  initialTab?: TabType;
  notice?: string;
  noticeI18nKey?: string;
  noticeExtra?: string;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
}

type ProviderType = string;
type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
  providerName: string;
  baseUrl?: string;
  modelLabel?: string;
  modelId?: string;
  log?: string;
  isRunning?: boolean;
  modelResults?: ModelConnectionTestResult[];
};

type ModelConnectionTestResult = {
  success: boolean;
  modelLabel: string;
  modelId: string;
  detail: string;
  log?: string;
  status?: 'pending' | 'testing' | 'success' | 'failed';
};

const providerRequiresApiKey = (provider: ProviderType) => provider !== 'builtin_models';
const isProviderReadOnly = (provider: ProviderType, config?: ProviderConfig): boolean =>
  provider === 'builtin_models' || config?.readonly === true;
const getProviderDefaultBaseUrl = (provider: ProviderType): string | null =>
  defaultConfig.providers?.[provider]?.baseUrl ?? null;
const resolveBaseUrl = (provider: ProviderType, baseUrl: string): string => {
  if (baseUrl.trim()) {
    return baseUrl;
  }
  return getProviderDefaultBaseUrl(provider) || '';
};
const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

const waitForNextPaint = () =>
  new Promise<void>(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });

const hideBuiltinModelUrlFromLog = (log?: string): string | undefined => {
  if (!log) {
    return log;
  }
  return log
    .split('\n')
    .filter(line => !line.startsWith(`${i18nService.t('testRequestUrl')}:`))
    .join('\n');
};

const hideBuiltinModelUrlFromResult = (
  result: ModelConnectionTestResult,
): ModelConnectionTestResult => ({
  ...result,
  log: hideBuiltinModelUrlFromLog(result.log),
});

const stringifyConnectivityLogValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const toConnectivityRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const getConnectivityErrorMessage = (data: unknown): string | null => {
  const record = toConnectivityRecord(data);
  if (!record) {
    return typeof data === 'string' && data.trim() ? data : null;
  }

  const error = toConnectivityRecord(record.error);
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }

  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }

  return null;
};

const isValidConnectivityResponse = (data: unknown): boolean => {
  const record = toConnectivityRecord(data);
  if (!record || record.error) {
    return false;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  return choices.some(choice => {
    const choiceRecord = toConnectivityRecord(choice);
    if (!choiceRecord) {
      return false;
    }

    const message = toConnectivityRecord(choiceRecord.message);
    const delta = toConnectivityRecord(choiceRecord.delta);
    const hasContent =
      (typeof message?.content === 'string' && message.content.length > 0) ||
      (typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0) ||
      (typeof delta?.content === 'string' && delta.content.length > 0) ||
      (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
      (typeof choiceRecord.text === 'string' && choiceRecord.text.length > 0);
    const hasToolCalls =
      Array.isArray(message?.tool_calls) ||
      Array.isArray(delta?.tool_calls) ||
      typeof message?.function_call === 'object';
    const reachedTokenLimit = choiceRecord.finish_reason === 'length';

    return hasContent || hasToolCalls || reachedTokenLimit;
  });
};

const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  const secureSuffix = i18nService.t('modelSuffixSecure');
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map(model => ({
          ...model,
          name: model.name.replace('(Secure)', secureSuffix),
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ]),
  ) as ProvidersConfig;
};

const getDefaultActiveProvider = (): ProviderType => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const firstEnabledProvider = Object.keys(providers).find(
    providerKey => providers[providerKey]?.enabled,
  );
  return firstEnabledProvider ?? 'builtin_models';
};

const getSortedCustomProviderKeys = (providers: ProvidersConfig): string[] =>
  Object.keys(providers)
    .filter(isCustomProvider)
    .sort((a, b) => {
      const aIndex = Number(a.replace('custom_', ''));
      const bIndex = Number(b.replace('custom_', ''));
      const aIsNumber = Number.isFinite(aIndex);
      const bIsNumber = Number.isFinite(bIndex);
      if (aIsNumber && bIsNumber) return aIndex - bIndex;
      if (aIsNumber) return -1;
      if (bIsNumber) return 1;
      return a.localeCompare(b);
    });

const getNextCustomProviderKey = (providers: ProvidersConfig): string => {
  const usedKeys = new Set(Object.keys(providers));
  let index = 0;
  while (usedKeys.has(`custom_${index}`)) {
    index += 1;
  }
  return `custom_${index}`;
};

const Settings: React.FC<SettingsProps> = ({
  onClose,
  initialTab,
  notice,
  noticeI18nKey,
  noticeExtra,
}) => {
  const dispatch = useDispatch();
  // 状态
  const [activeTab, setActiveTab] = useState<TabType>(getEnabledSettingsTab(initialTab));
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [themeId, setThemeId] = useState<string>(themeService.getThemeId());
  const [language, setLanguage] = useState<LanguageType>('zh');
  const [autoLaunch, setAutoLaunchState] = useState(false);
  const [proxyMode, setProxyMode] = useState<ProxyMode>(ProxyMode.DIRECT);
  const [customProxy, setCustomProxy] = useState<CustomProxyConfig>(defaultCustomProxyConfig);
  const [developerMode, setDeveloperMode] = useState(false);
  const [isUpdatingAutoLaunch, setIsUpdatingAutoLaunch] = useState(false);
  const [preventSleep, setPreventSleepState] = useState(false);
  const [isUpdatingPreventSleep, setIsUpdatingPreventSleep] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buildNoticeMessage = (): string | null => {
    if (noticeI18nKey) {
      const base = i18nService.t(noticeI18nKey);
      return noticeExtra ? `${base} (${noticeExtra})` : base;
    }
    return notice ?? null;
  };

  const [noticeMessage, setNoticeMessage] = useState<string | null>(() => buildNoticeMessage());
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult | null>(null);
  const [isTestResultModalOpen, setIsTestResultModalOpen] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<ProviderType | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [appVersion, setAppVersion] = useState<string>('unknown');
  const [openclawVersion, setOpenclawVersion] = useState<string>('unknown');
  const initialThemeRef = useRef<'light' | 'dark' | 'system'>(themeService.getTheme());
  const initialThemeIdRef = useRef<string>(themeService.getThemeId());
  const initialLanguageRef = useRef<LanguageType>(i18nService.getLanguage());
  const didSaveRef = useRef(false);

  useEffect(() => {
    if (activeTab === 'help') {
      window.electron.appInfo.getVersion().then(setAppVersion);
      window.electron.appInfo.getOpenclawVersion().then(setOpenclawVersion);
    }
  }, [activeTab]);

  // Add state for active provider
  const [activeProvider, setActiveProvider] = useState<ProviderType>(getDefaultActiveProvider());
  // Add state for providers configuration
  const [providers, setProviders] = useState<ProvidersConfig>(() => getDefaultProviders());
  const [isRefreshingBuiltinModels, setIsRefreshingBuiltinModels] = useState(false);

  // 创建引用来确保内容区域的滚动
  const contentRef = useRef<HTMLDivElement>(null);
  const startHorizontalResize = useCallback(
    (
      event: React.MouseEvent<HTMLDivElement>,
      currentWidth: number,
      setWidth: React.Dispatch<React.SetStateAction<number>>,
      minWidth: number,
      maxWidth: number,
    ) => {
      const startX = event.clientX;
      event.preventDefault();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        setWidth(Math.min(maxWidth, Math.max(minWidth, currentWidth + moveEvent.clientX - startX)));
      };
      const handleMouseUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [],
  );

  // 快捷键设置
  const [shortcuts, setShortcuts] = useState<ShortcutSettingsValue>({
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
    sendMessage: defaultConfig.shortcuts!.sendMessage,
  });

  // State for model editing
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [isEditingModel, setIsEditingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newModelName, setNewModelName] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newModelSupportsImage, setNewModelSupportsImage] = useState(false);
  const [newModelContextLength, setNewModelContextLength] = useState<number | undefined>(undefined);
  const [newModelMaxTokens, setNewModelMaxTokens] = useState<number | undefined>(undefined);
  const [modelFormError, setModelFormError] = useState<string | null>(null);

  // State for displayName validation
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);

  // Drag to reposition state
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 });
  const [modalWidth, setModalWidth] = useState(() => Math.min(1100, window.innerWidth - 48));
  const [isDragging, setIsDragging] = useState(false);
  const [isResizingModal, setIsResizingModal] = useState(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, modalX: 0, modalY: 0 });

  const handleModalResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, edge: 'left' | 'right') => {
      const startX = event.clientX;
      const startWidth = modalWidth;
      const startPositionX = modalPosition.x;
      const maxWidth = Math.max(720, window.innerWidth - 32);
      event.preventDefault();
      event.stopPropagation();
      setIsResizingModal(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const requestedWidth = edge === 'right' ? startWidth + deltaX : startWidth - deltaX;
        const nextWidth = Math.min(maxWidth, Math.max(720, requestedWidth));
        const widthDelta = nextWidth - startWidth;

        setModalWidth(nextWidth);
        setModalPosition(position => ({
          ...position,
          x: startPositionX + (edge === 'right' ? widthDelta / 2 : -widthDelta / 2),
        }));
      };
      const handleMouseUp = () => {
        setIsResizingModal(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [modalPosition.x, modalWidth],
  );

  // Handle drag start on header
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        modalX: modalPosition.x,
        modalY: modalPosition.y,
      };
    },
    [modalPosition],
  );

  // Handle mouse move and mouse up for dragging
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartRef.current.mouseX;
      const deltaY = e.clientY - dragStartRef.current.mouseY;
      setModalPosition({
        x: dragStartRef.current.modalX + deltaX,
        y: dragStartRef.current.modalY + deltaY,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);
  const [openClawGatewayPort, setOpenClawGatewayPort] = useState<number>(
    DEFAULT_OPENCLAW_GATEWAY_PORT,
  );
  const [openClawGatewayPortEditing, setOpenClawGatewayPortEditing] = useState<boolean>(false);
  const [openClawGatewayPortInput, setOpenClawGatewayPortInput] = useState<string>(
    String(DEFAULT_OPENCLAW_GATEWAY_PORT),
  );
  const [openClawGatewayPortSaving, setOpenClawGatewayPortSaving] = useState<boolean>(false);
  const [openClawGatewayPortError, setOpenClawGatewayPortError] = useState<string | null>(null);
  const [openClawGatewayPortRestartRequired, setOpenClawGatewayPortRestartRequired] =
    useState<boolean>(false);
  const [isRestartingOpenClawGateway, setIsRestartingOpenClawGateway] = useState<boolean>(false);
  const openClawGatewayPortInputRef = useRef<HTMLInputElement>(null);

  // Load OpenClaw gateway port
  useEffect(() => {
    window.electron.openclaw.engine
      .getPort()
      .then(result => {
        if (result.success && result.port) {
          setOpenClawGatewayPort(result.port);
          setOpenClawGatewayPortInput(String(result.port));
          setOpenClawGatewayPortRestartRequired(Boolean(result.requiresRestart));
          return;
        }
        setOpenClawGatewayPortError(i18nService.t('openclawGatewayPortLoadFailed'));
      })
      .catch(() => setOpenClawGatewayPortError(i18nService.t('openclawGatewayPortLoadFailed')));
  }, []);

  useEffect(() => {
    if (!openClawGatewayPortEditing) {
      return;
    }
    openClawGatewayPortInputRef.current?.focus();
    openClawGatewayPortInputRef.current?.select();
  }, [openClawGatewayPortEditing]);

  const openClawGatewayPortValidation = useMemo(
    () => parseGatewayPortInput(openClawGatewayPortInput),
    [openClawGatewayPortInput],
  );

  const openClawGatewayPortValidationError = (() => {
    if (openClawGatewayPortValidation.valid) return null;
    const keyByCode = {
      [GatewayPortValidationCode.Required]: 'openclawGatewayPortRequired',
      [GatewayPortValidationCode.Integer]: 'openclawGatewayPortInteger',
      [GatewayPortValidationCode.Privileged]: 'openclawGatewayPortPrivileged',
      [GatewayPortValidationCode.OutOfRange]: 'openclawGatewayPortOutOfRange',
    } as const;
    return i18nService.t(keyByCode[openClawGatewayPortValidation.code]);
  })();

  const cancelOpenClawGatewayPortEditing = () => {
    setOpenClawGatewayPortEditing(false);
    setOpenClawGatewayPortInput(String(openClawGatewayPort));
    setOpenClawGatewayPortError(null);
  };

  const handleSaveOpenClawGatewayPort = async () => {
    if (!openClawGatewayPortValidation.valid) {
      return;
    }
    const { port } = openClawGatewayPortValidation;
    setOpenClawGatewayPortSaving(true);
    setOpenClawGatewayPortError(null);
    try {
      const result = await window.electron.openclaw.engine.setPort(port);
      if (result.success) {
        setOpenClawGatewayPort(port);
        setOpenClawGatewayPortInput(String(port));
        setOpenClawGatewayPortEditing(false);
        setOpenClawGatewayPortRestartRequired(Boolean(result.requiresRestart));
        setNoticeMessage(
          i18nService.t(
            result.requiresRestart
              ? 'openclawGatewayPortSavedRestartRequired'
              : 'openclawGatewayPortSaved',
          ),
        );
        return;
      }
      const errorKey =
        result.errorCode === GatewayPortSetErrorCode.Unavailable
          ? 'openclawGatewayPortUnavailable'
          : result.errorCode === GatewayPortSetErrorCode.Busy
            ? 'openclawGatewayPortBusy'
            : result.errorCode === GatewayPortSetErrorCode.Invalid
              ? 'openclawGatewayPortInvalid'
              : 'openclawGatewayPortSaveFailed';
      setOpenClawGatewayPortError(i18nService.t(errorKey));
    } catch {
      setOpenClawGatewayPortError(i18nService.t('openclawGatewayPortSaveFailed'));
    } finally {
      setOpenClawGatewayPortSaving(false);
    }
  };

  const handleRestartOpenClawGateway = async () => {
    if (isRestartingOpenClawGateway) {
      return;
    }
    setIsRestartingOpenClawGateway(true);
    setError(null);
    try {
      const result = await window.electron.openclaw.engine.restartGateway();
      if (!result.success) {
        setError(result.error || i18nService.t('openclawGatewayRestartFailed'));
        return;
      }
      if (result.status) {
        setNoticeMessage(i18nService.t('openclawGatewayRestarted'));
        const portResult = await window.electron.openclaw.engine.getPort();
        if (portResult.success && portResult.port) {
          setOpenClawGatewayPort(portResult.port);
          setOpenClawGatewayPortInput(String(portResult.port));
          setOpenClawGatewayPortRestartRequired(Boolean(portResult.requiresRestart));
        } else {
          setOpenClawGatewayPortError(i18nService.t('openclawGatewayPortLoadFailed'));
        }
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : i18nService.t('openclawGatewayRestartFailed'),
      );
    } finally {
      setIsRestartingOpenClawGateway(false);
    }
  };

  useEffect(() => {
    try {
      const config = configService.getConfig();

      // Set general settings
      initialThemeRef.current = config.theme;
      initialLanguageRef.current = config.language;
      setTheme(config.theme);
      setLanguage(config.language);
      setProxyMode(
        config.proxy?.mode === ProxyMode.CUSTOM
          ? ProxyMode.CUSTOM
          : config.proxy?.mode === ProxyMode.SYSTEM || config.useSystemProxy
            ? ProxyMode.SYSTEM
            : ProxyMode.DIRECT,
      );
      setCustomProxy({
        ...defaultCustomProxyConfig,
        ...(config.proxy?.custom ?? {}),
      });
      setDeveloperMode(config.developerMode ?? false);

      // Load auto-launch setting
      window.electron.autoLaunch
        .get()
        .then(({ enabled }) => {
          setAutoLaunchState(enabled);
        })
        .catch(err => {
          console.error('Failed to load auto-launch setting:', err);
        });

      // Load prevent-sleep setting
      window.electron.preventSleep
        .get()
        .then(({ enabled }) => {
          setPreventSleepState(enabled);
        })
        .catch(err => {
          console.error('Failed to load prevent-sleep setting:', err);
        });

      // Load provider-specific configurations if available
      // 合并已保存的配置和默认配置，确保新添加的 provider 能被显示
      if (config.providers) {
        setProviders(prev => {
          const merged = {
            ...prev,
            ...config.providers, // 覆盖已保存的配置
          };

          // After merging, find the first enabled provider to set as activeProvider
          // This ensures we don't use stale activeProvider from old config.api.baseUrl
          const firstEnabledProvider = Object.keys(merged).find(
            providerKey => merged[providerKey]?.enabled,
          );
          if (firstEnabledProvider) {
            setActiveProvider(firstEnabledProvider);
          }

          return Object.fromEntries(
            Object.entries(merged).map(([providerKey, providerConfig]) => {
              const models = providerConfig.models?.map(model => {
                return {
                  ...model,
                  supportsImage: model.supportsImage ?? false,
                };
              });
              return [
                providerKey,
                {
                  ...providerConfig,
                  apiFormat: 'openai',
                  models,
                },
              ];
            }),
          ) as ProvidersConfig;
        });
      }

      // 加载快捷键设置
      if (config.shortcuts) {
        setShortcuts(prev => ({
          ...prev,
          ...config.shortcuts,
        }));
      }
    } catch {
      setError('Failed to load settings');
    }
  }, []);

  useEffect(() => {
    return () => {
      if (didSaveRef.current) {
        return;
      }
      themeService.restoreTheme(initialThemeIdRef.current, initialThemeRef.current);
      i18nService.setLanguage(initialLanguageRef.current, { persist: false });
    };
  }, []);

  // 监听标签页切换，确保内容区域滚动到顶部
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  useEffect(() => {
    setNoticeMessage(buildNoticeMessage());
  }, [notice, noticeI18nKey, noticeExtra]);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(getEnabledSettingsTab(initialTab));
    }
  }, [initialTab]);

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
      // Re-translate notice message on language change
      if (noticeI18nKey) {
        const base = i18nService.t(noticeI18nKey);
        setNoticeMessage(noticeExtra ? `${base} (${noticeExtra})` : base);
      }
    });
    return unsubscribe;
  }, [noticeI18nKey, noticeExtra]);

  // Compute visible providers based on language, including active custom_N entries
  const visibleProviders = useMemo(() => {
    const visibleKeys = getVisibleProviders(language);
    const filtered: Partial<ProvidersConfig> = {};
    for (const key of visibleKeys) {
      if (providers[key as keyof ProvidersConfig]) {
        filtered[key as keyof ProvidersConfig] = providers[key as keyof ProvidersConfig];
      }
    }
    // Append custom providers that exist in state, sorted by numeric suffix
    for (const key of getSortedCustomProviderKeys(providers)) {
      if (providers[key]) {
        filtered[key] = providers[key];
      }
    }
    return filtered as ProvidersConfig;
  }, [language, providers]);

  // Ensure activeProvider is always in visibleProviders when language changes
  useEffect(() => {
    const visibleKeys = Object.keys(visibleProviders) as ProviderType[];
    if (visibleKeys.length > 0 && !visibleKeys.includes(activeProvider)) {
      // If current activeProvider is not visible, switch to first visible provider
      const firstEnabledVisible = visibleKeys.find(key => visibleProviders[key]?.enabled);
      setActiveProvider(firstEnabledVisible ?? visibleKeys[0]);
    }
  }, [visibleProviders, activeProvider]);

  // Handle adding a new custom provider
  const handleAddCustomProvider = () => {
    const newKey = getNextCustomProviderKey(providers);
    setProviders(prev => ({
      ...prev,
      [newKey]: {
        enabled: false,
        apiKey: '',
        baseUrl: '',
        apiFormat: 'openai' as const,
        models: [],
        displayName: undefined,
      },
    }));
    setActiveProvider(newKey);
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleRefreshBuiltinModels = async () => {
    setError(null);
    setIsRefreshingBuiltinModels(true);
    try {
      const result = await window.electron.builtinModels.refresh();
      if (!result.success) {
        setError(result.error || i18nService.t('connectionFailed'));
      } else {
        const freshConfig = await window.electron.store.get('app_config');
        if (freshConfig && typeof freshConfig === 'object') {
          await configService.updateConfig(freshConfig as Partial<AppConfig>);
        }
      }
    } catch (error) {
      console.error('[Settings] Failed to refresh builtin models:', error);
      setError(error instanceof Error ? error.message : i18nService.t('connectionFailed'));
    } finally {
      setIsRefreshingBuiltinModels(false);
    }
  };

  // Handle deleting a custom provider
  const confirmDeleteCustomProvider = () => {
    const key = pendingDeleteProvider;
    if (!key) return;
    setPendingDeleteProvider(null);
    setProviders(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    // Persist the deletion immediately so it survives window close
    const currentConfig = configService.getConfig();
    const updatedProviders = { ...currentConfig.providers };
    delete updatedProviders[key];
    configService.updateConfig({ providers: updatedProviders as AppConfig['providers'] });
    // If the deleted provider was active, switch to first visible
    if (activeProvider === key) {
      const visibleKeys = Object.keys(visibleProviders).filter(k => k !== key) as ProviderType[];
      const firstEnabled = visibleKeys.find(k => visibleProviders[k]?.enabled);
      setActiveProvider(firstEnabled ?? visibleKeys[0] ?? 'builtin_models');
    }
  };

  // Handle provider change
  const handleProviderChange = (provider: ProviderType) => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
    setActiveProvider(provider);
    // 切换 provider 时清除测试结果
    setIsTestResultModalOpen(false);
    setTestResult(null);
  };

  // Handle provider configuration change
  const handleProviderConfigChange = (provider: ProviderType, field: string, value: string) => {
    if (isProviderReadOnly(provider, providers[provider])) {
      return;
    }

    setProviders(prev => {
      if (field === 'apiFormat') {
        return {
          ...prev,
          [provider]: {
            ...prev[provider],
            apiFormat: 'openai',
          },
        };
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          [field]: value,
        },
      };
    });
  };

  /**
   * Return file content directly, showing the actual content to users.
   * Previously hid OpenClaw default templates, but users expect to see file content.
   */

  // Toggle provider enabled status
  const toggleProviderEnabled = (provider: ProviderType) => {
    const providerConfig = providers[provider];
    if (isProviderReadOnly(provider, providerConfig)) {
      return;
    }

    const isEnabling = !providerConfig.enabled;
    const missingApiKey = providerRequiresApiKey(provider) && !providerConfig.apiKey.trim();

    if (isEnabling && missingApiKey) {
      return;
    }

    setProviders(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        enabled: !prev[provider].enabled,
      },
    }));
  };

  const enableProvider = (provider: ProviderType) => {
    setProviders(prev => {
      if (prev[provider].enabled) {
        return prev;
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          enabled: true,
        },
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const normalizedProviders = Object.fromEntries(
        Object.entries(providers).map(([providerKey, providerConfig]) => {
          return [
            providerKey,
            {
              ...providerConfig,
              apiFormat: 'openai',
              baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl),
            },
          ];
        }),
      ) as ProvidersConfig;

      // Find the first enabled provider to use as the primary API
      const firstEnabledProvider = Object.entries(normalizedProviders).find(
        ([_, config]) => config.enabled,
      );

      const primaryProvider = firstEnabledProvider
        ? firstEnabledProvider[1]
        : normalizedProviders[activeProvider];
      const normalizedProxy = {
        mode: proxyMode,
        custom: {
          protocol: customProxy.protocol,
          host: customProxy.host.trim(),
          port: customProxy.port.trim(),
          username: customProxy.username?.trim() ?? '',
          password: customProxy.password ?? '',
        },
      };

      await configService.updateConfig({
        api: {
          key: primaryProvider.apiKey,
          baseUrl: primaryProvider.baseUrl,
        },
        providers: normalizedProviders, // Save all providers configuration
        theme,
        language,
        useSystemProxy: proxyMode === ProxyMode.SYSTEM,
        proxy: normalizedProxy,
        developerMode,
        shortcuts,
      });

      // 应用主题
      themeService.setTheme(theme);

      // 应用语言
      i18nService.setLanguage(language, { persist: false });

      // 更新 Redux store 中的可用模型列表
      const allModels: {
        id: string;
        name: string;
        provider?: string;
        providerKey?: string;
        supportsImage?: boolean;
        contextLength?: number;
      }[] = [];
      Object.entries(normalizedProviders).forEach(([providerName, config]) => {
        if (config.enabled && config.models) {
          config.models.forEach(model => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: getProviderDisplayName(providerName, config),
              providerKey: providerName,
              supportsImage: model.supportsImage ?? false,
              contextLength: model.contextLength,
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));

      didSaveRef.current = true;
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  // 标签页切换处理
  const handleTabChange = (tab: TabType) => {
    if (tab !== 'model') {
      setIsAddingModel(false);
      setIsEditingModel(false);
      setEditingModelId(null);
      setNewModelName('');
      setNewModelId('');
      setNewModelSupportsImage(false);
      setNewModelContextLength(undefined);
      setModelFormError(null);
    }
    setActiveTab(tab);
  };

  // 快捷键更新处理
  const handleShortcutChange = (key: keyof ShortcutSettingsValue, value: string) => {
    // Check for conflicts with other shortcuts
    const conflictKey = Object.keys(shortcuts).find(
      k => k !== key && shortcuts[k as keyof typeof shortcuts] === value,
    );
    if (conflictKey) {
      const conflictLabel = i18nService.t(
        shortcutLabelMap[conflictKey as keyof ShortcutSettingsValue] ?? conflictKey,
      );
      setNoticeMessage(
        i18nService.t('shortcutConflict').replace('{0}', value).replace('{1}', conflictLabel),
      );
      return;
    }
    setShortcuts(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  // 阻止点击设置窗口时事件传播到背景
  const handleSettingsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Handlers for model operations
  const handleAddModel = () => {
    if (isProviderReadOnly(activeProvider, providers[activeProvider])) {
      return;
    }

    setIsAddingModel(true);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setNewModelContextLength(undefined);
    setNewModelMaxTokens(undefined);
    setModelFormError(null);
  };

  const handleEditModel = (
    modelId: string,
    modelName: string,
    supportsImage?: boolean,
    contextLength?: number,
    maxTokens?: number,
  ) => {
    if (isProviderReadOnly(activeProvider, providers[activeProvider])) {
      return;
    }

    setIsAddingModel(false);
    setIsEditingModel(true);
    setEditingModelId(modelId);
    setNewModelName(modelName);
    setNewModelId(modelId);
    setNewModelSupportsImage(!!supportsImage);
    setNewModelContextLength(contextLength);
    setNewModelMaxTokens(maxTokens);
    setModelFormError(null);
  };

  const handleDeleteModel = (modelId: string) => {
    if (isProviderReadOnly(activeProvider, providers[activeProvider])) {
      return;
    }
    if (!providers[activeProvider].models) return;

    const updatedModels = providers[activeProvider].models.filter(model => model.id !== modelId);

    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels,
      },
    }));
  };

  const handleSaveNewModel = () => {
    const modelId = newModelId.trim();
    const modelName = newModelName.trim();
    if (!modelName || !modelId) {
      setModelFormError(i18nService.t('modelNameAndIdRequired'));
      return;
    }

    const currentModels = providers[activeProvider].models ?? [];
    const duplicateModel = currentModels.find(
      model => model.id === modelId && (!isEditingModel || model.id !== editingModelId),
    );
    if (duplicateModel) {
      setModelFormError(i18nService.t('modelIdExists'));
      return;
    }

    // Validate contextLength > maxTokens
    if (
      newModelContextLength !== undefined &&
      newModelMaxTokens !== undefined &&
      newModelContextLength <= newModelMaxTokens
    ) {
      setModelFormError('Context length must be greater than max tokens');
      return;
    }

    const nextModel = {
      id: modelId,
      name: modelName,
      supportsImage: newModelSupportsImage,
      ...(newModelContextLength !== undefined ? { contextLength: newModelContextLength } : {}),
      ...(newModelMaxTokens !== undefined ? { maxTokens: newModelMaxTokens } : {}),
    };
    const updatedModels =
      isEditingModel && editingModelId
        ? currentModels.map(model => (model.id === editingModelId ? nextModel : model))
        : [...currentModels, nextModel];

    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels,
      },
    }));

    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setNewModelContextLength(undefined);
    setNewModelMaxTokens(undefined);
    setModelFormError(null);
  };

  const handleCancelModelEdit = () => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setNewModelContextLength(undefined);
    setNewModelMaxTokens(undefined);
    setModelFormError(null);
  };

  const handleModelDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelModelEdit();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveNewModel();
    }
  };

  const showTestResultModal = (
    result: Omit<ProviderConnectionTestResult, 'provider' | 'providerName'>,
    provider: ProviderType,
  ) => {
    const providerConfig = providers[provider];
    const shouldHideUrl = isBuiltinModelsProvider(provider);
    setTestResult({
      ...result,
      baseUrl: shouldHideUrl ? undefined : result.baseUrl,
      log: shouldHideUrl ? hideBuiltinModelUrlFromLog(result.log) : result.log,
      modelResults: shouldHideUrl
        ? result.modelResults?.map(hideBuiltinModelUrlFromResult)
        : result.modelResults,
      provider,
      providerName: getProviderDisplayName(provider, providerConfig),
    });
    setIsTestResultModalOpen(true);
  };

  const handleProxyModeChange = (mode: ProxyMode) => {
    setProxyMode(mode);
  };

  const handleCustomProxyChange = (key: keyof CustomProxyConfig, value: string) => {
    setCustomProxy(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const updateConnectionTestModelResult = (
    modelId: string,
    nextResult: ModelConnectionTestResult,
  ) => {
    setTestResult(current => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        modelResults: current.modelResults?.map(result =>
          result.modelId === modelId
            ? current.provider === 'builtin_models'
              ? hideBuiltinModelUrlFromResult(nextResult)
              : nextResult
            : result,
        ),
      };
    });
  };

  // 测试 API 连接
  const handleTestConnection = async () => {
    const testingProvider = activeProvider;
    const providerConfig = providers[testingProvider];
    setIsTesting(true);
    setTestResult(null);

    // Check if provider has valid authentication
    if (providerRequiresApiKey(testingProvider) && !providerConfig.apiKey) {
      setIsTesting(false);
      return;
    }

    const originalModels = providerConfig.models ?? [];
    if (originalModels.length === 0) {
      showTestResultModal(
        { success: false, message: i18nService.t('noModelsConfigured') },
        testingProvider,
      );
      setIsTesting(false);
      return;
    }

    const modelsToTest = originalModels.map(model => ({ ...model }));

    try {
      const effectiveBaseUrl = resolveBaseUrl(testingProvider, providerConfig.baseUrl);
      const normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
      const effectiveApiKey = providerConfig.apiKey;
      const openaiUrl = `${normalizedBaseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (effectiveApiKey) {
        headers.Authorization = `Bearer ${effectiveApiKey}`;
      }

      showTestResultModal(
        {
          success: false,
          isRunning: true,
          message: i18nService.t('testing'),
          baseUrl: normalizedBaseUrl,
          modelResults: modelsToTest.map(model => ({
            success: false,
            status: 'pending',
            modelLabel: model.name?.trim() || model.id,
            modelId: model.id,
            detail: i18nService.t('connectionTestPending'),
          })),
        },
        testingProvider,
      );

      const results: ModelConnectionTestResult[] = [];
      for (const model of modelsToTest) {
        const modelLabel = model.name?.trim() || model.id;
        updateConnectionTestModelResult(model.id, {
          success: false,
          status: 'testing',
          modelLabel,
          modelId: model.id,
          detail: i18nService.t('connectionTestRunning'),
        });
        await waitForNextPaint();

        const requestBody: Record<string, unknown> = {
          model: model.id,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
        };

        try {
          const response = await window.electron.api.fetch({
            url: openaiUrl,
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
          });
          const data = response.data || {};
          if (response.ok && isValidConnectivityResponse(data)) {
            const nextResult: ModelConnectionTestResult = {
              success: true,
              status: 'success',
              modelLabel,
              modelId: model.id,
              detail: i18nService.t('connectionSuccess'),
            };
            results.push(nextResult);
            updateConnectionTestModelResult(model.id, nextResult);
            continue;
          }

          const errorMessage =
            getConnectivityErrorMessage(data) ||
            (response.ok
              ? i18nService.t('connectionInvalidResponse')
              : `${i18nService.t('connectionFailed')}: ${response.status}`);
          const recovered =
            !response.ok &&
            typeof errorMessage === 'string' &&
            errorMessage.toLowerCase().includes('model output limit was reached');

          const nextResult: ModelConnectionTestResult = {
            success: recovered,
            status: recovered ? 'success' : 'failed',
            modelLabel,
            modelId: model.id,
            detail: recovered ? i18nService.t('connectionSuccess') : errorMessage,
            log: [
              `${i18nService.t('testRequestUrl')}: ${openaiUrl}`,
              `${i18nService.t('testModel')}: ${modelLabel} (${model.id})`,
              `${i18nService.t('testStatus')}: ${response.status}`,
              `${i18nService.t('testResponse')}: ${stringifyConnectivityLogValue(data)}`,
            ].join('\n'),
          };
          results.push(nextResult);
          updateConnectionTestModelResult(model.id, nextResult);
        } catch (err) {
          const nextResult: ModelConnectionTestResult = {
            success: false,
            status: 'failed',
            modelLabel,
            modelId: model.id,
            detail: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
            log: [
              `${i18nService.t('testRequestUrl')}: ${openaiUrl}`,
              `${i18nService.t('testModel')}: ${modelLabel} (${model.id})`,
              `${i18nService.t('testError')}: ${
                err instanceof Error ? err.stack || err.message : stringifyConnectivityLogValue(err)
              }`,
            ].join('\n'),
          };
          results.push(nextResult);
          updateConnectionTestModelResult(model.id, nextResult);
        }
      }

      const passedCount = results.filter(result => result.success).length;
      const allPassed = passedCount === results.length;
      if (allPassed) {
        enableProvider(testingProvider);
      }

      showTestResultModal(
        {
          success: allPassed,
          message: `${i18nService
            .t('connectionTestSummary')
            .replace('{passed}', String(passedCount))
            .replace(
              '{total}',
              String(results.length),
            )}${allPassed ? `\n${i18nService.t('connectionSuccess')}` : ''}`,
          baseUrl: normalizedBaseUrl,
          isRunning: false,
          modelResults: results,
          log: results
            .map(result =>
              [
                `${result.success ? 'PASS' : 'FAIL'} ${result.modelLabel} (${result.modelId})`,
                result.detail,
                result.log ? result.log : null,
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n\n'),
        },
        testingProvider,
      );
    } catch (err) {
      const effectiveBaseUrl = resolveBaseUrl(testingProvider, providerConfig.baseUrl).replace(
        /\/+$/,
        '',
      );
      showTestResultModal(
        {
          success: false,
          message: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
          baseUrl: effectiveBaseUrl,
          modelLabel: modelsToTest[0]?.name?.trim() || modelsToTest[0]?.id,
          modelId: modelsToTest[0]?.id,
          log: [
            `${i18nService.t('testRequestUrl')}: ${effectiveBaseUrl}/chat/completions`,
            `${i18nService.t('testModel')}: ${modelsToTest[0]?.name?.trim() || modelsToTest[0]?.id} (${modelsToTest[0]?.id})`,
            `${i18nService.t('testError')}: ${
              err instanceof Error ? err.stack || err.message : stringifyConnectivityLogValue(err)
            }`,
          ].join('\n'),
        },
        testingProvider,
      );
    } finally {
      setIsTesting(false);
    }
  };

  // 渲染标签页
  const sidebarTabs: { key: TabType; label: string; icon: React.ReactNode }[] = [
    {
      key: 'general',
      label: i18nService.t('general'),
      icon: <Cog6ToothIcon className="h-5 w-5" />,
    },
    {
      key: 'model',
      label: i18nService.t('model'),
      icon: <CubeIcon className="h-5 w-5" />,
    },
    {
      key: 'im',
      label: i18nService.t('imBot'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-5 w-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      ),
    },
    {
      key: 'shortcuts',
      label: i18nService.t('shortcuts'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-5 w-5"
        >
          <rect x="2" y="4" width="20" height="14" rx="2" />
          <line x1="6" y1="8" x2="8" y2="8" />
          <line x1="10" y1="8" x2="12" y2="8" />
          <line x1="14" y1="8" x2="16" y2="8" />
          <line x1="6" y1="12" x2="8" y2="12" />
          <line x1="10" y1="12" x2="14" y2="12" />
          <line x1="16" y1="12" x2="18" y2="12" />
          <line x1="8" y1="15.5" x2="16" y2="15.5" />
        </svg>
      ),
    },
    {
      key: 'help',
      label: i18nService.t('help'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-5 w-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z"
          />
        </svg>
      ),
    },
  ];

  const activeTabLabel = sidebarTabs.find(t => t.key === activeTab)?.label ?? '';

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return (
          <div className="space-y-8">
            {/* Language Section */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-foreground">{i18nService.t('language')}</h4>
              <div className="w-[140px] shrink-0">
                <ThemedSelect
                  id="language"
                  value={language}
                  onChange={value => {
                    const nextLanguage = value as LanguageType;
                    setLanguage(nextLanguage);
                    i18nService.setLanguage(nextLanguage, { persist: false });
                  }}
                  options={[
                    { value: 'zh', label: i18nService.t('chinese') },
                    { value: 'en', label: i18nService.t('english') },
                  ]}
                />
              </div>
            </div>

            {/* Auto-launch Section */}
            <div>
              <h4 className="text-sm font-medium text-foreground mb-3">
                {i18nService.t('autoLaunch')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-secondary">
                  {i18nService.t('autoLaunchDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoLaunch}
                  onClick={async () => {
                    if (isUpdatingAutoLaunch) return;
                    const next = !autoLaunch;
                    setIsUpdatingAutoLaunch(true);
                    try {
                      const result = await window.electron.autoLaunch.set(next);
                      if (result.success) {
                        setAutoLaunchState(next);
                      } else {
                        setError(result.error || 'Failed to update auto-launch setting');
                      }
                    } catch (err) {
                      console.error('Failed to set auto-launch:', err);
                      setError('Failed to update auto-launch setting');
                    } finally {
                      setIsUpdatingAutoLaunch(false);
                    }
                  }}
                  disabled={isUpdatingAutoLaunch}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    isUpdatingAutoLaunch ? 'opacity-50 cursor-not-allowed' : ''
                  } ${autoLaunch ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoLaunch ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* Prevent Sleep Section */}
            <div>
              <h4 className="text-sm font-medium text-foreground mb-3">
                {i18nService.t('preventSleep')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-secondary">
                  {i18nService.t('preventSleepDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={preventSleep}
                  onClick={async () => {
                    if (isUpdatingPreventSleep) return;
                    const next = !preventSleep;
                    setIsUpdatingPreventSleep(true);
                    try {
                      const result = await window.electron.preventSleep.set(next);
                      if (result.success) {
                        setPreventSleepState(next);
                      } else {
                        setError(result.error || 'Failed to update prevent-sleep setting');
                      }
                    } catch (err) {
                      console.error('Failed to set prevent-sleep:', err);
                      setError('Failed to update prevent-sleep setting');
                    } finally {
                      setIsUpdatingPreventSleep(false);
                    }
                  }}
                  disabled={isUpdatingPreventSleep}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    isUpdatingPreventSleep ? 'opacity-50 cursor-not-allowed' : ''
                  } ${preventSleep ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      preventSleep ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* Developer Mode Section */}
            <div>
              <h4 className="text-sm font-medium text-foreground mb-3">
                {i18nService.t('developerMode')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-secondary">
                  {i18nService.t('developerModeDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={developerMode}
                  onClick={() => {
                    setDeveloperMode(prev => !prev);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    developerMode ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      developerMode ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {developerMode && (
              <>
                {/* Proxy Settings Section */}
                <div className="space-y-4 rounded-xl border px-4 py-4 border-border">
                  <h4 className="text-sm font-medium text-foreground mb-3">
                    {i18nService.t('proxySettings')}
                  </h4>
                  <div className="space-y-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="radio"
                        name="proxyMode"
                        value={ProxyMode.DIRECT}
                        checked={proxyMode === ProxyMode.DIRECT}
                        onChange={() => handleProxyModeChange(ProxyMode.DIRECT)}
                        className="mt-0.5 h-4 w-4 text-primary focus:ring-primary bg-surface border-border"
                      />
                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          {i18nService.t('noProxy')}
                        </span>
                        <span className="block text-xs text-secondary mt-1">
                          {i18nService.t('noProxyDescription')}
                        </span>
                      </span>
                    </label>

                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="radio"
                        name="proxyMode"
                        value={ProxyMode.SYSTEM}
                        checked={proxyMode === ProxyMode.SYSTEM}
                        onChange={() => handleProxyModeChange(ProxyMode.SYSTEM)}
                        className="mt-0.5 h-4 w-4 text-primary focus:ring-primary bg-surface border-border"
                      />
                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          {i18nService.t('useSystemProxy')}
                        </span>
                        <span className="block text-xs text-secondary mt-1">
                          {i18nService.t('useSystemProxyDescription')}
                        </span>
                      </span>
                    </label>

                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="radio"
                        name="proxyMode"
                        value={ProxyMode.CUSTOM}
                        checked={proxyMode === ProxyMode.CUSTOM}
                        onChange={() => handleProxyModeChange(ProxyMode.CUSTOM)}
                        className="mt-0.5 h-4 w-4 text-primary focus:ring-primary bg-surface border-border"
                      />
                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          {i18nService.t('customProxy')}
                        </span>
                        <span className="block text-xs text-secondary mt-1">
                          {i18nService.t('customProxyDescription')}
                        </span>
                      </span>
                    </label>
                  </div>

                  {proxyMode === ProxyMode.CUSTOM && (
                    <div className="space-y-3 pl-7 max-w-[640px]">
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_8rem]">
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">
                            {i18nService.t('proxyHost')}
                          </label>
                          <div className="flex w-full overflow-hidden rounded-xl border border-border bg-surface-inset focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/30">
                            <select
                              id="proxyProtocol"
                              value={customProxy.protocol}
                              onChange={e =>
                                handleCustomProxyChange(
                                  'protocol',
                                  e.target.value as CustomProxyConfig['protocol'],
                                )
                              }
                              aria-label={i18nService.t('proxyProtocol')}
                              className="w-28 shrink-0 border-0 border-r border-border bg-surface px-3 py-2 text-sm font-medium text-foreground focus:outline-none"
                            >
                              <option value={ProxyProtocol.HTTP}>HTTP</option>
                              <option value={ProxyProtocol.HTTPS}>HTTPS</option>
                            </select>
                            <input
                              type="text"
                              value={customProxy.host}
                              onChange={e => handleCustomProxyChange('host', e.target.value)}
                              className="block min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-sm text-foreground focus:outline-none"
                              placeholder="127.0.0.1"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">
                            {i18nService.t('proxyPort')}
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={65535}
                            value={customProxy.port}
                            onChange={e => handleCustomProxyChange('port', e.target.value)}
                            className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm"
                            placeholder="7890"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">
                            {i18nService.t('proxyUsername')}
                          </label>
                          <input
                            type="text"
                            value={customProxy.username ?? ''}
                            onChange={e => handleCustomProxyChange('username', e.target.value)}
                            className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm"
                            placeholder={i18nService.t('optional')}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">
                            {i18nService.t('proxyPassword')}
                          </label>
                          <input
                            type="password"
                            value={customProxy.password ?? ''}
                            onChange={e => handleCustomProxyChange('password', e.target.value)}
                            className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm"
                            placeholder={i18nService.t('optional')}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end pl-7 max-w-[640px]">
                    <button
                      type="submit"
                      disabled={isSaving}
                      className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
                    >
                      {isSaving ? i18nService.t('saving') : i18nService.t('confirm')}
                    </button>
                  </div>
                </div>

                {/* Gateway Port Configuration */}
                <div className="space-y-3 rounded-xl border px-4 py-4 border-border">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="text-sm font-medium text-foreground">
                        {i18nService.t('openclawGatewayPortTitle')}
                      </div>
                      <input
                        ref={openClawGatewayPortInputRef}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={openClawGatewayPortInput}
                        readOnly={!openClawGatewayPortEditing}
                        onDoubleClick={() => {
                          setOpenClawGatewayPortEditing(true);
                          setOpenClawGatewayPortError(null);
                        }}
                        onChange={e => {
                          setOpenClawGatewayPortInput(e.target.value);
                          setOpenClawGatewayPortError(null);
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' && openClawGatewayPortValidation.valid) {
                            event.preventDefault();
                            void handleSaveOpenClawGatewayPort();
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            cancelOpenClawGatewayPortEditing();
                          }
                        }}
                        aria-invalid={
                          openClawGatewayPortEditing && Boolean(openClawGatewayPortValidationError)
                        }
                        aria-describedby="openclaw-gateway-port-help"
                        className={`w-32 rounded-lg border px-3 py-1.5 text-center text-sm font-mono bg-surface ${
                          openClawGatewayPortEditing && openClawGatewayPortValidationError
                            ? 'border-danger text-foreground'
                            : 'border-border'
                        } ${
                          openClawGatewayPortEditing
                            ? 'text-foreground'
                            : 'cursor-default text-secondary'
                        }`}
                        disabled={openClawGatewayPortSaving}
                      />
                      {openClawGatewayPortEditing && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void handleSaveOpenClawGatewayPort()}
                            disabled={
                              openClawGatewayPortSaving || !openClawGatewayPortValidation.valid
                            }
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                            aria-label={i18nService.t('save')}
                          >
                            <CheckCircleIcon className="h-5 w-5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={cancelOpenClawGatewayPortEditing}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                            aria-label={i18nService.t('cancel')}
                          >
                            <XCircleIcon className="h-5 w-5" aria-hidden="true" />
                          </button>
                        </div>
                      )}
                      {!openClawGatewayPortEditing && (
                        <button
                          type="button"
                          onClick={() => {
                            setOpenClawGatewayPortEditing(true);
                            setOpenClawGatewayPortError(null);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                          aria-label={i18nService.t('openclawGatewayPortEdit')}
                          title={i18nService.t('openclawGatewayPortEdit')}
                        >
                          <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRestartOpenClawGateway()}
                      disabled={
                        isRestartingOpenClawGateway ||
                        openClawGatewayPortEditing ||
                        openClawGatewayPortSaving
                      }
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium border-border text-secondary hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                      title={i18nService.t('openclawGatewayRestartHint')}
                    >
                      <ArrowPathIcon
                        className={`h-4 w-4 ${isRestartingOpenClawGateway ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                      {isRestartingOpenClawGateway
                        ? i18nService.t('openclawGatewayRestarting')
                        : i18nService.t('coworkOpenClawRestartGateway')}
                    </button>
                  </div>
                  <div id="openclaw-gateway-port-help" className="space-y-1 text-xs">
                    <p className="text-secondary">{i18nService.t('openclawGatewayPortHint')}</p>
                    {openClawGatewayPortEditing && openClawGatewayPortValidationError && (
                      <p className="text-danger" role="alert">
                        {openClawGatewayPortValidationError}
                      </p>
                    )}
                    {openClawGatewayPortEditing &&
                      openClawGatewayPortValidation.valid &&
                      openClawGatewayPortValidation.usesEphemeralRange && (
                        <p className="text-warning">
                          {i18nService.t('openclawGatewayPortEphemeralWarning')}
                        </p>
                      )}
                    {openClawGatewayPortError && (
                      <p className="text-danger" role="alert">
                        {openClawGatewayPortError}
                      </p>
                    )}
                    {openClawGatewayPortRestartRequired && (
                      <p className="text-warning" role="status">
                        {i18nService.t('openclawGatewayPortRestartRequired')}
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Appearance Section — mode selector + theme gallery */}
            <div>
              <h4
                className="text-sm font-medium mb-3"
                style={{ color: 'var(--justdo-text-primary)' }}
              >
                {i18nService.t('appearance')}
              </h4>

              {/* Level 1: Mode selector */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                {(['light', 'dark', 'system'] as const).map(mode => {
                  const isSelected = theme === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setTheme(mode);
                        themeService.setTheme(mode);
                        setThemeId(themeService.getThemeId());
                      }}
                      className="flex flex-col items-center rounded-xl border-2 p-3 transition-colors cursor-pointer"
                      style={{
                        borderColor: isSelected ? 'var(--justdo-primary)' : 'var(--justdo-border)',
                        backgroundColor: isSelected ? 'var(--justdo-primary-muted)' : undefined,
                      }}
                    >
                      <svg
                        viewBox="0 0 120 80"
                        className="w-full h-auto rounded-md mb-2 overflow-hidden"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        {mode === 'light' && (
                          <>
                            <rect width="120" height="80" fill="#F8F9FB" />
                            <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                            <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                            <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                            <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                            <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                            <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#E2E4E7" />
                          </>
                        )}
                        {mode === 'dark' && (
                          <>
                            <rect width="120" height="80" fill="#0F1117" />
                            <rect x="0" y="0" width="30" height="80" fill="#151820" />
                            <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                            <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#252930" />
                          </>
                        )}
                        {mode === 'system' && (
                          <>
                            <defs>
                              <clipPath id="left-half">
                                <rect x="0" y="0" width="60" height="80" />
                              </clipPath>
                              <clipPath id="right-half">
                                <rect x="60" y="0" width="60" height="80" />
                              </clipPath>
                            </defs>
                            <g clipPath="url(#left-half)">
                              <rect width="120" height="80" fill="#F8F9FB" />
                              <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                              <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                              <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                              <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                              <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                              <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            </g>
                            <g clipPath="url(#right-half)">
                              <rect width="120" height="80" fill="#0F1117" />
                              <rect x="0" y="0" width="30" height="80" fill="#151820" />
                              <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                              <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                            </g>
                            <line x1="60" y1="0" x2="60" y2="80" stroke="#888" strokeWidth="0.5" />
                          </>
                        )}
                      </svg>
                      <span
                        className="text-xs font-medium"
                        style={{
                          color: isSelected
                            ? 'var(--justdo-primary)'
                            : 'var(--justdo-text-primary)',
                        }}
                      >
                        {i18nService.t(mode)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Theme color gallery — all themes */}
              <h4
                className="text-sm font-medium mb-3 mt-5"
                style={{ color: 'var(--justdo-text-primary)' }}
              >
                {i18nService.t('themeColor')}
              </h4>
              {(() => {
                const allThemes = themeService.getAllThemes();
                const classicThemes = allThemes.filter(
                  t => t.meta.id === 'classic-light' || t.meta.id === 'classic-dark',
                );
                const otherThemes = allThemes.filter(
                  t => t.meta.id !== 'classic-light' && t.meta.id !== 'classic-dark',
                );
                const renderTile = (t: import('@/theme').ThemeDefinition) => {
                  const isSelected = themeId === t.meta.id;
                  const [bg, c1, c2, c3] = t.meta.preview;
                  return (
                    <button
                      key={t.meta.id}
                      type="button"
                      onClick={() => {
                        themeService.setThemeById(t.meta.id);
                        setThemeId(t.meta.id);
                        setTheme(t.meta.appearance as 'light' | 'dark');
                      }}
                      className="flex flex-col items-center rounded-xl border-2 p-2 transition-colors cursor-pointer"
                      style={{
                        borderColor: isSelected ? 'var(--justdo-primary)' : 'var(--justdo-border)',
                        backgroundColor: isSelected ? 'var(--justdo-primary-muted)' : undefined,
                      }}
                    >
                      <svg
                        viewBox="0 0 80 48"
                        className="w-full h-auto rounded-md mb-1.5 overflow-hidden"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <rect width="80" height="48" fill={bg} />
                        <rect x="4" y="6" width="20" height="36" rx="3" fill={c1} opacity="0.7" />
                        <rect x="28" y="6" width="48" height="36" rx="3" fill={c2} opacity="0.5" />
                        <circle cx="52" cy="24" r="8" fill={c3} opacity="0.8" />
                        <rect x="32" y="34" width="40" height="4" rx="2" fill={c1} opacity="0.6" />
                      </svg>
                      <span
                        className="text-[10px] font-medium truncate w-full text-center"
                        style={{
                          color: isSelected
                            ? 'var(--justdo-primary)'
                            : 'var(--justdo-text-primary)',
                        }}
                      >
                        {t.meta.name}
                      </span>
                    </button>
                  );
                };
                return (
                  <>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      {classicThemes.map(renderTile)}
                    </div>
                    <div className="grid grid-cols-4 gap-3">{otherThemes.map(renderTile)}</div>
                  </>
                );
              })()}
            </div>
          </div>
        );

      case 'model':
        return (
          <ModelSettingsTab
            activeProvider={activeProvider}
            providers={providers}
            isTesting={isTesting}
            displayNameError={displayNameError}
            providerRequiresApiKey={providerRequiresApiKey}
            isProviderReadOnly={isProviderReadOnly}
            getProviderDefaultBaseUrl={getProviderDefaultBaseUrl}
            handleProviderChange={handleProviderChange}
            handleProviderConfigChange={handleProviderConfigChange}
            toggleProviderEnabled={toggleProviderEnabled}
            handleAddCustomProvider={handleAddCustomProvider}
            handleAddModel={handleAddModel}
            handleEditModel={handleEditModel}
            handleDeleteModel={handleDeleteModel}
            handleTestConnection={handleTestConnection}
            handleRefreshBuiltinModels={handleRefreshBuiltinModels}
            isRefreshingBuiltinModels={isRefreshingBuiltinModels}
            setDisplayNameError={setDisplayNameError}
            setProviders={setProviders}
            setError={setError}
            onRequestDeleteProvider={setPendingDeleteProvider}
          />
        );

      case 'shortcuts':
        return <ShortcutsSettings shortcuts={shortcuts} onShortcutChange={handleShortcutChange} />;

      case 'im':
        return (
          <div className="flex flex-col items-center justify-center h-full py-20">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="h-8 w-8 text-primary"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-foreground">
                {i18nService.t('imComingSoon')}
              </h4>
              <p className="text-sm text-secondary max-w-md">{i18nService.t('imComingSoonDesc')}</p>
            </div>
          </div>
        );

      case 'help': {
        return (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-4">
                {i18nService.t('about')}
              </h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-secondary">{i18nService.t('appName')}</span>
                  <span className="text-sm font-medium text-foreground">JustDo</span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-secondary">{i18nService.t('appVersion')}</span>
                  <span className="text-sm font-medium text-foreground">{appVersion}</span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-secondary">{i18nService.t('openclawVersion')}</span>
                  <span className="text-sm font-medium text-foreground">{openclawVersion}</span>
                </div>
              </div>
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 modal-backdrop flex items-center justify-center"
    >
      <div
        className="relative flex h-[80vh] rounded-2xl border-border border shadow-modal overflow-hidden modal-content"
        style={{
          width: modalWidth,
          transform: `translate(${modalPosition.x}px, ${modalPosition.y}px)`,
          transition: isDragging || isResizingModal ? 'none' : 'transform 0.1s ease-out',
        }}
        onClick={handleSettingsClick}
      >
        <div
          className="absolute inset-y-0 left-0 z-40 w-2 cursor-col-resize transition-colors hover:bg-primary/20"
          onMouseDown={event => handleModalResizeStart(event, 'left')}
          role="separator"
          aria-orientation="vertical"
          aria-label={i18nService.t('resizeSettingsWindow')}
          title={i18nService.t('resizeSettingsWindow')}
        />
        <div
          className="absolute inset-y-0 right-0 z-40 w-2 cursor-col-resize transition-colors hover:bg-primary/20"
          onMouseDown={event => handleModalResizeStart(event, 'right')}
          role="separator"
          aria-orientation="vertical"
          aria-label={i18nService.t('resizeSettingsWindow')}
          title={i18nService.t('resizeSettingsWindow')}
        />

        {/* Left sidebar */}
        <div
          className="shrink-0 flex flex-col bg-surface-raised rounded-l-2xl overflow-y-auto"
          style={{ width: sidebarWidth }}
        >
          <div className="px-5 pt-5 pb-3 cursor-grab select-none" onMouseDown={handleDragStart}>
            <h2 className="text-lg font-semibold text-foreground">{i18nService.t('settings')}</h2>
          </div>
          <nav className="flex flex-col gap-0.5 px-3 pb-4">
            {sidebarTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                  activeTab === tab.key
                    ? 'bg-primary-muted text-primary'
                    : 'text-secondary hover:text-foreground hover:bg-surface-raised'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div
          className="group relative z-10 w-2 shrink-0 cursor-col-resize bg-surface-raised"
          onMouseDown={event =>
            startHorizontalResize(event, sidebarWidth, setSidebarWidth, 180, 340)
          }
          role="separator"
          aria-orientation="vertical"
          aria-label={i18nService.t('resizePanels')}
          title={i18nService.t('resizePanels')}
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary" />
        </div>

        {/* Right content */}
        <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden bg-background rounded-r-2xl">
          {/* Content header */}
          <div className="flex justify-between items-center px-6 pt-5 pb-3 shrink-0">
            <h3 className="text-lg font-semibold text-foreground">{activeTabLabel}</h3>
            <button
              onClick={onClose}
              className="text-secondary hover:text-foreground p-1.5 hover:bg-surface-raised rounded-lg transition-colors"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {noticeMessage && (
            <div className="px-6">
              <ErrorMessage message={noticeMessage} onClose={() => setNoticeMessage(null)} />
            </div>
          )}

          {error && (
            <div className="px-6">
              <ErrorMessage message={error} onClose={() => setError(null)} />
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
            {/* Tab content */}
            <div
              ref={contentRef}
              className="px-6 py-4 flex-1 overflow-y-auto"
              style={{ scrollbarGutter: 'stable' }}
            >
              {renderTabContent()}
            </div>

            {/* Footer buttons */}
            <div className="flex justify-end space-x-4 p-4 border-border border-t bg-background shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-foreground hover:bg-surface-raised rounded-xl transition-colors text-sm font-medium border border-border active:scale-[0.98]"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
              >
                {isSaving ? i18nService.t('saving') : i18nService.t('save')}
              </button>
            </div>
          </form>
        </div>

        {isTestResultModalOpen && testResult && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
            onClick={e => {
              if (e.target === e.currentTarget) {
                setIsTestResultModalOpen(false);
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={i18nService.t('connectionTestResult')}
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl bg-background border-border border shadow-modal p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-foreground">
                  {i18nService.t('connectionTestResult')}
                </h4>
                <button
                  type="button"
                  onClick={() => setIsTestResultModalOpen(false)}
                  className="p-1 text-secondary hover:text-foreground rounded-md hover:bg-surface-raised"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${
                    testResult.isRunning
                      ? 'bg-surface-raised text-secondary'
                      : testResult.success
                        ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300'
                        : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                  }`}
                >
                  {testResult.isRunning ? (
                    <ArrowPathIcon className="h-4 w-4 flex-none animate-spin" />
                  ) : testResult.success ? (
                    <CheckCircleIcon className="h-4 w-4 flex-none" />
                  ) : (
                    <XCircleIcon className="h-4 w-4 flex-none" />
                  )}
                  <span className="whitespace-nowrap">
                    {testResult.isRunning
                      ? i18nService.t('testing')
                      : testResult.success
                        ? i18nService.t('connectionSuccess')
                        : i18nService.t('connectionFailed')}
                  </span>
                </div>
                <span className="rounded-full border border-border bg-surface px-2 py-1 text-xs font-medium text-secondary">
                  stream=false
                </span>
              </div>

              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
                <span className="font-medium text-foreground">{testResult.providerName}</span>
                {testResult.baseUrl && (
                  <span className="min-w-0 max-w-full truncate" title={testResult.baseUrl}>
                    {testResult.baseUrl}
                  </span>
                )}
                {testResult.modelLabel && (
                  <span
                    className="min-w-0 max-w-full truncate"
                    title={
                      testResult.modelId && testResult.modelId !== testResult.modelLabel
                        ? `${testResult.modelLabel} (${testResult.modelId})`
                        : testResult.modelLabel
                    }
                  >
                    {testResult.modelLabel}
                  </span>
                )}
              </div>

              <p className="mt-3 text-xs leading-5 text-foreground whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                {testResult.message}
              </p>

              {testResult.modelResults && testResult.modelResults.length > 0 && (
                <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface">
                  {testResult.modelResults.map(modelResult => {
                    const status =
                      modelResult.status ?? (modelResult.success ? 'success' : 'failed');
                    const isPending = status === 'pending';
                    const isRunningModel = status === 'testing';
                    const isPassed = status === 'success';
                    return (
                      <div
                        key={modelResult.modelId}
                        className="border-b border-border px-3 py-2 last:border-b-0"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {isRunningModel ? (
                            <ArrowPathIcon className="h-4 w-4 flex-none animate-spin text-secondary" />
                          ) : isPassed ? (
                            <CheckCircleIcon className="h-4 w-4 flex-none text-green-500" />
                          ) : isPending ? (
                            <span className="h-4 w-4 flex-none rounded-full border border-border" />
                          ) : (
                            <XCircleIcon className="h-4 w-4 flex-none text-red-500" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-foreground">
                              {modelResult.modelLabel}
                            </div>
                            <div className="truncate text-[11px] text-secondary">
                              {modelResult.modelId}
                            </div>
                          </div>
                          <span
                            className={`flex-none text-[11px] ${
                              isRunningModel || isPending
                                ? 'text-secondary'
                                : isPassed
                                  ? 'text-green-600 dark:text-green-300'
                                  : 'text-red-600 dark:text-red-300'
                            }`}
                          >
                            {isPending
                              ? i18nService.t('connectionTestPending')
                              : isRunningModel
                                ? i18nService.t('connectionTestRunning')
                                : isPassed
                                  ? i18nService.t('connectionSuccess')
                                  : i18nService.t('connectionFailed')}
                          </span>
                        </div>
                        {!isPending && !isRunningModel && !isPassed && (
                          <div className="mt-2 space-y-2 pl-6">
                            {modelResult.detail && (
                              <p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-red-600 dark:text-red-300">
                                {modelResult.detail}
                              </p>
                            )}
                            {modelResult.log && (
                              <pre className="max-h-32 overflow-y-auto rounded-lg border border-border bg-background px-2 py-1.5 text-[11px] leading-5 text-secondary whitespace-pre-wrap break-words">
                                {modelResult.log}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {testResult.log && !testResult.modelResults?.length && (
                <pre className="mt-3 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-[11px] leading-5 text-secondary whitespace-pre-wrap break-words">
                  {testResult.log}
                </pre>
              )}

              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setIsTestResultModalOpen(false)}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised transition-colors active:scale-[0.98]"
                >
                  {i18nService.t('close')}
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingDeleteProvider && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
            onClick={e => {
              if (e.target === e.currentTarget) {
                setPendingDeleteProvider(null);
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl bg-surface border-border border shadow-modal p-4"
            >
              <p className="text-sm text-foreground">
                {i18nService.t('confirmDeleteCustomProvider')}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingDeleteProvider(null)}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised transition-colors active:scale-[0.98]"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={confirmDeleteCustomProvider}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl bg-red-500 hover:bg-red-600 text-white transition-colors active:scale-[0.98]"
                >
                  {i18nService.t('deleteCustomProvider')}
                </button>
              </div>
            </div>
          </div>
        )}

        {(isAddingModel || isEditingModel) && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl">
            <div
              role="dialog"
              aria-modal="true"
              aria-label={
                isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')
              }
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              onKeyDown={handleModelDialogKeyDown}
              className="w-full max-w-md rounded-2xl bg-background border-border border shadow-modal p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-foreground">
                  {isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                </h4>
                <button
                  type="button"
                  onClick={handleCancelModelEdit}
                  className="p-1 text-secondary hover:text-foreground rounded-md hover:bg-surface-raised"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              {modelFormError && (
                <p className="mb-3 text-xs text-red-600 dark:text-red-400">{modelFormError}</p>
              )}

              <div className="space-y-3">
                <>
                  <div>
                    <label className="block text-xs font-medium text-secondary mb-1">
                      {i18nService.t('modelName')}
                    </label>
                    <input
                      autoFocus
                      type="text"
                      value={newModelName}
                      onChange={e => {
                        setNewModelName(e.target.value);
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                      placeholder="GPT-4"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-secondary mb-1">
                      {i18nService.t('modelId')}
                    </label>
                    <input
                      type="text"
                      value={newModelId}
                      onChange={e => {
                        setNewModelId(e.target.value);
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                      placeholder="gpt-4"
                    />
                  </div>
                </>
                <div>
                  <label className="block text-xs font-medium text-secondary mb-1">
                    {i18nService.t('contextLength')}
                  </label>
                  <input
                    type="number"
                    value={newModelContextLength ?? ''}
                    onChange={e => {
                      const val = e.target.value;
                      setNewModelContextLength(val === '' ? undefined : parseInt(val, 10));
                    }}
                    className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                    placeholder="200000"
                    min={0}
                  />
                  <p className="mt-1 text-[11px] text-muted">
                    {i18nService.t('contextLengthHint')}
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-secondary mb-1">
                    {i18nService.t('maxTokens')}
                  </label>
                  <input
                    type="number"
                    value={newModelMaxTokens ?? ''}
                    onChange={e => {
                      const val = e.target.value;
                      setNewModelMaxTokens(val === '' ? undefined : parseInt(val, 10));
                    }}
                    className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                    placeholder="32000"
                    min={0}
                  />
                  <p className="mt-1 text-[11px] text-muted">{i18nService.t('maxTokensHint')}</p>
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    id={`${activeProvider}-supportsImage`}
                    type="checkbox"
                    checked={newModelSupportsImage}
                    onChange={e => setNewModelSupportsImage(e.target.checked)}
                    className="h-3.5 w-3.5 text-primary focus:ring-primary bg-surface border-border rounded"
                  />
                  <label
                    htmlFor={`${activeProvider}-supportsImage`}
                    className="text-xs text-secondary"
                  >
                    {i18nService.t('supportsImageInput')}
                  </label>
                </div>
              </div>

              <div className="flex justify-end space-x-2 mt-4">
                <button
                  type="button"
                  onClick={handleCancelModelEdit}
                  className="px-3 py-1.5 text-xs text-foreground hover:bg-surface-raised rounded-xl border border-border"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleSaveNewModel}
                  className="px-3 py-1.5 text-xs text-white bg-primary hover:bg-primary-hover rounded-xl active:scale-[0.98]"
                >
                  {i18nService.t('save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default Settings;
