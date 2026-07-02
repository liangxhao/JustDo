import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  CubeIcon,
  SignalIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { PlusIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { DEFAULT_OPENCLAW_GATEWAY_PORT } from '../../shared/openclaw/constants';
import {
  type AppConfig,
  defaultConfig,
  getCustomProviderDefaultName,
  getProviderDisplayName,
  getVisibleProviders,
  isBuiltinModelsProvider,
  isCustomProvider,
  validateDisplayName,
} from '../config';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../constants/app';
import { agentService } from '../services/agent';
import { configService } from '../services/config';
import { coworkService } from '../services/cowork';
import {
  decryptSecret,
  decryptWithPassword,
  EncryptedPayload,
  encryptWithPassword,
  PasswordEncryptedPayload,
} from '../services/encryption';
import { i18nService, LanguageType } from '../services/i18n';
import { themeService } from '../services/theme';
import { RootState } from '../store';
import { selectCoworkConfig } from '../store/selectors/coworkSelectors';
import { setAvailableModels } from '../store/slices/modelSlice';
import type { PresetAgent } from '../types/agent';
import type { CoworkAgentEngine, OpenClawEngineStatus } from '../types/cowork';
import AgentCreateModal from './agent/AgentCreateModal';
import AgentSettingsPanel from './agent/AgentSettingsPanel';
import Modal from './common/Modal';
import ErrorMessage from './ErrorMessage';
import PencilIcon from './icons/PencilIcon';
import PlusCircleIcon from './icons/PlusCircleIcon';
import { CustomProviderIcon, OllamaIcon } from './icons/providers';
import TrashIcon from './icons/TrashIcon';
import ShortcutsSettings, {
  shortcutLabelMap,
  type ShortcutSettingsValue,
} from './settings/ShortcutsSettings';
import ThemedSelect from './ui/ThemedSelect';

type TabType = 'general' | 'model' | 'myAgents' | 'im' | 'shortcuts' | 'help';

const isSettingsTabEnabled = (tab: TabType): boolean => tab !== 'myAgents';
const getEnabledSettingsTab = (tab?: TabType): TabType =>
  tab && isSettingsTabEnabled(tab) ? tab : 'general';

export type SettingsOpenOptions = {
  initialTab?: TabType;
  notice?: string;
  noticeI18nKey?: string;
  noticeExtra?: string;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
}

const BUILTIN_PROVIDER_KEYS = ['ollama'] as const;

type BuiltinProviderType = (typeof BUILTIN_PROVIDER_KEYS)[number];
type ProviderType = string;
type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type Model = NonNullable<ProviderConfig['models']>[number];
type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
  providerName: string;
  baseUrl?: string;
  modelLabel?: string;
  modelId?: string;
  log?: string;
};

interface ProviderExportEntry {
  enabled: boolean;
  apiKey: PasswordEncryptedPayload;
  baseUrl: string;
  apiFormat?: 'openai';
  models?: Model[];
  /** Display name shown in UI (for custom providers: displayName, for built-in: label) */
  displayName?: string;
}

interface ProvidersExportPayload {
  type: typeof EXPORT_FORMAT_TYPE;
  version: 2;
  exportedAt: string;
  encryption: {
    algorithm: 'AES-GCM';
    keySource: 'password';
    keyDerivation: 'PBKDF2';
  };
  providers: Record<string, ProviderExportEntry>;
}

interface ProvidersImportEntry {
  enabled?: boolean;
  apiKey?: EncryptedPayload | PasswordEncryptedPayload | string;
  apiKeyEncrypted?: string;
  apiKeyIv?: string;
  baseUrl?: string;
  apiFormat?: 'openai';
  models?: Model[];
  displayName?: string;
}

interface ProvidersImportPayload {
  type?: string;
  version?: number;
  encryption?: {
    algorithm?: string;
    keySource?: string;
    keyDerivation?: string;
  };
  providers?: Record<string, ProvidersImportEntry>;
}

const providerMeta: Record<BuiltinProviderType, { label: string; icon: React.ReactNode }> = {
  ollama: { label: 'Ollama', icon: <OllamaIcon /> },
};

const providerLinks: Partial<Record<ProviderType, { website: string; apiKey?: string }>> = {
  ollama: { website: 'https://ollama.com' },
};

const providerRequiresApiKey = (provider: ProviderType) => provider !== 'ollama';
const isProviderReadOnly = (provider: ProviderType, config?: ProviderConfig): boolean =>
  isBuiltinModelsProvider(provider) || config?.readonly === true;
const getProviderDefaultBaseUrl = (provider: ProviderType): string | null =>
  defaultConfig.providers?.[provider]?.baseUrl ?? null;
const resolveBaseUrl = (provider: ProviderType, baseUrl: string): string => {
  if (baseUrl.trim()) {
    return baseUrl;
  }
  return getProviderDefaultBaseUrl(provider) || '';
};
const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

const getProviderLabel = (provider: ProviderType, config?: ProviderConfig): string => {
  if (isBuiltinModelsProvider(provider)) {
    return i18nService.t('builtinModelsProvider');
  }
  if (isCustomProvider(provider)) {
    return config?.displayName || getCustomProviderDefaultName(provider);
  }
  return (
    providerMeta[provider as BuiltinProviderType]?.label ?? getProviderDisplayName(provider, config)
  );
};

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
  return firstEnabledProvider ?? BUILTIN_PROVIDER_KEYS[0];
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

/* ── My Agents Settings Component ─────────────────────────── */

