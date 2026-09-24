import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ChartBarIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
  MicrophoneIcon,
  PaintBrushIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  DEFAULT_MAX_RETAINED_DISPLAY_TABS,
  normalizeMaxRetainedDisplayTabs,
} from '@shared/cowork/displayTabRetention';
import {
  DEFAULT_MAX_GOAL_CONTINUATION_TURNS,
  normalizeMaxGoalContinuationTurns,
} from '@shared/cowork/sessionGoal';
import { NetworkFetchPurpose } from '@shared/network/network';
import { type CustomProxyConfig, defaultCustomProxyConfig, ProxyMode } from '@shared/network/proxy';
import {
  type AgentRuntimeSettings,
  createDefaultAgentRuntimeSettings,
} from '@shared/openclaw/agentRuntimeSettings';
import { DEFAULT_OPENCLAW_GATEWAY_PORT } from '@shared/openclaw/constants';
import {
  createDefaultExternalAgentSettings,
  type ExternalAgentSettings,
} from '@shared/openclaw/externalAgents';
import {
  GatewayPortSetErrorCode,
  GatewayPortValidationCode,
  parseGatewayPortInput,
} from '@shared/openclaw/gatewayPort';
import { normalizeOpenClawProviderId } from '@shared/providers';
import {
  buildProviderModelsUrl,
  DEFAULT_MODEL_CONTEXT_LENGTH,
  DEFAULT_MODEL_MAX_TOKENS,
  mergeDiscoveredProviderModels,
  parseProviderModelsResponse,
} from '@shared/providers/modelDiscovery';
import { mergeModelProviderHeaders } from '@shared/providers/modelProviderHeaders';
import {
  type LocalSpeechSettings,
  normalizeLocalSpeechSettings,
} from '@shared/speech/localSpeechSettings';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';

import {
  type AppearanceConfig,
  applyAppearanceConfig,
  normalizeAppearanceConfig,
} from '@/app/appearance';
import {
  type AppConfig,
  defaultConfig,
  getCustomProviderDefaultName,
  getProviderDisplayName,
  getVisibleProviders,
  isBuiltinModelsProvider,
  isCustomProvider,
  isReservedProviderDisplayName,
  validateDisplayName,
} from '@/app/config';
import { APP_NAME } from '@/app/constants';
import WindowHeader from '@/app/shell/window/WindowHeader';
import AgentManager from '@/features/agents/AgentManager';
import { updateConfig as updateCoworkConfig } from '@/features/cowork/coworkSlice';
import {
  BUILTIN_MODELS_UPDATED_EVENT,
  getEnabledProviderModels,
} from '@/features/models/modelConfig';
import { setAvailableModels } from '@/features/models/modelSlice';
import { toOpenClawModelRef } from '@/features/models/openclawModelRef';
import BrowserSettingsTab from '@/features/settings/browser/BrowserSettingsTab';
import IntegrationSettingsTab, {
  IntegrationSettingsView,
  type IntegrationSettingsViewId,
} from '@/features/settings/integrations/IntegrationSettingsTab';
import { hasConfirmedModelCapabilities } from '@/features/settings/models/modelCapabilityState';
import { MODEL_CONNECTION_TEST_TIMEOUT_MS } from '@/features/settings/models/modelConnectionTest';
import { validateModelForm } from '@/features/settings/models/modelFormValidation';
import { mergeRefreshedBuiltinProvider } from '@/features/settings/models/modelSettingsRefresh';
import ModelSettingsTab, { type ModelKind } from '@/features/settings/models/ModelSettingsTab';
import {
  commitNonLanguageModelConfigurations,
  createEmptyNonLanguageModelCategory,
  getNonLanguageModelCategoryValidationError,
  NON_LANGUAGE_MODEL_KINDS,
  type NonLanguageModelCategory,
  type NonLanguageModelProviders,
} from '@/features/settings/models/nonLanguageModelConfig';
import type { NonLanguageModelKind } from '@/features/settings/models/NonLanguageModelSettings';
import ShortcutsSettings, {
  findShortcutConflict,
  shortcutLabelMap,
  type ShortcutSettingsValue,
} from '@/features/settings/preferences/ShortcutsSettings';
import AgentRuntimeSettingsTab from '@/features/settings/runtime/AgentRuntimeSettingsTab';
import WindowsSandboxSettingsTab from '@/features/settings/runtime/WindowsSandboxSettingsTab';
import {
  buildSettingsAppConfigUpdate,
  persistSettingsInOrder,
  resolveProviderKeyAfterRename,
  resolveSubagentModelAfterProviderChange,
} from '@/features/settings/settingsPersistence';
import { createSettingsPreviewRestore } from '@/features/settings/settingsPreviewRestore';
import VoiceSettingsTab from '@/features/settings/speech/VoiceSettingsTab';
import AppUpdateSection from '@/features/settings/updates/AppUpdateSection';
import UsageStatsTab from '@/features/settings/usage/UsageStatsTab';
import { configService } from '@/services/config';
import { i18nService, LanguageType } from '@/services/i18n';
import { themeService } from '@/services/theme';
import ErrorMessage from '@/shared/components/ErrorMessage';

import appLogoUrl from '../../../../resources/logo.png';
import { createModelConnectionTestActions } from './models/modelConnectionTestActions';
import {
  getConnectivityErrorMessage,
  getCustomProviderKeysInOrder,
  getDefaultActiveProvider,
  getDefaultProviders,
  getNextCustomProvider,
  getProviderDefaultBaseUrl,
  isProviderReadOnly,
  ModelConnectionTestStatus,
  normalizeProvidersForSave,
  normalizeProvidersForSettings,
  ProviderConnectionTestResult,
  providerRequiresApiKey,
  ProvidersConfig,
  ProviderType,
  toConnectivityRecord,
} from './models/providerSettingsConfig';
import { AppearancePreferences } from './preferences/AppearancePreferences';
import { GeneralSettingsPage } from './preferences/GeneralSettingsPage';

type TabType =
  | 'agents'
  | 'general'
  | 'appearance'
  | 'usage'
  | 'model'
  | 'runtime'
  | 'integrations'
  | 'security'
  | 'browser'
  | 'voice'
  | 'im'
  | 'shortcuts'
  | 'help';

const DEVELOPER_MODE_REVEAL_CLICKS = 10;

const getEnabledSettingsTab = (tab?: TabType): TabType => tab ?? 'general';

export type SettingsOpenOptions = {
  initialTab?: TabType;
  browserPage?: 'history' | 'downloads';
  notice?: string;
  noticeI18nKey?: string;
  noticeExtra?: string;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
}
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const SAVE_SUCCESS_FEEDBACK_DURATION_MS = 1_800;
const buildModelDiscoveryHeaders = (
  apiKey: string,
  customHeaders?: Record<string, string>,
): Record<string, string> =>
  mergeModelProviderHeaders(
    apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
    customHeaders,
  );

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
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