const MyAgentsSettings: React.FC = () => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const [presets, setPresets] = useState<PresetAgent[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [addingPreset, setAddingPreset] = useState<string | null>(null);

  useEffect(() => {
    agentService.loadAgents();
    agentService.getPresets().then(setPresets);
  }, []);

  // Refresh presets when agents change
  useEffect(() => {
    agentService.getPresets().then(setPresets);
  }, [agents]);

  const enabledAgents = agents.filter(a => a.enabled && a.id !== 'main');
  const presetAgents = enabledAgents.filter(a => a.source === 'preset');
  const customAgents = enabledAgents.filter(a => a.source === 'custom');
  const uninstalledPresets = presets.filter(p => !p.installed);

  const handleAddPreset = async (presetId: string) => {
    setAddingPreset(presetId);
    try {
      await agentService.addPreset(presetId);
    } finally {
      setAddingPreset(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Subtitle */}
      <p className="text-sm text-secondary">{i18nService.t('agentsSubtitle')}</p>

      {/* Preset Agents Section */}
      {(presetAgents.length > 0 || uninstalledPresets.length > 0) && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-foreground">{i18nService.t('presetAgents')}</h4>
          <div className="grid grid-cols-2 gap-3">
            {/* Installed presets */}
            {presetAgents.map(agent => (
              <AgentCard
                key={agent.id}
                icon={agent.icon}
                name={agent.name}
                description={agent.description}
                isActive={agent.id === currentAgentId}
                onClick={() => setSettingsAgentId(agent.id)}
              />
            ))}
            {/* Uninstalled presets */}
            {uninstalledPresets.map(preset => {
              const isEn = i18nService.getLanguage() === 'en';
              return (
                <UninstalledPresetCard
                  key={preset.id}
                  icon={preset.icon}
                  name={isEn && preset.nameEn ? preset.nameEn : preset.name}
                  description={
                    isEn && preset.descriptionEn ? preset.descriptionEn : preset.description
                  }
                  isAdding={addingPreset === preset.id}
                  onAdd={() => handleAddPreset(preset.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Custom Agents Section */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-foreground">{i18nService.t('myCustomAgents')}</h4>
        <div className="grid grid-cols-2 gap-3">
          {customAgents.map(agent => (
            <AgentCard
              key={agent.id}
              icon={agent.icon}
              name={agent.name}
              description={agent.description}
              isActive={agent.id === currentAgentId}
              onClick={() => setSettingsAgentId(agent.id)}
            />
          ))}
          {/* Create new agent card */}
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed border-border hover:border-primary hover:bg-primary/5 transition-colors min-h-[120px] cursor-pointer"
          >
            <div className="w-8 h-8 rounded-full flex items-center justify-center bg-primary/10">
              <PlusIcon className="h-4 w-4 text-primary" />
            </div>
            <span className="text-sm font-medium text-primary">
              {i18nService.t('createNewAgent')}
            </span>
          </button>
        </div>
      </div>

      {/* Modals */}
      <AgentCreateModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
      <AgentSettingsPanel agentId={settingsAgentId} onClose={() => setSettingsAgentId(null)} />
    </div>
  );
};

/* ── Agent Card (installed) ─────────────────────────── */

const AgentCard: React.FC<{
  icon: string;
  name: string;
  description: string;
  isActive: boolean;
  onClick: () => void;
}> = ({ icon, name, description, isActive, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex flex-col items-start gap-1.5 p-3 rounded-xl border-2 text-left transition-all min-h-[120px] hover:shadow-md hover:bg-surface-raised ${
      isActive ? 'border-primary bg-primary/5' : 'border-border'
    }`}
  >
    <span className="text-2xl">{icon || '🤖'}</span>
    <div className="min-w-0 w-full">
      <div className="text-sm font-semibold text-foreground truncate">{name}</div>
      {description && (
        <div className="text-xs text-secondary mt-0.5 line-clamp-2">{description}</div>
      )}
    </div>
  </button>
);

/* ── Uninstalled Preset Card ─────────────────────────── */

const UninstalledPresetCard: React.FC<{
  icon: string;
  name: string;
  description: string;
  isAdding: boolean;
  onAdd: () => void;
}> = ({ icon, name, description, isAdding, onAdd }) => (
  <div className="flex flex-col items-start gap-1.5 p-3 rounded-xl border-2 border-dashed border-border opacity-60 hover:opacity-80 transition-opacity min-h-[120px]">
    <span className="text-2xl">{icon || '🤖'}</span>
    <div className="min-w-0 w-full flex-1">
      <div className="text-sm font-semibold text-foreground truncate">{name}</div>
      {description && (
        <div className="text-xs text-secondary mt-0.5 line-clamp-2">{description}</div>
      )}
    </div>
    <button
      type="button"
      onClick={onAdd}
      disabled={isAdding}
      className="self-end px-2.5 py-1 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors"
    >
      {isAdding ? '...' : i18nService.t('addAgent')}
    </button>
  </div>
);

/** Format context length number to a human-readable string like "200k" */
const formatContextLength = (tokens: number): string => {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${tokens / 1_000}k`;
  return `${tokens}`;
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
  const [useSystemProxy, setUseSystemProxy] = useState(false);
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
  const [isImportingProviders, setIsImportingProviders] = useState(false);
  const [isExportingProviders, setIsExportingProviders] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [providerListWidth, setProviderListWidth] = useState(260);
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
  const [showApiKey, setShowApiKey] = useState(false);

  // Add state for providers configuration
  const [providers, setProviders] = useState<ProvidersConfig>(() => getDefaultProviders());

  const isBaseUrlLocked = false;

  // 创建引用来确保内容区域的滚动
  const contentRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    setShowApiKey(false);
  }, [activeProvider]);

  const coworkConfig = useSelector(selectCoworkConfig);

  const [coworkAgentEngine, setCoworkAgentEngine] = useState<CoworkAgentEngine>(
    coworkConfig.agentEngine || 'openclaw',
  );

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
  const [openClawEngineStatus] = useState<OpenClawEngineStatus | null>(null);

  useEffect(() => {
    setCoworkAgentEngine(coworkConfig.agentEngine || 'openclaw');
  }, [coworkConfig.agentEngine]);

  // Load OpenClaw gateway port
  useEffect(() => {
    window.electron.openclaw.engine.getPort().then(result => {
      if (result.success && result.port) {
        setOpenClawGatewayPort(result.port);
        setOpenClawGatewayPortInput(String(result.port));
      }
    });
  }, []);

  const handleSaveOpenClawGatewayPort = async () => {
    const port = parseInt(openClawGatewayPortInput, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return;
    }
    setOpenClawGatewayPortSaving(true);
    try {
      const result = await window.electron.openclaw.engine.setPort(port);
      if (result.success) {
        setOpenClawGatewayPort(port);
        setOpenClawGatewayPortEditing(false);
      }
    } finally {
      setOpenClawGatewayPortSaving(false);
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
      setUseSystemProxy(config.useSystemProxy ?? false);

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
    } catch (error) {
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
    setShowApiKey(false);
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  // Handle deleting a custom provider
  const handleDeleteCustomProvider = (key: ProviderType) => {
    setPendingDeleteProvider(key);
  };

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
      setActiveProvider(firstEnabled ?? visibleKeys[0] ?? BUILTIN_PROVIDER_KEYS[0]);
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

  const hasCoworkConfigChanges = coworkAgentEngine !== coworkConfig.agentEngine;
  const isOpenClawAgentEngine = coworkAgentEngine === 'openclaw';
  const openClawProgressPercent: number | null = null;
  const resolveOpenClawStatusText = (_status: OpenClawEngineStatus | null): string =>
    i18nService.t('coworkOpenClawRunning');

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
      setError(i18nService.t('apiKeyRequired'));
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

      await configService.updateConfig({
        api: {
          key: primaryProvider.apiKey,
          baseUrl: primaryProvider.baseUrl,
        },
        providers: normalizedProviders, // Save all providers configuration
        theme,
        language,
        useSystemProxy,
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

      if (hasCoworkConfigChanges) {
        const updated = await coworkService.updateConfig({
          agentEngine: coworkAgentEngine,
        });
        if (!updated) {
          throw new Error(i18nService.t('coworkConfigSaveFailed'));
        }
      }

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

    if (activeProvider === 'ollama') {
      // For Ollama, only the model name (stored as modelId) is required
      if (!modelId) {
        setModelFormError(i18nService.t('ollamaModelNameRequired'));
        return;
      }
    } else {
      const modelName = newModelName.trim();
      if (!modelName || !modelId) {
        setModelFormError(i18nService.t('modelNameAndIdRequired'));
        return;
      }
    }

    // For Ollama, auto-fill display name from modelId if not provided
    const modelName =
      activeProvider === 'ollama'
        ? newModelName.trim() && newModelName.trim() !== modelId
          ? newModelName.trim()
          : modelId
        : newModelName.trim();

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
    setTestResult({
      ...result,
      provider,
      providerName:
        providerMeta[provider as BuiltinProviderType]?.label ??
        getProviderDisplayName(provider, providerConfig),
    });
    setIsTestResultModalOpen(true);
  };

  // 测试 API 连接
  const handleTestConnection = async () => {
    const testingProvider = activeProvider;
    const providerConfig = providers[testingProvider];
    setIsTesting(true);
    setIsTestResultModalOpen(false);
    setTestResult(null);

    // Check if provider has valid authentication
    if (providerRequiresApiKey(testingProvider) && !providerConfig.apiKey) {
      showTestResultModal(
        { success: false, message: i18nService.t('apiKeyRequired') },
        testingProvider,
      );
      setIsTesting(false);
      return;
    }

    // 获取第一个可用模型 - use a shallow copy to avoid mutating state
    const originalModel = providerConfig.models?.[0];
    if (!originalModel) {
      showTestResultModal(
        { success: false, message: i18nService.t('noModelsConfigured') },
        testingProvider,
      );
      setIsTesting(false);
      return;
    }

    const firstModel = { ...originalModel };
    const modelLabel = firstModel.name?.trim() || firstModel.id;

    try {
      let response: Awaited<ReturnType<typeof window.electron.api.fetch>>;
      const effectiveBaseUrl = resolveBaseUrl(testingProvider, providerConfig.baseUrl);
      const normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
      const effectiveApiKey = providerConfig.apiKey;

      const openaiUrl = `${normalizedBaseUrl}/chat/completions`;
      const testContext = {
        baseUrl: normalizedBaseUrl,
        modelLabel,
        modelId: firstModel.id,
      };
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (effectiveApiKey) {
        headers.Authorization = `Bearer ${effectiveApiKey}`;
      }
      const openAIRequestBody: Record<string, unknown> = {
        model: firstModel.id,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
      };
      response = await window.electron.api.fetch({
        url: openaiUrl,
        method: 'POST',
        headers,
        body: JSON.stringify(openAIRequestBody),
      });

      if (response.ok) {
        enableProvider(testingProvider);
        showTestResultModal(
          {
            success: true,
            message: i18nService.t('connectionSuccess'),
            ...testContext,
          },
          testingProvider,
        );
      } else {
        const data = response.data || {};
        // 提取错误信息
        const errorMessage =
          data.error?.message ||
          data.message ||
          `${i18nService.t('connectionFailed')}: ${response.status}`;
        if (
          typeof errorMessage === 'string' &&
          errorMessage.toLowerCase().includes('model output limit was reached')
        ) {
          enableProvider(testingProvider);
          showTestResultModal(
            {
              success: true,
              message: i18nService.t('connectionSuccess'),
              ...testContext,
            },
            testingProvider,
          );
          return;
        }
        showTestResultModal(
          {
            success: false,
            message: errorMessage,
            ...testContext,
            log: [
              `${i18nService.t('testRequestUrl')}: ${openaiUrl}`,
              `${i18nService.t('testModel')}: ${modelLabel} (${firstModel.id})`,
              `${i18nService.t('testStatus')}: ${response.status}`,
              `${i18nService.t('testResponse')}: ${stringifyConnectivityLogValue(data)}`,
            ].join('\n'),
          },
          testingProvider,
        );
      }
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
          modelLabel,
          modelId: firstModel.id,
          log: [
            `${i18nService.t('testRequestUrl')}: ${effectiveBaseUrl}/chat/completions`,
            `${i18nService.t('testModel')}: ${modelLabel} (${firstModel.id})`,
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

  const buildProvidersExport = async (password: string): Promise<ProvidersExportPayload> => {
    const entries = await Promise.all(
      Object.entries(providers)
        .filter(([providerKey, providerConfig]) => !isProviderReadOnly(providerKey, providerConfig))
        .map(async ([providerKey, providerConfig]) => {
          const apiKey = await encryptWithPassword(providerConfig.apiKey, password);
          const isCustom = isCustomProvider(providerKey);
          const displayName = isCustom
            ? (providerConfig as ProviderConfig).displayName ||
              getCustomProviderDefaultName(providerKey)
            : (providerMeta[providerKey as BuiltinProviderType]?.label ??
              getProviderDisplayName(providerKey));
          return [
            providerKey,
            {
              enabled: providerConfig.enabled,
              apiKey,
              baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl),
              apiFormat: 'openai' as const,
              models: providerConfig.models,
              displayName,
            },
          ] as const;
        }),
    );

    return {
      type: EXPORT_FORMAT_TYPE,
      version: 2,
      exportedAt: new Date().toISOString(),
      encryption: {
        algorithm: 'AES-GCM',
        keySource: 'password',
        keyDerivation: 'PBKDF2',
      },
      providers: Object.fromEntries(entries),
    };
  };

  const normalizeModels = (models?: Model[]) =>
    models?.map(model => ({
      ...model,
      supportsImage: model.supportsImage ?? false,
    }));

  const DEFAULT_EXPORT_PASSWORD = EXPORT_PASSWORD;

  const handleExportProviders = async () => {
    setError(null);
    setIsExportingProviders(true);

    try {
      const payload = await buildProvidersExport(DEFAULT_EXPORT_PASSWORD);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_ID}-providers-${date}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      console.error('Failed to export providers:', err);
      setError(i18nService.t('exportProvidersFailed'));
    } finally {
      setIsExportingProviders(false);
    }
  };

  const handleImportProvidersClick = () => {
    importInputRef.current?.click();
  };

  const handleImportProviders = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    setError(null);

    try {
      const raw = await file.text();
      let payload: ProvidersImportPayload;
      try {
        payload = JSON.parse(raw) as ProvidersImportPayload;
      } catch (parseError) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      if (!payload || payload.type !== EXPORT_FORMAT_TYPE || !payload.providers) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if it's version 2 (password-based encryption)
      if (payload.version === 2 && payload.encryption?.keySource === 'password') {
        await processImportPayloadWithPassword(payload);
        return;
      }

      // Version 1 (legacy local-store key) - try to decrypt with local key
      if (payload.version === 1) {
        await processImportPayloadWithLocalKey(payload);
        return;
      }

      setError(i18nService.t('invalidProvidersFile'));
    } catch (err) {
      console.error('Failed to import providers:', err);
      setError(i18nService.t('importProvidersFailed'));
    }
  };

  const processImportPayloadWithLocalKey = async (payload: ProvidersImportPayload) => {
    setIsImportingProviders(true);
    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;

      // Iterate over all provider keys in the import payload
      const payloadProviderKeys = Object.keys(payload.providers || {});
      for (const providerKey of payloadProviderKeys) {
        if (isProviderReadOnly(providerKey, providers[providerKey])) {
          continue;
        }
        // For built-in providers, check if they exist in current config
        // For custom providers (custom_N), create new entry if not exists
        const isCustom = isCustomProvider(providerKey);
        if (!isCustom && !providers[providerKey]) {
          console.warn(`Skipping unknown built-in provider: ${providerKey}`);
          continue;
        }
        const providerData = payload.providers?.[providerKey];
        if (!providerData) {
          continue;
        }

        // For custom providers not yet in config, use empty defaults
        const currentConfig = providers[providerKey] || {
          enabled: false,
          apiKey: '',
          baseUrl: '',
          apiFormat: 'openai' as const,
          models: [],
        };

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          try {
            apiKey = await decryptSecret(providerData.apiKey as EncryptedPayload);
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        } else if (
          typeof providerData.apiKeyEncrypted === 'string' &&
          typeof providerData.apiKeyIv === 'string'
        ) {
          try {
            apiKey = await decryptSecret({
              encrypted: providerData.apiKeyEncrypted,
              iv: providerData.apiKeyIv,
            });
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        }

        const models = normalizeModels(providerData.models);

        providerUpdates[providerKey] = {
          enabled:
            typeof providerData.enabled === 'boolean'
              ? providerData.enabled
              : currentConfig.enabled,
          apiKey: apiKey ?? currentConfig.apiKey,
          baseUrl:
            typeof providerData.baseUrl === 'string' ? providerData.baseUrl : currentConfig.baseUrl,
          apiFormat: 'openai',
          models: models ?? currentConfig.models,
          ...(isCustom && providerData.displayName
            ? { displayName: providerData.displayName }
            : {}),
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError =
        err instanceof Error &&
        (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  const processImportPayloadWithPassword = async (payload: ProvidersImportPayload) => {
    if (!payload.providers) {
      return;
    }

    setIsImportingProviders(true);

    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;

      // Iterate over all provider keys in the import payload
      const payloadProviderKeys = Object.keys(payload.providers);
      for (const providerKey of payloadProviderKeys) {
        if (isProviderReadOnly(providerKey, providers[providerKey])) {
          continue;
        }
        // For built-in providers, check if they exist in current config
        // For custom providers (custom_N), create new entry if not exists
        const isCustom = isCustomProvider(providerKey);
        if (!isCustom && !providers[providerKey]) {
          console.warn(`Skipping unknown built-in provider: ${providerKey}`);
          continue;
        }
        const providerData = payload.providers[providerKey];
        if (!providerData) {
          continue;
        }

        // For custom providers not yet in config, use empty defaults
        const currentConfig = providers[providerKey] || {
          enabled: false,
          apiKey: '',
          baseUrl: '',
          apiFormat: 'openai' as const,
          models: [],
        };

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          const apiKeyObj = providerData.apiKey as PasswordEncryptedPayload;
          if (apiKeyObj.salt) {
            // Version 2 password-based encryption
            try {
              apiKey = await decryptWithPassword(apiKeyObj, DEFAULT_EXPORT_PASSWORD);
            } catch (error) {
              hadDecryptFailure = true;
              console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
            }
          }
        }

        const models = normalizeModels(providerData.models);

        providerUpdates[providerKey] = {
          enabled:
            typeof providerData.enabled === 'boolean'
              ? providerData.enabled
              : currentConfig.enabled,
          apiKey: apiKey ?? currentConfig.apiKey,
          baseUrl:
            typeof providerData.baseUrl === 'string' ? providerData.baseUrl : currentConfig.baseUrl,
          apiFormat: 'openai',
          models: models ?? currentConfig.models,
          ...(isCustom && providerData.displayName
            ? { displayName: providerData.displayName }
            : {}),
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if any key was successfully decrypted
      const anyKeyDecrypted = Object.entries(providerUpdates).some(
        ([key, update]) => update?.apiKey && update.apiKey !== providers[key]?.apiKey,
      );

      if (!anyKeyDecrypted && hadDecryptFailure) {
        // All decryptions failed - likely wrong password
        setError(i18nService.t('decryptProvidersFailed'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError =
        err instanceof Error &&
        (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  // 渲染标签页
  const sidebarTabs: { key: TabType; label: string; icon: React.ReactNode }[] = useMemo(() => {
    const allTabs = [
      {
        key: 'general' as TabType,
        label: i18nService.t('general'),
        icon: <Cog6ToothIcon className="h-5 w-5" />,
      },
      {
        key: 'model' as TabType,
        label: i18nService.t('model'),
        icon: <CubeIcon className="h-5 w-5" />,
      },
      {
        key: 'myAgents' as TabType,
        label: i18nService.t('myAgents'),
        icon: <UserGroupIcon className="h-5 w-5" />,
      },
      {
        key: 'im' as TabType,
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
        key: 'shortcuts' as TabType,
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
        key: 'help' as TabType,
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
    return allTabs.filter(tab => isSettingsTabEnabled(tab.key));
  }, [language]);

  const activeTabLabel = useMemo(() => {
    return sidebarTabs.find(t => t.key === activeTab)?.label ?? '';
  }, [activeTab, sidebarTabs]);

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

            {/* System proxy Section */}
            <div>
              <h4 className="text-sm font-medium text-foreground mb-3">
                {i18nService.t('useSystemProxy')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-secondary">
                  {i18nService.t('useSystemProxyDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useSystemProxy}
                  onClick={() => {
                    setUseSystemProxy(prev => !prev);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    useSystemProxy ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      useSystemProxy ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* Gateway Port Configuration */}
            <div className="space-y-3 rounded-xl border px-4 py-4 border-border">
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">
                  {i18nService.t('openclawGatewayPortTitle')}
                </div>
                <div className="text-xs text-secondary">
                  {i18nService.t('openclawGatewayPortHint')}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {openClawGatewayPortEditing ? (
                  <>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={openClawGatewayPortInput}
                      onChange={e => setOpenClawGatewayPortInput(e.target.value)}
                      className="w-32 rounded-lg border px-3 py-1.5 text-sm border-border bg-surface"
                      disabled={openClawGatewayPortSaving}
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveOpenClawGatewayPort()}
                      disabled={
                        openClawGatewayPortSaving ||
                        isNaN(parseInt(openClawGatewayPortInput, 10)) ||
                        parseInt(openClawGatewayPortInput, 10) < 1 ||
                        parseInt(openClawGatewayPortInput, 10) > 65535
                      }
                      className="px-3 py-1.5 text-sm font-medium rounded-lg bg-primary hover:bg-primary-hover text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {i18nService.t('save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenClawGatewayPortEditing(false);
                        setOpenClawGatewayPortInput(String(openClawGatewayPort));
                      }}
                      className="px-3 py-1.5 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                    >
                      {i18nService.t('cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="px-3 py-1.5 text-sm font-mono bg-surface-raised rounded-lg">
                      {openClawGatewayPort}
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpenClawGatewayPortEditing(true)}
                      className="px-3 py-1.5 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                    >
                      {i18nService.t('edit')}
                    </button>
                  </>
                )}
              </div>
            </div>

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
                const renderTile = (t: import('../theme').ThemeDefinition) => {
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

      case 'coworkAgentEngine' as TabType:
        return (
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-xl border px-3 py-2 text-sm border-border">
                <input type="radio" checked={true} readOnly className="mt-1" />
                <span>
                  <span className="block font-medium text-foreground">
                    {i18nService.t('coworkAgentEngineOpenClaw')}
                  </span>
                  <span className="block text-xs text-secondary">
                    {i18nService.t('coworkAgentEngineOpenClawHint')}
                  </span>
                </span>
              </div>
            </div>
            {isOpenClawAgentEngine && (
              <div className="space-y-3 rounded-xl border px-4 py-4 border-border">
                <div className="text-xs text-secondary">
                  {i18nService.t('coworkOpenClawInstallHint')}
                </div>
                <div
                  className={`rounded-xl border px-4 py-3 text-sm ${
                    openClawEngineStatus?.phase === 'error'
                      ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'
                      : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      {resolveOpenClawStatusText(openClawEngineStatus)}
                      {openClawProgressPercent !== null && (
                        <span className="ml-2 text-xs opacity-80">{openClawProgressPercent}%</span>
                      )}
                    </div>
                  </div>
                  {openClawProgressPercent !== null && (
                    <div className="mt-2 h-2 rounded-full bg-black/10 overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${openClawProgressPercent}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Gateway Port Configuration */}
            {isOpenClawAgentEngine && openClawEngineStatus?.phase === 'running' && (
              <div className="space-y-3 rounded-xl border px-4 py-4 border-border">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-foreground">
                      {i18nService.t('openclawGatewayPortTitle')}
                    </div>
                    <div className="text-xs text-secondary">
                      {i18nService.t('openclawGatewayPortHint')}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {openClawGatewayPortEditing ? (
                    <>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={openClawGatewayPortInput}
                        onChange={e => setOpenClawGatewayPortInput(e.target.value)}
                        className="w-32 rounded-lg border px-3 py-1.5 text-sm border-border bg-surface"
                        disabled={openClawGatewayPortSaving}
                      />
                      <button
                        type="button"
                        onClick={() => void handleSaveOpenClawGatewayPort()}
                        disabled={
                          openClawGatewayPortSaving ||
                          isNaN(parseInt(openClawGatewayPortInput, 10)) ||
                          parseInt(openClawGatewayPortInput, 10) < 1 ||
                          parseInt(openClawGatewayPortInput, 10) > 65535
                        }
                        className="px-3 py-1.5 text-sm font-medium rounded-lg bg-primary hover:bg-primary-hover text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {i18nService.t('save')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenClawGatewayPortEditing(false);
                          setOpenClawGatewayPortInput(String(openClawGatewayPort));
                        }}
                        className="px-3 py-1.5 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                      >
                        {i18nService.t('cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="px-3 py-1.5 text-sm font-mono bg-surface-raised rounded-lg">
                        {openClawGatewayPort}
                      </span>
                      <button
                        type="button"
                        onClick={() => setOpenClawGatewayPortEditing(true)}
                        className="px-3 py-1.5 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                      >
                        {i18nService.t('edit')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        );

      case 'model':
        return (
          <div className="flex h-full">
            {/* Provider List - Left Side */}
            <div
              className="shrink-0 pr-3 space-y-1.5 overflow-y-auto"
              style={{ width: providerListWidth }}
            >
              <div className="flex items-center justify-between mb-2 px-1">
                <h3 className="text-sm font-medium text-foreground">
                  {i18nService.t('modelProviders')}
                </h3>
                <div className="flex items-center space-x-1">
                  <button
                    type="button"
                    onClick={handleImportProvidersClick}
                    disabled={isImportingProviders || isExportingProviders}
                    className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {i18nService.t('import')}
                  </button>
                  <button
                    type="button"
                    onClick={handleExportProviders}
                    disabled={isImportingProviders || isExportingProviders}
                    className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {i18nService.t('export')}
                  </button>
                </div>
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImportProviders}
              />
              {Object.entries(visibleProviders).map(([provider, config]) => {
                const providerKey = provider as ProviderType;
                const isCustom = isCustomProvider(provider);
                const providerInfo =
                  providerMeta[providerKey as BuiltinProviderType] ??
                  (isCustom
                    ? {
                        label: getCustomProviderDefaultName(provider),
                        icon: <CustomProviderIcon />,
                      }
                    : undefined);
                const readOnlyProvider = isProviderReadOnly(providerKey, config);
                const missingApiKey = providerRequiresApiKey(providerKey) && !config.apiKey.trim();
                const canToggleProvider = !readOnlyProvider && (config.enabled || !missingApiKey);
                const displayLabel = getProviderLabel(providerKey, config);
                return (
                  <div
                    key={provider}
                    onClick={() => handleProviderChange(providerKey)}
                    className={`group flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                      activeProvider === provider
                        ? 'bg-primary-muted border border-primary shadow-subtle'
                        : 'bg-surface hover:bg-surface-raised border border-transparent'
                    }`}
                  >
                    <div className="flex flex-1 items-center min-w-0">
                      <div className="mr-2 flex h-7 w-7 items-center justify-center shrink-0">
                        <span className="text-foreground">
                          {isCustom ? <CustomProviderIcon /> : providerInfo?.icon}
                        </span>
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span
                          className={`text-sm font-medium truncate ${
                            activeProvider === provider ? 'text-primary' : 'text-foreground'
                          }`}
                        >
                          {displayLabel}
                        </span>
                        {isCustom && (
                          <span className="text-[9px] leading-tight mt-0.5 text-primary">
                            {i18nService.t('customBadge')}
                          </span>
                        )}
                        {readOnlyProvider && (
                          <span className="text-[9px] leading-tight mt-0.5 text-primary">
                            {i18nService.t('builtinModelsProvider')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center ml-2 gap-1">
                      {isCustom && (
                        <button
                          type="button"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-claude-secondaryText hover:text-red-500 dark:text-claude-darkSecondaryText dark:hover:text-red-400 p-0.5"
                          onClick={e => {
                            e.stopPropagation();
                            handleDeleteCustomProvider(providerKey);
                          }}
                          title={i18nService.t('deleteCustomProvider')}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            className="w-3.5 h-3.5"
                          >
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                          </svg>
                        </button>
                      )}
                      <div
                        title={!canToggleProvider ? i18nService.t('configureApiKey') : undefined}
                        className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                          config.enabled ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                        } ${
                          canToggleProvider ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                        }`}
                        onClick={e => {
                          e.stopPropagation();
                          if (!canToggleProvider) {
                            return;
                          }
                          toggleProviderEnabled(providerKey);
                        }}
                      >
                        <div
                          className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                            config.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* Add Custom Provider Button */}
              <button
                type="button"
                onClick={handleAddCustomProvider}
                className="w-full flex items-center justify-center p-2 rounded-xl border border-dashed border-claude-border dark:border-claude-darkBorder text-claude-secondaryText dark:text-claude-darkSecondaryText hover:border-claude-accent hover:text-claude-accent transition-colors text-sm"
              >
                {i18nService.t('addCustomProvider')}
              </button>
            </div>

            <div
              className="group relative w-3 shrink-0 cursor-col-resize"
              onMouseDown={event =>
                startHorizontalResize(event, providerListWidth, setProviderListWidth, 210, 420)
              }
              role="separator"
              aria-orientation="vertical"
              aria-label={i18nService.t('resizePanels')}
              title={i18nService.t('resizePanels')}
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary" />
            </div>

            {/* Provider Settings - Right Side */}
            <div className="min-w-0 flex-1 pl-2 pr-2 space-y-4 overflow-y-auto [scrollbar-gutter:stable]">
              <div className="flex items-center justify-between pb-2 border-b border-border">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-base font-medium text-foreground">
                    {getProviderLabel(activeProvider, providers[activeProvider])}{' '}
                    {i18nService.t('providerSettings')}
                  </h3>
                  {providerLinks[activeProvider]?.website && (
                    <button
                      type="button"
                      onClick={() =>
                        void window.electron.shell.openExternal(
                          providerLinks[activeProvider]!.website,
                        )
                      }
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('visitOfficialSite')}
                      aria-label={i18nService.t('visitOfficialSite')}
                    >
                      <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <div
                  className={`px-2 py-0.5 rounded-lg text-xs font-medium ${
                    providers[activeProvider].enabled
                      ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                      : 'bg-red-500/20 text-red-600 dark:text-red-400'
                  }`}
                >
                  {providers[activeProvider].enabled
                    ? i18nService.t('providerStatusOn')
                    : i18nService.t('providerStatusOff')}
                </div>
              </div>

              {isProviderReadOnly(activeProvider, providers[activeProvider]) && (
                <div className="rounded-xl border border-border bg-surface p-3 text-xs text-secondary">
                  {i18nService.t('builtinModelsReadOnlyHint')}
                </div>
              )}

              {/* Standard API key section */}
              {providerRequiresApiKey(activeProvider) &&
                !isProviderReadOnly(activeProvider, providers[activeProvider]) && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label
                        htmlFor={`${activeProvider}-apiKey`}
                        className="block text-xs font-medium dark:text-claude-darkText text-claude-text"
                      >
                        {i18nService.t('apiKey')}
                      </label>
                      {providerLinks[activeProvider]?.apiKey && (
                        <button
                          type="button"
                          onClick={() =>
                            void window.electron.shell.openExternal(
                              providerLinks[activeProvider]!.apiKey!,
                            )
                          }
                          className="text-[11px] text-claude-accent hover:underline transition-colors"
                        >
                          {i18nService.t('getApiKey')} →
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        id={`${activeProvider}-apiKey`}
                        value={providers[activeProvider].apiKey}
                        onChange={e =>
                          handleProviderConfigChange(activeProvider, 'apiKey', e.target.value)
                        }
                        className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-xs"
                        placeholder={i18nService.t('apiKeyPlaceholder')}
                      />
                      <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                        {providers[activeProvider].apiKey && (
                          <button
                            type="button"
                            onClick={() => handleProviderConfigChange(activeProvider, 'apiKey', '')}
                            className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                            title={i18nService.t('clear') || 'Clear'}
                          >
                            <XCircleIconSolid className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                          title={
                            showApiKey
                              ? i18nService.t('hide') || 'Hide'
                              : i18nService.t('show') || 'Show'
                          }
                        >
                          {showApiKey ? (
                            <EyeIcon className="h-4 w-4" />
                          ) : (
                            <EyeSlashIcon className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

              {isCustomProvider(activeProvider) && (
                <div>
                  <label
                    htmlFor={`${activeProvider}-displayName`}
                    className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1"
                  >
                    {i18nService.t('customDisplayName')}
                  </label>
                  <input
                    type="text"
                    id={`${activeProvider}-displayName`}
                    value={(providers[activeProvider] as ProviderConfig)?.displayName ?? ''}
                    onChange={e => {
                      const value = e.target.value;
                      const validation = validateDisplayName(value);
                      setDisplayNameError(validation.valid ? null : (validation.error ?? null));
                      if (validation.valid) {
                        handleProviderConfigChange(activeProvider, 'displayName', value);
                      }
                    }}
                    className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs ${displayNameError ? 'border-red-500 focus:border-red-500' : ''}`}
                    placeholder={i18nService.t('customDisplayNamePlaceholder')}
                  />
                  {displayNameError && (
                    <p className="mt-1 text-xs text-red-500">{displayNameError}</p>
                  )}
                </div>
              )}

              {!isProviderReadOnly(activeProvider, providers[activeProvider]) && (
                <div>
                  <label
                    htmlFor={`${activeProvider}-baseUrl`}
                    className="block text-xs font-medium text-foreground mb-1"
                  >
                    {i18nService.t('baseUrl')}
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      id={`${activeProvider}-baseUrl`}
                      value={providers[activeProvider].baseUrl}
                      onChange={e =>
                        handleProviderConfigChange(activeProvider, 'baseUrl', e.target.value)
                      }
                      disabled={isBaseUrlLocked}
                      className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-xs ${isBaseUrlLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                      placeholder={
                        getProviderDefaultBaseUrl(activeProvider) ||
                        defaultConfig.providers?.[activeProvider]?.baseUrl ||
                        i18nService.t('baseUrlPlaceholder')
                      }
                    />
                    {providers[activeProvider].baseUrl && !isBaseUrlLocked && (
                      <div className="absolute right-2 inset-y-0 flex items-center">
                        <button
                          type="button"
                          onClick={() => handleProviderConfigChange(activeProvider, 'baseUrl', '')}
                          className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                          title={i18nService.t('clear') || 'Clear'}
                        >
                          <XCircleIconSolid className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                  {isCustomProvider(activeProvider) && (
                    <div className="mt-1.5 space-y-0.5 text-[11px] text-secondary">
                      <p>
                        <span className="text-sm text-muted mr-1">•</span>
                        {i18nService.t('baseUrlHint2')}
                        <code className="ml-1 text-primary break-all">
                          {i18nService.t('baseUrlHintExample2')}
                        </code>
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* 测试连接按钮 */}
              {!isProviderReadOnly(activeProvider, providers[activeProvider]) && (
                <div className="flex items-center space-x-3">
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={
                      isTesting ||
                      (providerRequiresApiKey(activeProvider) && !providers[activeProvider].apiKey)
                    }
                    className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                    {isTesting ? i18nService.t('testing') : i18nService.t('testConnection')}
                  </button>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-xs font-medium text-foreground">
                    {i18nService.t('availableModels')}
                  </h3>
                  {!isProviderReadOnly(activeProvider, providers[activeProvider]) && (
                    <button
                      type="button"
                      onClick={handleAddModel}
                      className="inline-flex items-center text-xs text-primary hover:text-primary-hover"
                    >
                      <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
                      {i18nService.t('addModel')}
                    </button>
                  )}
                </div>

                {/* Models List */}
                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {(providers[activeProvider].models ?? []).map(model => (
                    <div
                      key={model.id}
                      className="bg-surface p-2 rounded-xl border-border border transition-colors hover:border-primary group"
                    >
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <div className="w-1.5 h-1.5 shrink-0 rounded-full bg-green-400"></div>
                          <div className="min-w-0">
                            <div className="text-foreground font-medium text-[11px] truncate">
                              {model.name}
                            </div>
                            <div className="text-[10px] text-secondary truncate">{model.id}</div>
                          </div>
                        </div>
                        <div className="flex items-center shrink-0 space-x-1">
                          {model.supportsImage && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                              {i18nService.t('imageInput')}
                            </span>
                          )}
                          {model.contextLength && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-raised text-secondary">
                              {formatContextLength(model.contextLength)}
                            </span>
                          )}
                          {model.maxTokens && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-raised text-secondary">
                              {formatContextLength(model.maxTokens)}
                            </span>
                          )}
                          {!isProviderReadOnly(activeProvider, providers[activeProvider]) && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  handleEditModel(
                                    model.id,
                                    model.name,
                                    model.supportsImage,
                                    model.contextLength,
                                    model.maxTokens,
                                  )
                                }
                                className="p-0.5 text-secondary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <PencilIcon className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteModel(model.id)}
                                className="p-0.5 text-secondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <TrashIcon className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {(!providers[activeProvider].models ||
                    providers[activeProvider].models.length === 0) && (
                    <div className="bg-surface p-2.5 rounded-xl border border-border-subtle text-center">
                      <p className="text-[11px] text-secondary">
                        {i18nService.t('noModelsAvailable')}
                      </p>
                      {!isProviderReadOnly(activeProvider, providers[activeProvider]) && (
                        <button
                          type="button"
                          onClick={handleAddModel}
                          className="mt-1.5 inline-flex items-center text-[11px] font-medium text-primary hover:text-primary-hover"
                        >
                          <PlusCircleIcon className="h-3 w-3 mr-1" />
                          {i18nService.t('addFirstModel')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );

      case 'shortcuts':
        return <ShortcutsSettings shortcuts={shortcuts} onShortcutChange={handleShortcutChange} />;

      case 'myAgents':
        return <MyAgentsSettings />;

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

              <div
                className={`mb-3 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${testResult.success ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'}`}
              >
                {testResult.success ? (
                  <CheckCircleIcon className="h-4 w-4 flex-none" />
                ) : (
                  <XCircleIcon className="h-4 w-4 flex-none" />
                )}
                <span className="whitespace-nowrap">
                  {testResult.success
                    ? i18nService.t('connectionSuccess')
                    : i18nService.t('connectionFailed')}
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

              {testResult.log && (
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
              className="w-full max-w-sm rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
            >
              <p className="text-sm dark:text-claude-darkText text-claude-text">
                {i18nService.t('confirmDeleteCustomProvider')}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingDeleteProvider(null)}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
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
                {activeProvider === 'ollama' ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        {i18nService.t('ollamaModelName')}
                      </label>
                      <input
                        autoFocus
                        type="text"
                        value={newModelId}
                        onChange={e => {
                          setNewModelId(e.target.value);
                          if (!newModelName || newModelName === newModelId) {
                            setNewModelName(e.target.value);
                          }
                          if (modelFormError) {
                            setModelFormError(null);
                          }
                        }}
                        className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                        placeholder={i18nService.t('ollamaModelNamePlaceholder')}
                      />
                      <p className="mt-1 text-[11px] text-muted">
                        {i18nService.t('ollamaModelNameHint')}
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        {i18nService.t('ollamaDisplayName')}
                      </label>
                      <input
                        type="text"
                        value={newModelName === newModelId ? '' : newModelName}
                        onChange={e => {
                          setNewModelName(e.target.value || newModelId);
                          if (modelFormError) {
                            setModelFormError(null);
                          }
                        }}
                        className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                        placeholder={i18nService.t('ollamaDisplayNamePlaceholder')}
                      />
                      <p className="mt-1 text-[11px] text-muted">
                        {i18nService.t('ollamaDisplayNameHint')}
                      </p>
                    </div>
                  </>
                ) : (
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
                )}
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