const Settings: React.FC<SettingsProps> = ({
  onClose,
  initialTab,
  browserPage,
  notice,
  noticeI18nKey,
  noticeExtra,
}) => {
  const dispatch = useDispatch();
  // 状态
  const agentLeaveGuard = useRef<(() => boolean) | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>(getEnabledSettingsTab(initialTab));
  const [generalTitleClicks, setGeneralTitleClicks] = useState(0);
  const developerModeAvailable =
    activeTab === 'general' && generalTitleClicks >= DEVELOPER_MODE_REVEAL_CLICKS;

  useEffect(() => {
    if (activeTab !== 'general') setGeneralTitleClicks(0);
  }, [activeTab]);

  const [activeModelKind, setActiveModelKind] = useState<ModelKind>('language');
  const [activeIntegrationView, setActiveIntegrationView] = useState<IntegrationSettingsViewId>(
    IntegrationSettingsView.AgentDelegation,
  );
  const [nonLanguageModelProviders, setNonLanguageModelProviders] =
    useState<NonLanguageModelProviders>(() =>
      structuredClone(configService.getConfig().onlineModelProviders ?? {}),
    );
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light');
  const [themeId, setThemeId] = useState<string>(themeService.getThemeId());
  const [appearance, setAppearance] = useState<AppearanceConfig>(() =>
    normalizeAppearanceConfig(configService.getConfig().appearance),
  );
  const [language, setLanguage] = useState<LanguageType>('zh');
  const [autoLaunch, setAutoLaunchState] = useState(false);
  const [proxyMode, setProxyMode] = useState<ProxyMode>(ProxyMode.DIRECT);
  const [customProxy, setCustomProxy] = useState<CustomProxyConfig>(defaultCustomProxyConfig);
  const [developerMode, setDeveloperMode] = useState(false);
  const [voice, setVoice] = useState<LocalSpeechSettings>(() =>
    normalizeLocalSpeechSettings(configService.getConfig().voice),
  );
  const [maxGoalContinuationTurns, setMaxGoalContinuationTurns] = useState(
    DEFAULT_MAX_GOAL_CONTINUATION_TURNS,
  );
  const [maxRetainedDisplayTabs, setMaxRetainedDisplayTabs] = useState(
    DEFAULT_MAX_RETAINED_DISPLAY_TABS,
  );
  const [isUpdatingAutoLaunch, setIsUpdatingAutoLaunch] = useState(false);
  const [preventSleep, setPreventSleepState] = useState(false);
  const [isUpdatingPreventSleep, setIsUpdatingPreventSleep] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSucceeded, setSaveSucceeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buildNoticeMessage = useCallback((): string | null => {
    if (noticeI18nKey) {
      const base = i18nService.t(noticeI18nKey);
      return noticeExtra ? `${base} (${noticeExtra})` : base;
    }
    return notice ?? null;
  }, [notice, noticeExtra, noticeI18nKey]);

  const [noticeMessage, setNoticeMessage] = useState<string | null>(() => buildNoticeMessage());
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult | null>(null);
  const [isTestResultModalOpen, setIsTestResultModalOpen] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [modelConnectionTestStatuses, setModelConnectionTestStatuses] = useState<
    Record<ProviderType, Record<string, ModelConnectionTestStatus>>
  >({});
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<ProviderType | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [appVersion, setAppVersion] = useState<string>('unknown');
  const initialThemeRef = useRef<'light' | 'dark' | 'system'>(themeService.getTheme());
  const initialThemeIdRef = useRef<string>(themeService.getThemeId());
  const initialAppearanceRef = useRef<AppearanceConfig>(appearance);
  const initialLanguageRef = useRef<LanguageType>(i18nService.getLanguage());
  const initialMaxGoalContinuationTurnsRef = useRef(DEFAULT_MAX_GOAL_CONTINUATION_TURNS);
  const initialMaxRetainedDisplayTabsRef = useRef(DEFAULT_MAX_RETAINED_DISPLAY_TABS);
  const connectionTestRef = useRef({ generation: 0, requestId: null as string | null });

  const setNonLanguageModelCategory = useCallback(
    (kind: NonLanguageModelKind, update: React.SetStateAction<NonLanguageModelCategory>): void => {
      setNonLanguageModelProviders(current => {
        const previous = current[kind] ?? createEmptyNonLanguageModelCategory();
        const next = typeof update === 'function' ? update(previous) : update;
        return { ...current, [kind]: next };
      });
    },
    [],
  );

  const cancelConnectionTest = useCallback((updateState = true) => {
    connectionTestRef.current.generation += 1;
    const requestId = connectionTestRef.current.requestId;
    connectionTestRef.current.requestId = null;
    if (requestId) {
      void window.electron.api.cancelFetch(requestId).catch(() => undefined);
    }
    if (updateState) {
      setIsTesting(false);
    }
  }, []);

  const handleCloseTestResultModal = useCallback(() => {
    cancelConnectionTest();
    setIsTestResultModalOpen(false);
  }, [cancelConnectionTest]);

  const handleCloseSettings = useCallback(() => {
    if (agentLeaveGuard.current && !agentLeaveGuard.current()) return;
    cancelConnectionTest();
    onClose();
  }, [cancelConnectionTest, onClose]);

  useEffect(
    () => () => {
      cancelConnectionTest(false);
    },
    [cancelConnectionTest],
  );

  useEffect(() => {
    if (!saveSucceeded) return;

    const timer = window.setTimeout(
      () => setSaveSucceeded(false),
      SAVE_SUCCESS_FEEDBACK_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [saveSucceeded]);

  useEffect(() => {
    if (activeTab === 'help') {
      window.electron.appInfo.getVersion().then(setAppVersion);
    }
  }, [activeTab]);

  // Add state for active provider
  const [activeProvider, setActiveProvider] = useState<ProviderType>(getDefaultActiveProvider());
  // Add state for providers configuration
  const [providers, setProviders] = useState<ProvidersConfig>(() => getDefaultProviders());
  const [agentRuntimeSettings, setAgentRuntimeSettings] = useState<AgentRuntimeSettings>(() =>
    createDefaultAgentRuntimeSettings(),
  );
  const [initialAgentRuntimeSettings, setInitialAgentRuntimeSettings] =
    useState<AgentRuntimeSettings | null>(null);
  const [agentRuntimeSettingsLoading, setAgentRuntimeSettingsLoading] = useState(true);
  const [agentRuntimeSettingsLoadError, setAgentRuntimeSettingsLoadError] = useState<string | null>(
    null,
  );
  const [externalAgentSettings, setExternalAgentSettings] = useState<ExternalAgentSettings>(() =>
    createDefaultExternalAgentSettings(),
  );
  const [initialExternalAgentSettings, setInitialExternalAgentSettings] =
    useState<ExternalAgentSettings | null>(null);
  const [externalAgentSettingsLoading, setExternalAgentSettingsLoading] = useState(true);
  const [externalAgentSettingsLoadError, setExternalAgentSettingsLoadError] = useState<
    string | null
  >(null);
  const [isRefreshingBuiltinModels, setIsRefreshingBuiltinModels] = useState(false);
  const [isDetectingModels, setIsDetectingModels] = useState(false);
  const [modelDiscoveryMessage, setModelDiscoveryMessage] = useState<string | null>(null);
  const modelDiscoveryGenerationRef = useRef(0);

  const loadAgentRuntimeSettings = useCallback(async () => {
    setAgentRuntimeSettingsLoading(true);
    setAgentRuntimeSettingsLoadError(null);
    try {
      const result = await window.electron.cowork.getAgentRuntimeSettings();
      if (!result.success || !result.settings) {
        throw new Error(result.error || i18nService.t('agentRuntimeLoadFailed'));
      }
      setAgentRuntimeSettings(result.settings);
      setInitialAgentRuntimeSettings(result.settings);
    } catch (error) {
      setAgentRuntimeSettingsLoadError(
        error instanceof Error ? error.message : i18nService.t('agentRuntimeLoadFailed'),
      );
    } finally {
      setAgentRuntimeSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgentRuntimeSettings();
  }, [loadAgentRuntimeSettings]);

  const loadExternalAgentSettings = useCallback(async () => {
    setExternalAgentSettingsLoading(true);
    setExternalAgentSettingsLoadError(null);
    try {
      const result = await window.electron.openclaw.externalAgents.getSettings();
      if (!result.success || !result.settings) {
        throw new Error(i18nService.t('externalAgentsLoadFailed'));
      }
      setExternalAgentSettings(result.settings);
      setInitialExternalAgentSettings(result.settings);
    } catch {
      setExternalAgentSettingsLoadError(i18nService.t('externalAgentsLoadFailed'));
    } finally {
      setExternalAgentSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadExternalAgentSettings();
  }, [loadExternalAgentSettings]);

  const agentRuntimeModels = useMemo(() => getEnabledProviderModels(providers), [providers]);
  const agentRuntimeSettingsDirty = Boolean(
    initialAgentRuntimeSettings &&
    JSON.stringify(initialAgentRuntimeSettings) !== JSON.stringify(agentRuntimeSettings),
  );
  const externalAgentSettingsDirty = Boolean(
    initialExternalAgentSettings &&
    JSON.stringify(initialExternalAgentSettings) !== JSON.stringify(externalAgentSettings),
  );

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
    terminal: defaultConfig.shortcuts!.terminal,
    browser: defaultConfig.shortcuts!.browser,
    sideChat: defaultConfig.shortcuts!.sideChat,
    files: defaultConfig.shortcuts!.files,
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
  const [modelCapabilitiesInitiallyConfirmed, setModelCapabilitiesInitiallyConfirmed] =
    useState(false);
  const [modelCapabilitiesDirty, setModelCapabilitiesDirty] = useState(false);
  const [modelFormError, setModelFormError] = useState<string | null>(null);

  // State for displayName validation
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
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
      initialAppearanceRef.current = normalizeAppearanceConfig(config.appearance);
      initialLanguageRef.current = config.language;
      setTheme(config.theme);
      setAppearance(initialAppearanceRef.current);
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
      setVoice(normalizeLocalSpeechSettings(config.voice));
      setNonLanguageModelProviders(structuredClone(config.onlineModelProviders ?? {}));

      void window.electron.cowork.getConfig().then(result => {
        if (result.success && result.config) {
          const value = normalizeMaxGoalContinuationTurns(result.config.maxGoalContinuationTurns);
          setMaxGoalContinuationTurns(value);
          initialMaxGoalContinuationTurnsRef.current = value;
          const retainedTabs = normalizeMaxRetainedDisplayTabs(
            result.config.maxRetainedDisplayTabs,
          );
          setMaxRetainedDisplayTabs(retainedTabs);
          initialMaxRetainedDisplayTabsRef.current = retainedTabs;
        }
      });

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

          return normalizeProvidersForSettings(merged);
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
    const refreshProviders = () => {
      const config = configService.getConfig();
      setProviders(currentProviders =>
        mergeRefreshedBuiltinProvider(currentProviders, config.providers),
      );
    };
    window.addEventListener(BUILTIN_MODELS_UPDATED_EVENT, refreshProviders);
    return () => window.removeEventListener(BUILTIN_MODELS_UPDATED_EVENT, refreshProviders);
  }, []);

  useEffect(() => {
    return createSettingsPreviewRestore(
      {
        themeId: initialThemeIdRef,
        theme: initialThemeRef,
        appearance: initialAppearanceRef,
        language: initialLanguageRef,
      },
      {
        restoreTheme: (themeId, themeMode) => themeService.restoreTheme(themeId, themeMode),
        restoreAppearance: applyAppearanceConfig,
        restoreLanguage: initialLanguage =>
          i18nService.setLanguage(initialLanguage, { persist: false }),
      },
    );
  }, []);

  useEffect(() => {
    applyAppearanceConfig(appearance);
  }, [appearance]);

  // 监听标签页切换，确保内容区域滚动到顶部
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  useEffect(() => {
    setNoticeMessage(buildNoticeMessage());
  }, [buildNoticeMessage]);

  useEffect(() => {
    if (initialTab) {
      if (agentLeaveGuard.current && !agentLeaveGuard.current()) return;
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

  // Compute visible providers based on language, including user-defined entries.
  const visibleProviders = useMemo(() => {
    const visibleKeys = getVisibleProviders(language);
    const filtered: Partial<ProvidersConfig> = {};
    for (const key of visibleKeys) {
      if (providers[key as keyof ProvidersConfig]) {
        filtered[key as keyof ProvidersConfig] = providers[key as keyof ProvidersConfig];
      }
    }
    // Preserve persisted insertion order so newly added providers stay at the end.
    for (const key of getCustomProviderKeysInOrder(providers)) {
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
    modelDiscoveryGenerationRef.current += 1;
    setIsDetectingModels(false);
    setModelDiscoveryMessage(null);
    const { key: newKey, name: displayName } = getNextCustomProvider(providers);
    setProviders(prev => ({
      ...prev,
      [newKey]: {
        enabled: true,
        apiKey: '',
        baseUrl: '',
        apiFormat: 'openai' as const,
        models: [],
        displayName,
        identity: crypto.randomUUID(),
      },
    }));
    setActiveProvider(newKey);
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setNewModelContextLength(undefined);
    setNewModelMaxTokens(undefined);
    setModelCapabilitiesInitiallyConfirmed(false);
    setModelCapabilitiesDirty(false);
    setModelFormError(null);
    setModelDiscoveryMessage(null);
  };

  const handleDetectModels = async () => {
    const provider = activeProvider;
    const providerConfig = providers[provider];
    const baseUrl = providerConfig?.baseUrl.trim() ?? '';
    const apiKey = providerConfig?.apiKey.trim() ?? '';
    if (!baseUrl || !apiKey || isProviderReadOnly(provider, providerConfig)) {
      return;
    }

    const discoveryGeneration = ++modelDiscoveryGenerationRef.current;
    setError(null);
    setModelDiscoveryMessage(null);
    setIsDetectingModels(true);
    try {
      const headers = buildModelDiscoveryHeaders(
        apiKey,
        isBuiltinModelsProvider(provider) ? undefined : providerConfig.headers,
      );
      const modelsResponse = await withTimeout(
        window.electron.api.fetch({
          url: buildProviderModelsUrl(baseUrl),
          method: 'GET',
          headers,
          purpose: NetworkFetchPurpose.ModelDiscovery,
        }),
        MODEL_DISCOVERY_TIMEOUT_MS,
        i18nService.t('modelDetectionTimeout'),
      );
      if (discoveryGeneration !== modelDiscoveryGenerationRef.current) {
        return;
      }
      if (!modelsResponse.ok) {
        const detail =
          getConnectivityErrorMessage(modelsResponse.data) ||
          `${modelsResponse.status} ${modelsResponse.statusText}`.trim();
        throw new Error(detail);
      }
      if (!Array.isArray(toConnectivityRecord(modelsResponse.data)?.data)) {
        throw new Error(i18nService.t('connectionInvalidResponse'));
      }

      const discoveredModels = parseProviderModelsResponse(modelsResponse.data).map(model => ({
        id: model.id,
        name: model.name,
      }));
      setProviders(current => ({
        ...current,
        ...(current[provider]?.baseUrl.trim() === baseUrl &&
        current[provider]?.apiKey.trim() === apiKey
          ? {
              [provider]: {
                ...current[provider],
                models: mergeDiscoveredProviderModels(
                  current[provider]?.models ?? [],
                  discoveredModels,
                ),
              },
            }
          : {}),
      }));

      const messageKey =
        discoveredModels.length === 0 ? 'noModelsDetected' : 'modelDetectionSummary';
      setModelDiscoveryMessage(
        i18nService.t(messageKey).replace('{count}', String(discoveredModels.length)),
      );
    } catch (discoveryError) {
      if (discoveryGeneration !== modelDiscoveryGenerationRef.current) {
        return;
      }
      const detail =
        discoveryError instanceof Error
          ? discoveryError.message
          : i18nService.t('modelDetectionFailed');
      setError(`${i18nService.t('modelDetectionFailed')}: ${detail}`);
    } finally {
      if (discoveryGeneration === modelDiscoveryGenerationRef.current) {
        setIsDetectingModels(false);
      }
    }
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
          const refreshedConfig = freshConfig as Partial<AppConfig>;
          await configService.updateConfig(refreshedConfig);

          if (refreshedConfig.providers) {
            setProviders(currentProviders =>
              mergeRefreshedBuiltinProvider(currentProviders, refreshedConfig.providers),
            );
            dispatch(setAvailableModels(getEnabledProviderModels(refreshedConfig.providers)));
          }
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
    modelDiscoveryGenerationRef.current += 1;
    setIsDetectingModels(false);
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
    cancelConnectionTest();
    modelDiscoveryGenerationRef.current += 1;
    setIsDetectingModels(false);
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setNewModelContextLength(undefined);
    setNewModelMaxTokens(undefined);
    setModelCapabilitiesInitiallyConfirmed(false);
    setModelCapabilitiesDirty(false);
    setModelFormError(null);
    setModelDiscoveryMessage(null);
    setDisplayNameError(null);
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

    if (field === 'apiKey' || field === 'baseUrl') {
      modelDiscoveryGenerationRef.current += 1;
      setIsDetectingModels(false);
      setModelDiscoveryMessage(null);
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
    setSaveSucceeded(false);

    const invalidNonLanguageModelKind = NON_LANGUAGE_MODEL_KINDS.find(kind => {
      const category = nonLanguageModelProviders[kind];
      return category && getNonLanguageModelCategoryValidationError(kind, category);
    });
    if (invalidNonLanguageModelKind) {
      const category = nonLanguageModelProviders[invalidNonLanguageModelKind];
      setActiveTab('model');
      setActiveModelKind(invalidNonLanguageModelKind);
      setError(
        category
          ? getNonLanguageModelCategoryValidationError(invalidNonLanguageModelKind, category)
          : i18nService.t('settingsSaveFailed'),
      );
      return;
    }

    const incompleteCustomProvider = Object.entries(providers).find(
      ([providerKey, providerConfig]) =>
        isCustomProvider(providerKey) &&
        (!providerConfig.baseUrl.trim() || !providerConfig.apiKey.trim()),
    );
    if (incompleteCustomProvider) {
      setActiveTab('model');
      setActiveProvider(incompleteCustomProvider[0]);
      setError(i18nService.t('customProviderRequiredFields'));
      return;
    }

    const customProviderNames = Object.entries(providers)
      .filter(([providerKey]) => isCustomProvider(providerKey))
      .map(
        ([providerKey, providerConfig]) =>
          [
            providerKey,
            providerConfig.displayName?.trim() || getCustomProviderDefaultName(providerKey),
          ] as const,
      );
    const reservedNameProvider = customProviderNames.find(([, name]) =>
      isReservedProviderDisplayName(name),
    );
    if (reservedNameProvider) {
      setActiveTab('model');
      setActiveProvider(reservedNameProvider[0]);
      setError(i18nService.t('providerNameReserved'));
      return;
    }

    const invalidNameProvider = customProviderNames.find(
      ([, name]) => !validateDisplayName(name).valid,
    );
    if (invalidNameProvider) {
      setActiveTab('model');
      setActiveProvider(invalidNameProvider[0]);
      setError(i18nService.t('providerNameInvalid'));
      return;
    }

    const seenProviderNames = new Set<string>();
    const duplicateNameProvider = customProviderNames.find(([, name]) => {
      const normalizedName = normalizeOpenClawProviderId(name);
      if (seenProviderNames.has(normalizedName)) return true;
      seenProviderNames.add(normalizedName);
      return false;
    });
    if (duplicateNameProvider) {
      setActiveTab('model');
      setActiveProvider(duplicateNameProvider[0]);
      setError(i18nService.t('providerNameExists'));
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const normalizedProviders = normalizeProvidersForSave(providers);
      const normalizedActiveProvider = isCustomProvider(activeProvider)
        ? normalizeOpenClawProviderId(
            providers[activeProvider]?.displayName?.trim() ||
              getCustomProviderDefaultName(activeProvider),
          )
        : activeProvider;

      // Find the first enabled provider to use as the primary API
      const firstEnabledProvider = Object.entries(normalizedProviders).find(
        ([_, config]) => config.enabled,
      );

      const primaryProvider = firstEnabledProvider
        ? firstEnabledProvider[1]
        : normalizedProviders[normalizedActiveProvider];
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
      let normalizedNonLanguageModelProviders = nonLanguageModelProviders;
      let normalizedVoice = voice;

      await persistSettingsInOrder({
        saveCoworkConfig: async () => {
          const goalTurnsChanged =
            maxGoalContinuationTurns !== initialMaxGoalContinuationTurnsRef.current;
          const retainedTabsChanged =
            maxRetainedDisplayTabs !== initialMaxRetainedDisplayTabsRef.current;
          if (!goalTurnsChanged && !retainedTabsChanged) {
            return;
          }
          const result = await window.electron.cowork.setConfig({
            ...(goalTurnsChanged ? { maxGoalContinuationTurns } : {}),
            ...(retainedTabsChanged ? { maxRetainedDisplayTabs } : {}),
          });
          if (!result.success) {
            throw new Error(
              result.error ||
                i18nService.t(
                  retainedTabsChanged
                    ? 'displayTabRetentionSaveFailed'
                    : 'goalContinuationSettingsSaveFailed',
                ),
            );
          }
          initialMaxGoalContinuationTurnsRef.current = maxGoalContinuationTurns;
          initialMaxRetainedDisplayTabsRef.current = maxRetainedDisplayTabs;
          dispatch(
            updateCoworkConfig({
              ...(goalTurnsChanged ? { maxGoalContinuationTurns } : {}),
              ...(retainedTabsChanged ? { maxRetainedDisplayTabs } : {}),
            }),
          );
        },
        saveRuntimeSettings: async () => {
          if (!initialAgentRuntimeSettings) return;

          const availableRuntimeModelRefs = new Set(
            getEnabledProviderModels(normalizedProviders).map(toOpenClawModelRef),
          );
          const persistedRuntimeResult = await window.electron.cowork.getAgentRuntimeSettings();
          const persistedSubagentModel = persistedRuntimeResult.success
            ? persistedRuntimeResult.settings?.subagents.model
            : undefined;
          const runtimeSettingsToSave: AgentRuntimeSettings = {
            ...agentRuntimeSettings,
            subagents: {
              ...agentRuntimeSettings.subagents,
              model: resolveSubagentModelAfterProviderChange(
                agentRuntimeSettings.subagents.model,
                persistedSubagentModel,
                availableRuntimeModelRefs,
              ),
            },
          };
          if (
            JSON.stringify(runtimeSettingsToSave) === JSON.stringify(initialAgentRuntimeSettings)
          ) {
            return;
          }

          const runtimeResult =
            await window.electron.cowork.setAgentRuntimeSettings(runtimeSettingsToSave);
          if (!runtimeResult.success) {
            setActiveTab('runtime');
            throw new Error(
              `${i18nService.t('agentRuntimeSaveFailed')}${
                runtimeResult.error ? ` ${runtimeResult.error}` : ''
              }`,
            );
          }
          const savedRuntimeSettings = runtimeResult.settings ?? runtimeSettingsToSave;
          setAgentRuntimeSettings(savedRuntimeSettings);
          setInitialAgentRuntimeSettings(savedRuntimeSettings);
        },
        saveExternalAgentSettings: async () => {
          if (
            !initialExternalAgentSettings ||
            JSON.stringify(externalAgentSettings) === JSON.stringify(initialExternalAgentSettings)
          ) {
            return;
          }
          const result =
            await window.electron.openclaw.externalAgents.setSettings(externalAgentSettings);
          if (!result.success) {
            setActiveIntegrationView(IntegrationSettingsView.AgentDelegation);
            setActiveTab('integrations');
            throw new Error(i18nService.t('externalAgentsSaveFailed'));
          }
          const savedSettings = result.settings ?? externalAgentSettings;
          setExternalAgentSettings(savedSettings);
          setInitialExternalAgentSettings(savedSettings);
        },
        saveAppConfig: async () => {
          const currentConfig = configService.getConfig();
          normalizedNonLanguageModelProviders = await commitNonLanguageModelConfigurations(
            currentConfig.onlineModelProviders ?? {},
            nonLanguageModelProviders,
            async normalizedConfigurations => {
              const resolveCatalogModel = (
                kind: 'speech-recognition' | 'speech-synthesis',
                reference: string,
              ) => {
                const separator = reference.indexOf('/');
                if (separator <= 0) return undefined;
                const provider =
                  normalizedConfigurations[kind]?.providers[reference.slice(0, separator)];
                return provider?.models.find(model => model.id === reference.slice(separator + 1));
              };
              const selectedAsrModel = resolveCatalogModel(
                'speech-recognition',
                voice.onlineAsrModelRef,
              );
              const selectedTtsModel = resolveCatalogModel(
                'speech-synthesis',
                voice.onlineTtsModelRef,
              );
              const selectedTtsVoiceExists = selectedTtsModel?.voices?.some(
                candidate => candidate.id === voice.onlineTtsVoice,
              );
              normalizedVoice = {
                ...voice,
                ...(normalizedConfigurations['speech-recognition'] && !selectedAsrModel
                  ? { onlineAsrModelRef: '' }
                  : {}),
                ...(normalizedConfigurations['speech-synthesis'] && !selectedTtsModel
                  ? { onlineTtsModelRef: '', onlineTtsVoice: '' }
                  : selectedTtsModel && !selectedTtsVoiceExists
                    ? { onlineTtsVoice: '' }
                    : {}),
              };
              const currentProviders = normalizeProvidersForSave(
                normalizeProvidersForSettings({
                  ...getDefaultProviders(),
                  ...(currentConfig.providers ?? {}),
                }),
              );
              const update = buildSettingsAppConfigUpdate(currentConfig, {
                api: {
                  key: primaryProvider.apiKey,
                  baseUrl: primaryProvider.baseUrl,
                },
                providers: normalizedProviders,
                currentProviders,
                theme,
                appearance,
                language,
                useSystemProxy: proxyMode === ProxyMode.SYSTEM,
                proxy: normalizedProxy,
                developerMode,
                voice: normalizedVoice,
                shortcuts,
                onlineModelProviders: normalizedConfigurations,
              });
              const renamedDefaultProvider = resolveProviderKeyAfterRename(
                currentConfig.model.defaultModelProvider,
                currentConfig.providers,
                normalizedProviders,
              );
              if (renamedDefaultProvider !== currentConfig.model.defaultModelProvider) {
                update.model = {
                  ...currentConfig.model,
                  defaultModelProvider: renamedDefaultProvider,
                };
              }
              if (Object.keys(update).length > 0) {
                await configService.updateConfig(update);
              }
            },
          );
        },
        onAppConfigCommitted: () => {
          initialThemeRef.current = theme;
          initialThemeIdRef.current = themeService.getThemeId();
          initialAppearanceRef.current = appearance;
          initialLanguageRef.current = language;
        },
      });

      // 应用主题
      themeService.setTheme(theme);

      // 应用语言
      i18nService.setLanguage(language, { persist: false });

      setProviders(normalizedProviders);
      setActiveProvider(normalizedActiveProvider);
      setNonLanguageModelProviders(normalizedNonLanguageModelProviders);
      setVoice(normalizedVoice);

      // 更新 Redux store 中的可用模型列表
      const allModels: {
        id: string;
        name: string;
        provider?: string;
        providerKey?: string;
        supportsImage?: boolean;
        contextLength?: number;
        maxTokens?: number;
      }[] = [];
      Object.entries(normalizedProviders).forEach(([providerName, config]) => {
        if (config.enabled && config.models) {
          config.models.forEach(model => {
            if (model.enabled === false) {
              return;
            }
            allModels.push({
              id: model.id,
              name: model.name,
              provider: getProviderDisplayName(providerName, config),
              providerKey: providerName,
              supportsImage: model.supportsImage ?? false,
              contextLength: model.contextLength,
              maxTokens: model.maxTokens,
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));
      setSaveSucceeded(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : i18nService.t('settingsSaveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  // 标签页切换处理
  const handleTabChange = (tab: TabType) => {
    if (tab === activeTab) return;
    if (agentLeaveGuard.current && !agentLeaveGuard.current()) return;
    if (tab !== 'model') {
      setIsAddingModel(false);
      setIsEditingModel(false);
      setEditingModelId(null);
      setNewModelName('');
      setNewModelId('');
      setNewModelSupportsImage(false);
      setNewModelContextLength(undefined);
      setNewModelMaxTokens(undefined);
      setModelCapabilitiesInitiallyConfirmed(false);
      setModelCapabilitiesDirty(false);
      setModelFormError(null);
    }
    setActiveTab(tab);
  };

  // 快捷键更新处理
  const handleShortcutChange = (key: keyof ShortcutSettingsValue, value: string) => {
    // Check for conflicts with other shortcuts
    const conflictKey = findShortcutConflict(shortcuts, key, value);
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
    setModelCapabilitiesInitiallyConfirmed(false);
    setModelCapabilitiesDirty(false);
    setModelFormError(null);
  };

  const handleEditModel = (
    modelId: string,
    modelName: string,
    supportsImage?: boolean,
    contextLength?: number,
    maxTokens?: number,
    capabilitiesConfirmed?: boolean,
  ) => {
    if (isProviderReadOnly(activeProvider, providers[activeProvider])) {
      return;
    }

    setIsAddingModel(false);
    setIsEditingModel(true);
    setEditingModelId(modelId);
    setNewModelName(modelName);
    setNewModelId(modelId);
    const hasConfirmedCapabilities = hasConfirmedModelCapabilities({
      capabilitiesConfirmed,
      supportsImage,
      contextLength,
      maxTokens,
    });
    setNewModelSupportsImage(hasConfirmedCapabilities ? !!supportsImage : false);
    setNewModelContextLength(hasConfirmedCapabilities ? contextLength : undefined);
    setNewModelMaxTokens(hasConfirmedCapabilities ? maxTokens : undefined);
    setModelCapabilitiesInitiallyConfirmed(hasConfirmedCapabilities);
    setModelCapabilitiesDirty(false);
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

  const handleModelEnabledChange = (modelId: string, enabled: boolean) => {
    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: (prev[activeProvider].models ?? []).map(model =>
          model.id === modelId ? { ...model, enabled } : model,
        ),
      },
    }));
  };

  const handleSetAllModelsEnabled = (enabled: boolean) => {
    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: (prev[activeProvider].models ?? []).map(model => ({ ...model, enabled })),
      },
    }));
  };

  const handleSaveNewModel = () => {
    const modelId = newModelId.trim();
    const modelName = newModelName.trim();
    const currentModels = providers[activeProvider].models ?? [];
    const effectiveContextLength = newModelContextLength ?? DEFAULT_MODEL_CONTEXT_LENGTH;
    const effectiveMaxTokens = newModelMaxTokens ?? DEFAULT_MODEL_MAX_TOKENS;
    const validationError = validateModelForm({
      modelId,
      modelName,
      contextLength: effectiveContextLength,
      maxTokens: effectiveMaxTokens,
      existingModelIds: currentModels.map(model => model.id),
      editingModelId: isEditingModel ? editingModelId : null,
    });
    if (validationError) {
      setModelFormError(i18nService.t(validationError));
      return;
    }

    const capabilitiesConfirmed = modelCapabilitiesInitiallyConfirmed || modelCapabilitiesDirty;
    const existingModel = isEditingModel
      ? currentModels.find(model => model.id === editingModelId)
      : undefined;
    const nextModel = {
      id: modelId,
      name: modelName,
      enabled: existingModel?.enabled ?? true,
      capabilitiesConfirmed,
      ...(capabilitiesConfirmed
        ? {
            supportsImage: newModelSupportsImage,
            contextLength: effectiveContextLength,
            maxTokens: effectiveMaxTokens,
          }
        : {}),
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
    setModelCapabilitiesInitiallyConfirmed(false);
    setModelCapabilitiesDirty(false);
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
    setModelCapabilitiesInitiallyConfirmed(false);
    setModelCapabilitiesDirty(false);
    setModelFormError(null);
  };

  const handleModelDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelModelEdit();
      return;
    }
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault();
      handleSaveNewModel();
    }
  };

  const { handleTestConnection } = createModelConnectionTestActions({
    providers,
    setTestResult,
    setIsTestResultModalOpen,
    setModelConnectionTestStatuses,
    setProviders,
    cancelConnectionTest,
    activeProvider,
    connectionTestRef,
    setIsTesting,
    isDetectingModels,
    enableProvider,
  });

  const handleProxyModeChange = (mode: ProxyMode) => {
    setProxyMode(mode);
  };

  const handleCustomProxyChange = (key: keyof CustomProxyConfig, value: string) => {
    setCustomProxy(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  // 测试 API 连接

  // 渲染标签页
  const sidebarTabs: { key: TabType; label: string; icon: React.ReactNode }[] = [
    {
      key: 'general',
      label: i18nService.t('general'),
      icon: <Cog6ToothIcon className="h-5 w-5" />,
    },
    {
      key: 'appearance',
      label: i18nService.t('appearance'),
      icon: <PaintBrushIcon className="h-5 w-5" />,
    },
    {
      key: 'security',
      label: i18nService.t('securitySettings'),
      icon: <ShieldCheckIcon className="h-5 w-5" />,
    },
    {
      key: 'model',
      label: i18nService.t('model'),
      icon: <CubeIcon className="h-5 w-5" />,
    },
    {
      key: 'agents',
      label: i18nService.t('agentManager'),
      icon: <CpuChipIcon className="h-5 w-5" />,
    },
    {
      key: 'runtime',
      label: i18nService.t('agentRuntimeTab'),
      icon: <CpuChipIcon className="h-5 w-5" />,
    },
    {
      key: 'voice',
      label: i18nService.t('voiceSettings'),
      icon: <MicrophoneIcon className="h-5 w-5" />,
    },
    {
      key: 'browser',
      label: i18nService.t('browserSettings'),
      icon: <GlobeAltIcon className="h-5 w-5" />,
    },
    {
      key: 'usage',
      label: i18nService.t('usageStats'),
      icon: <ChartBarIcon className="h-5 w-5" />,
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
      key: 'integrations',
      label: i18nService.t('integrationsTab'),
      icon: <PuzzlePieceIcon className="h-5 w-5" />,
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
  const activeTabContentWidth = (() => {
    switch (activeTab) {
      case 'appearance':
      case 'model':
      case 'browser':
      case 'im':
        return 'max-w-[1440px]';
      case 'usage':
      case 'runtime':
      case 'integrations':
        return 'max-w-7xl';
      default:
        return 'max-w-4xl';
    }
  })();

  const renderTabContent = () => {
    switch (activeTab) {
      case 'agents':
        return <AgentManager leaveGuard={agentLeaveGuard} />;
      case 'general':
        return (
          <GeneralSettingsPage
            language={language}
            setLanguage={setLanguage}
            autoLaunch={autoLaunch}
            isUpdatingAutoLaunch={isUpdatingAutoLaunch}
            setIsUpdatingAutoLaunch={setIsUpdatingAutoLaunch}
            setAutoLaunchState={setAutoLaunchState}
            setError={setError}
            preventSleep={preventSleep}
            isUpdatingPreventSleep={isUpdatingPreventSleep}
            setIsUpdatingPreventSleep={setIsUpdatingPreventSleep}
            setPreventSleepState={setPreventSleepState}
            developerModeAvailable={developerModeAvailable}
            developerMode={developerMode}
            setDeveloperMode={setDeveloperMode}
            proxyMode={proxyMode}
            handleProxyModeChange={handleProxyModeChange}
            customProxy={customProxy}
            handleCustomProxyChange={handleCustomProxyChange}
            isSaving={isSaving}
            openClawGatewayPortInputRef={openClawGatewayPortInputRef}
            openClawGatewayPortInput={openClawGatewayPortInput}
            openClawGatewayPortEditing={openClawGatewayPortEditing}
            setOpenClawGatewayPortEditing={setOpenClawGatewayPortEditing}
            setOpenClawGatewayPortError={setOpenClawGatewayPortError}
            setOpenClawGatewayPortInput={setOpenClawGatewayPortInput}
            openClawGatewayPortValidation={openClawGatewayPortValidation}
            handleSaveOpenClawGatewayPort={handleSaveOpenClawGatewayPort}
            cancelOpenClawGatewayPortEditing={cancelOpenClawGatewayPortEditing}
            openClawGatewayPortValidationError={openClawGatewayPortValidationError}
            openClawGatewayPortSaving={openClawGatewayPortSaving}
            handleRestartOpenClawGateway={handleRestartOpenClawGateway}
            isRestartingOpenClawGateway={isRestartingOpenClawGateway}
            openClawGatewayPortError={openClawGatewayPortError}
            openClawGatewayPortRestartRequired={openClawGatewayPortRestartRequired}
          />
        );

      case 'appearance':
        return (
          <AppearancePreferences
            appearance={appearance}
            setAppearance={setAppearance}
            theme={theme}
            setTheme={setTheme}
            setThemeId={setThemeId}
            themeId={themeId}
          />
        );

      case 'model':
        return (
          <ModelSettingsTab
            activeKind={activeModelKind}
            onKindChange={setActiveModelKind}
            languageSettings={{
              activeProvider,
              providers,
              isTesting,
              displayNameError,
              providerRequiresApiKey,
              isProviderReadOnly,
              getProviderDefaultBaseUrl,
              handleProviderChange,
              handleProviderConfigChange,
              toggleProviderEnabled,
              handleAddCustomProvider,
              handleAddModel,
              handleDetectModels,
              handleEditModel,
              handleDeleteModel,
              handleModelEnabledChange,
              handleSetAllModelsEnabled,
              handleTestConnection: () => handleTestConnection(),
              handleTestModelConnection: modelId => handleTestConnection(modelId),
              handleRefreshBuiltinModels,
              isRefreshingBuiltinModels,
              isDetectingModels,
              modelDiscoveryMessage,
              modelConnectionTestStatuses: modelConnectionTestStatuses[activeProvider] ?? {},
              setDisplayNameError,
              setProviders,
              setError,
              onRequestDeleteProvider: setPendingDeleteProvider,
            }}
            nonLanguageSettings={{
              categories: nonLanguageModelProviders,
              setCategory: setNonLanguageModelCategory,
              setCategories: setNonLanguageModelProviders,
            }}
          />
        );

      case 'usage':
        return <UsageStatsTab />;

      case 'runtime':
        return (
          <AgentRuntimeSettingsTab
            settings={agentRuntimeSettings}
            models={agentRuntimeModels}
            isLoading={agentRuntimeSettingsLoading}
            loadError={agentRuntimeSettingsLoadError}
            onChange={setAgentRuntimeSettings}
            onRetry={() => void loadAgentRuntimeSettings()}
            maxRetainedDisplayTabs={maxRetainedDisplayTabs}
            onMaxRetainedDisplayTabsChange={setMaxRetainedDisplayTabs}
            maxGoalContinuationTurns={maxGoalContinuationTurns}
            onMaxGoalContinuationTurnsChange={setMaxGoalContinuationTurns}
          />
        );

      case 'integrations':
        return (
          <IntegrationSettingsTab
            activeView={activeIntegrationView}
            onViewChange={setActiveIntegrationView}
            externalAgentSettings={externalAgentSettings}
            onExternalAgentSettingsChange={setExternalAgentSettings}
            externalAgentSettingsLoading={externalAgentSettingsLoading}
            externalAgentSettingsLoadError={externalAgentSettingsLoadError}
            onExternalAgentSettingsRetry={() => void loadExternalAgentSettings()}
          />
        );

      case 'security':
        return <WindowsSandboxSettingsTab />;

      case 'browser':
        return <BrowserSettingsTab initialPage={browserPage} />;
      case 'voice':
        return <VoiceSettingsTab value={voice} onChange={setVoice} />;

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
          <div className="space-y-8">
            <section className="space-y-3">
              <h3 className="text-lg font-semibold text-foreground">{i18nService.t('about')}</h3>
              <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface-raised/50 p-5 shadow-subtle">
                <div
                  className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-3xl"
                  aria-hidden="true"
                />
                <div className="relative flex items-center gap-4">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-border/50 bg-surface p-2.5 shadow-card">
                    <img src={appLogoUrl} alt="" className="h-full w-full object-contain" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h4 className="text-xl font-semibold tracking-tight text-foreground">
                        {APP_NAME}
                      </h4>
                      <span className="rounded-full border border-primary/20 bg-primary-muted px-2.5 py-0.5 text-xs font-medium text-primary">
                        {appVersion}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm leading-6 text-secondary">
                      {i18nService.t('appAboutDescription')}
                    </p>
                  </div>
                </div>
              </div>
            </section>
            <AppUpdateSection />
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      <WindowHeader />
      <div className="relative flex h-9 shrink-0 select-none items-center border-b border-border-subtle bg-surface-raised">
        <div className="flex min-w-0 items-center gap-2 pl-2 pr-3">
          <button
            type="button"
            onClick={handleCloseSettings}
            className="non-draggable flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface hover:text-foreground"
            aria-label={i18nService.t('back')}
            title={i18nService.t('back')}
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <h2 className="truncate text-sm font-semibold text-foreground">
            {i18nService.t('settings')}
          </h2>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
        {/* Left navigation */}
        <div
          className="flex shrink-0 flex-col overflow-hidden bg-surface-raised/60"
          style={{ width: sidebarWidth }}
        >
          <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-3">
            {sidebarTabs.map(tab => (
              <button
                key={tab.key}
                type="button"
                onClick={() => handleTabChange(tab.key)}
                className={`flex h-9 shrink-0 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'bg-primary-muted text-primary'
                    : 'text-secondary hover:bg-surface hover:text-foreground'
                }`}
              >
                <span className="flex h-5 w-5 items-center justify-center [&>svg]:h-[18px] [&>svg]:w-[18px]">
                  {tab.icon}
                </span>
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div
          className="group relative z-10 w-px shrink-0 cursor-col-resize bg-border-subtle after:absolute after:inset-y-0 after:-left-1 after:w-2"
          onMouseDown={event =>
            startHorizontalResize(event, sidebarWidth, setSidebarWidth, 180, 340)
          }
          role="separator"
          aria-orientation="vertical"
          aria-label={i18nService.t('resizePanels')}
          title={i18nService.t('resizePanels')}
        >
          <div className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-primary" />
        </div>

        {/* Right content */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {/* Page header */}
          <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border-subtle px-6">
            <h3 className="text-lg font-semibold text-foreground">
              {activeTab === 'general' ? (
                <button
                  type="button"
                  className="select-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() =>
                    setGeneralTitleClicks(count =>
                      Math.min(count + 1, DEVELOPER_MODE_REVEAL_CLICKS),
                    )
                  }
                >
                  {activeTabLabel}
                </button>
              ) : (
                activeTabLabel
              )}
            </h3>
            <div className="flex min-w-0 items-center gap-2">
              {((activeTab === 'runtime' && agentRuntimeSettingsDirty) ||
                (activeTab === 'integrations' &&
                  activeIntegrationView === IntegrationSettingsView.AgentDelegation &&
                  externalAgentSettingsDirty)) && (
                <div className="mr-1 hidden items-center gap-2 sm:flex">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  <span className="text-xs font-medium text-secondary">
                    {i18nService.t('agentRuntimeUnsaved')}
                  </span>
                </div>
              )}
              {activeTab === 'runtime' && (
                <button
                  type="button"
                  onClick={() => setAgentRuntimeSettings(createDefaultAgentRuntimeSettings())}
                  className="non-draggable inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-surface-raised hover:text-primary active:scale-[0.98]"
                >
                  <ArrowPathIcon className="h-3.5 w-3.5" />
                  {i18nService.t('agentRuntimeRestoreDefaults')}
                </button>
              )}
              {activeTab === 'integrations' &&
                activeIntegrationView === IntegrationSettingsView.AgentDelegation && (
                  <button
                    type="button"
                    onClick={() => setExternalAgentSettings(createDefaultExternalAgentSettings())}
                    className="non-draggable inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-surface-raised hover:text-primary active:scale-[0.98]"
                  >
                    <ArrowPathIcon className="h-3.5 w-3.5" />
                    {i18nService.t('agentRuntimeRestoreDefaults')}
                  </button>
                )}
            </div>
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

          <form
            onSubmit={event => {
              if (activeTab === 'agents') event.preventDefault();
              else void handleSubmit(event);
            }}
            className="flex flex-col flex-1 overflow-hidden"
          >
            {/* Tab content */}
            <div
              ref={contentRef}
              className="flex-1 overflow-y-auto px-6 py-5"
              style={{ scrollbarGutter: 'stable' }}
            >
              <div className={`mx-auto w-full ${activeTabContentWidth}`}>{renderTabContent()}</div>
            </div>

            {/* Footer buttons */}
            <div
              className={
                activeTab === 'agents'
                  ? 'hidden'
                  : 'flex shrink-0 justify-end gap-2 border-t border-border-subtle px-5 py-3'
              }
            >
              <button
                type="button"
                onClick={handleCloseSettings}
                className="h-9 rounded-xl border border-border bg-background px-4 text-sm font-medium text-secondary shadow-sm transition-all hover:bg-surface-raised hover:text-foreground active:scale-[0.98]"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="submit"
                aria-busy={isSaving}
                disabled={
                  isSaving ||
                  (activeTab === 'runtime' &&
                    (agentRuntimeSettingsLoading || !initialAgentRuntimeSettings)) ||
                  (activeTab === 'integrations' &&
                    activeIntegrationView === IntegrationSettingsView.AgentDelegation &&
                    (externalAgentSettingsLoading || !initialExternalAgentSettings))
                }
                className={`inline-flex h-9 min-w-[88px] items-center justify-center gap-1.5 rounded-xl px-5 text-sm font-medium text-white shadow-sm transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${
                  saveSucceeded
                    ? 'bg-green-600 hover:bg-green-600'
                    : 'bg-primary hover:bg-primary-hover hover:shadow-card'
                }`}
              >
                <span className="inline-flex items-center gap-1.5" aria-live="polite">
                  {isSaving ? (
                    <>
                      <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
                      {i18nService.t('saving')}
                    </>
                  ) : saveSucceeded ? (
                    <>
                      <CheckCircleIcon className="h-4 w-4 animate-scale-in" aria-hidden="true" />
                      {i18nService.t('settingsSaved')}
                    </>
                  ) : (
                    i18nService.t('save')
                  )}
                </span>
              </button>
            </div>
          </form>
        </div>

        {isTestResultModalOpen && testResult && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
            onClick={e => {
              if (e.target === e.currentTarget) {
                handleCloseTestResultModal();
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
                  onClick={handleCloseTestResultModal}
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
                  stream=false · timeout={MODEL_CONNECTION_TEST_TIMEOUT_MS / 1000}s
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
                  onClick={handleCloseTestResultModal}
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
                <div className="rounded-xl border border-border bg-surface p-3">
                  <div className="mb-2">
                    <div>
                      <h5 className="text-xs font-semibold text-foreground">
                        {i18nService.t('modelCapabilities')}
                      </h5>
                      <p className="mt-0.5 text-[10px] text-muted">
                        {i18nService.t('modelCapabilitiesHint')}
                      </p>
                    </div>
                  </div>
                  {!modelCapabilitiesInitiallyConfirmed && (
                    <div className="mb-3 flex gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-2.5 py-2 text-red-600 dark:text-red-400">
                      <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                      <p className="text-[10px] leading-4">
                        {i18nService.t('modelCapabilitiesConfirmationWarning')}
                      </p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        {i18nService.t('contextLength')}
                      </label>
                      <input
                        type="number"
                        value={newModelContextLength ?? ''}
                        onChange={e => {
                          const val = e.target.value;
                          setNewModelContextLength(val === '' ? undefined : Number(val));
                          setModelCapabilitiesDirty(true);
                        }}
                        className="block w-full rounded-xl bg-surface-inset border-border border px-3 py-2 text-xs text-foreground placeholder:text-muted focus:border-primary focus:ring-1 focus:ring-primary/30"
                        placeholder={i18nService.t('defaultContextLengthPlaceholder')}
                        min={1}
                        step={1}
                      />
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
                          setNewModelMaxTokens(val === '' ? undefined : Number(val));
                          setModelCapabilitiesDirty(true);
                        }}
                        className="block w-full rounded-xl bg-surface-inset border-border border px-3 py-2 text-xs text-foreground placeholder:text-muted focus:border-primary focus:ring-1 focus:ring-primary/30"
                        placeholder={i18nService.t('defaultMaxTokensPlaceholder')}
                        min={1}
                        step={1}
                      />
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] text-muted">
                    {i18nService.t('modelTokenDefaultsHint')}
                  </p>
                  <label className="mt-3 flex cursor-pointer items-center justify-between rounded-lg bg-surface-inset px-3 py-2">
                    <span className="flex items-baseline gap-1.5 text-xs text-secondary">
                      {i18nService.t('supportsImageInput')}
                      {!modelCapabilitiesInitiallyConfirmed && !modelCapabilitiesDirty && (
                        <span className="text-[10px] text-muted">
                          {i18nService.t('defaultImageInputOff')}
                        </span>
                      )}
                    </span>
                    <input
                      id={`${activeProvider}-supportsImage`}
                      type="checkbox"
                      checked={newModelSupportsImage}
                      onChange={e => {
                        setNewModelSupportsImage(e.target.checked);
                        setModelCapabilitiesDirty(true);
                      }}
                      className="h-3.5 w-3.5 text-primary focus:ring-primary bg-surface border-border rounded"
                    />
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
    </div>
  );
};

export default Settings;
