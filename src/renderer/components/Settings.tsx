import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Modal from './common/Modal';
import { configService } from '../services/config';
import { apiService } from '../services/api';
import { themeService } from '../services/theme';
import { i18nService, LanguageType } from '../services/i18n';
import {
  decryptSecret,
  encryptWithPassword,
  decryptWithPassword,
  EncryptedPayload,
  PasswordEncryptedPayload,
} from '../services/encryption';
import { coworkService } from '../services/cowork';
import { agentService } from '../services/agent';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../constants/app';
import ErrorMessage from './ErrorMessage';
import {
  XMarkIcon,
  Cog6ToothIcon,
  SignalIcon,
  CheckCircleIcon,
  XCircleIcon,
  CubeIcon,
  CpuChipIcon,
  UserCircleIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { UserGroupIcon, PlusIcon } from '@heroicons/react/24/outline';
import PlusCircleIcon from './icons/PlusCircleIcon';
import TrashIcon from './icons/TrashIcon';
import PencilIcon from './icons/PencilIcon';
import BrainIcon from './icons/BrainIcon';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../store';
import { setAvailableModels } from '../store/slices/modelSlice';
import { selectCoworkConfig } from '../store/selectors/coworkSelectors';
import ThemedSelect from './ui/ThemedSelect';
import type {
  CoworkAgentEngine,
  OpenClawEngineStatus,
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
} from '../types/cowork';
import AgentCreateModal from './agent/AgentCreateModal';
import AgentSettingsPanel from './agent/AgentSettingsPanel';
import SkillsManager from './skills/SkillsManager';
import McpManager from './mcp/McpManager';
import { ProviderRegistry, resolveCodingPlanBaseUrl } from '../../shared/providers';
import {
  defaultConfig,
  type AppConfig,
  getVisibleProviders,
  isCustomProvider,
  getCustomProviderDefaultName,
  getProviderDisplayName,
} from '../config';
import { OllamaIcon, CustomProviderIcon } from './icons/providers';
import type { PresetAgent } from '../types/agent';

type TabType =
  | 'general'
  | 'coworkAgentEngine'
  | 'model'
  | 'coworkMemory'
  | 'coworkAgent'
  | 'myAgents'
  | 'skills'
  | 'mcp'
  | 'im'
  | 'shortcuts';

export type SettingsOpenOptions = {
  initialTab?: TabType;
  notice?: string;
  noticeI18nKey?: string;
  noticeExtra?: string;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
  enterpriseConfig?: {
    ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
  } | null;
}

const CUSTOM_PROVIDER_KEYS = [
  'custom_0',
  'custom_1',
  'custom_2',
  'custom_3',
  'custom_4',
  'custom_5',
  'custom_6',
  'custom_7',
  'custom_8',
  'custom_9',
] as const;

const providerKeys = ['ollama', ...CUSTOM_PROVIDER_KEYS] as const;

type ProviderType = (typeof providerKeys)[number];
type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type Model = NonNullable<ProviderConfig['models']>[number];
type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
};

interface ProviderExportEntry {
  enabled: boolean;
  apiKey: PasswordEncryptedPayload;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'gemini';
  codingPlanEnabled?: boolean;
  models?: Model[];
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
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: Model[];
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

const providerMeta: Record<ProviderType, { label: string; icon: React.ReactNode }> = {
  ollama: { label: 'Ollama', icon: <OllamaIcon /> },
  ...(Object.fromEntries(
    CUSTOM_PROVIDER_KEYS.map(key => [
      key,
      { label: getCustomProviderDefaultName(key), icon: <CustomProviderIcon /> },
    ]),
  ) as Record<(typeof CUSTOM_PROVIDER_KEYS)[number], { label: string; icon: React.ReactNode }>),
};

const providerLinks: Partial<Record<ProviderType, { website: string; apiKey?: string }>> = {
  ollama: { website: 'https://ollama.com' },
};

const providerRequiresApiKey = (provider: ProviderType) => provider !== 'ollama';
const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '').toLowerCase();
const normalizeApiFormat = (value: unknown): 'anthropic' | 'openai' =>
  value === 'openai' ? 'openai' : 'anthropic';

const getFixedApiFormatForProvider = (
  _provider: string,
): 'anthropic' | 'openai' | 'gemini' | null => {
  // No fixed format for remaining providers (Ollama, Custom)
  return null;
};
const getEffectiveApiFormat = (
  provider: string,
  value: unknown,
): 'anthropic' | 'openai' | 'gemini' =>
  getFixedApiFormatForProvider(provider) ?? normalizeApiFormat(value);
const shouldShowApiFormatSelector = (_provider: string): boolean => {
  // Always show API format selector for Ollama and Custom providers
  return true;
};
const getProviderDefaultBaseUrl = (
  provider: ProviderType,
  apiFormat: 'anthropic' | 'openai' | 'gemini',
): string | null => {
  if (apiFormat === 'gemini') return null;
  return ProviderRegistry.getSwitchableBaseUrl(provider, apiFormat) ?? null;
};
const resolveBaseUrl = (
  provider: ProviderType,
  baseUrl: string,
  apiFormat: 'anthropic' | 'openai' | 'gemini',
): string => {
  if (baseUrl.trim()) {
    if (
      shouldAutoSwitchProviderBaseUrl(provider, baseUrl) &&
      (apiFormat === 'anthropic' || apiFormat === 'openai')
    ) {
      const switchedUrl = ProviderRegistry.getSwitchableBaseUrl(provider, apiFormat);
      if (switchedUrl) return switchedUrl;
    }
    return baseUrl;
  }
  return (
    getProviderDefaultBaseUrl(provider, apiFormat) ||
    defaultConfig.providers?.[provider]?.baseUrl ||
    ''
  );
};
const shouldAutoSwitchProviderBaseUrl = (
  provider: ProviderType,
  currentBaseUrl: string,
): boolean => {
  const anthropicUrl = ProviderRegistry.getSwitchableBaseUrl(provider, 'anthropic');
  const openaiUrl = ProviderRegistry.getSwitchableBaseUrl(provider, 'openai');
  if (!anthropicUrl && !openaiUrl) {
    return false;
  }

  const normalizedCurrent = normalizeBaseUrl(currentBaseUrl);
  return (
    (anthropicUrl ? normalizedCurrent === normalizeBaseUrl(anthropicUrl) : false) ||
    (openaiUrl ? normalizedCurrent === normalizeBaseUrl(openaiUrl) : false)
  );
};
const buildOpenAICompatibleChatCompletionsUrl = (baseUrl: string, _provider: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/chat/completions';
  }
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }

  const isGeminiLike = normalized.includes('generativelanguage.googleapis.com');
  if (isGeminiLike) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
      const betaBase = normalized.endsWith('/v1') ? `${normalized.slice(0, -3)}v1beta` : normalized;
      return `${betaBase}/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }

  // Handle /v1, /v4 etc. versioned paths
  if (/\/v\d+$/.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};
const buildOpenAIResponsesUrl = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/responses';
  }
  if (normalized.endsWith('/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/v1/responses`;
};
const shouldUseOpenAIResponsesForProvider = (_provider: string): boolean => false;
const shouldUseMaxCompletionTokensForOpenAI = (_provider: string, _modelId?: string): boolean =>
  false;
const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

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
  const firstEnabledProvider = providerKeys.find(providerKey => providers[providerKey]?.enabled);
  return firstEnabledProvider ?? providerKeys[0];
};

/** Join workspace directory with a filename using platform-aware separator. */
const joinWorkspacePath = (dir: string | undefined, filename: string): string => {
  const base = dir?.trim() || '~/.openclaw/workspace';
  const sep = window.electron.platform === 'win32' ? '\\' : '/';
  // Normalize: if base already ends with a separator, don't double it
  return base.endsWith(sep) || base.endsWith('/') || base.endsWith('\\')
    ? `${base}${filename}`
    : `${base}${sep}${filename}`;
};

// System shortcuts that should not be captured (clipboard, undo, select-all, quit, etc.)
const isSystemShortcut = (e: KeyboardEvent): boolean => {
  const key = e.key.toLowerCase();
  if (e.metaKey && ['c', 'v', 'x', 'z', 'y', 'a', 'q', 'w'].includes(key)) return true;
  if (e.metaKey && e.shiftKey && key === 'z') return true;
  if (e.ctrlKey && ['c', 'v', 'x', 'z', 'y', 'a', 'w'].includes(key)) return true;
  return false;
};

const formatShortcutFromEvent = (e: React.KeyboardEvent): string | null => {
  // Skip standalone modifier keys
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
  // Require at least one non-Shift modifier
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
  if (isSystemShortcut(e.nativeEvent)) return null;

  const parts: string[] = [];
  if (e.metaKey) parts.push('Cmd');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const keyMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space',
    Escape: 'Esc',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
  };
  const key = keyMap[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(key);
  return parts.join('+');
};

const SEND_SHORTCUT_OPTIONS = [
  { value: 'Enter', label: 'Enter', labelMac: 'Enter' },
  { value: 'Shift+Enter', label: 'Shift+Enter', labelMac: 'Shift+Enter' },
  { value: 'Ctrl+Enter', label: 'Ctrl+Enter', labelMac: 'Cmd+Enter' },
  { value: 'Alt+Enter', label: 'Alt+Enter', labelMac: 'Option+Enter' },
] as const;

const isMacPlatform = navigator.platform.includes('Mac');

const ShortcutRecorder: React.FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => {
  const [recording, setRecording] = useState(false);
  const divRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(false);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      onChange('');
      setRecording(false);
      return;
    }
    const shortcut = formatShortcutFromEvent(e);
    if (shortcut) {
      onChange(shortcut);
      setRecording(false);
    }
  };

  useEffect(() => {
    if (!recording) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (divRef.current && !divRef.current.contains(e.target as Node)) setRecording(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [recording]);

  return (
    <div
      ref={divRef}
      tabIndex={0}
      data-shortcut-input="true"
      onKeyDown={handleKeyDown}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      className={`w-36 rounded-xl border px-3 py-1.5 text-sm cursor-pointer select-none text-center outline-none transition-colors
        dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:text-claude-darkText text-claude-text
        ${
          recording
            ? 'border-claude-accent ring-1 ring-claude-accent/30 dark:text-claude-darkTextSecondary text-claude-textSecondary'
            : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50'
        }`}
    >
      {value || i18nService.t('shortcutNotSet')}
    </div>
  );
};

const SendShortcutSelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const currentLabel = (() => {
    const opt = SEND_SHORTCUT_OPTIONS.find(o => o.value === value);
    if (!opt) return value;
    return isMacPlatform ? opt.labelMac : opt.label;
  })();

  return (
    <div ref={containerRef} className="relative">
      <div
        onClick={() => setOpen(!open)}
        className={`w-36 rounded-xl border px-3 py-1.5 text-sm cursor-pointer select-none text-center outline-none transition-colors
          dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:text-claude-darkText text-claude-text
          ${
            open
              ? 'border-claude-accent ring-1 ring-claude-accent/30'
              : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50'
          }`}
      >
        {currentLabel}
      </div>
      {open && (
        <div className="absolute right-0 mt-1 z-50 min-w-[160px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset shadow-elevated py-1">
          {SEND_SHORTCUT_OPTIONS.map(option => {
            const label = isMacPlatform ? option.labelMac : option.label;
            const isActive = value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex items-center justify-between w-full px-3 py-1.5 text-sm transition-colors
                  ${
                    isActive
                      ? 'dark:text-claude-accent text-claude-accent font-medium'
                      : 'dark:text-claude-darkText text-claude-text'
                  } hover:bg-claude-accent/10`}
              >
                <span>{label}</span>
                {isActive && <span className="text-claude-accent">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ── My Agents Settings Component ─────────────────────────── */

interface MyAgentsSettingsProps {
  onSwitchAgent?: (agentId: string) => void;
}

const MyAgentsSettings: React.FC<MyAgentsSettingsProps> = ({ onSwitchAgent }) => {
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
      <AgentSettingsPanel
        agentId={settingsAgentId}
        onClose={() => setSettingsAgentId(null)}
        onSwitchAgent={id => {
          setSettingsAgentId(null);
          onSwitchAgent?.(id);
        }}
      />
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

const Settings: React.FC<SettingsProps> = ({
  onClose,
  initialTab,
  notice,
  noticeI18nKey,
  noticeExtra,
  enterpriseConfig,
}) => {
  const dispatch = useDispatch();
  // 状态
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'general');
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
  const initialThemeRef = useRef<'light' | 'dark' | 'system'>(themeService.getTheme());
  const initialThemeIdRef = useRef<string>(themeService.getThemeId());
  const initialLanguageRef = useRef<LanguageType>(i18nService.getLanguage());
  const didSaveRef = useRef(false);

  // Add state for active provider
  const [activeProvider, setActiveProvider] = useState<ProviderType>(getDefaultActiveProvider());
  const [showApiKey, setShowApiKey] = useState(false);

  // Add state for providers configuration
  const [providers, setProviders] = useState<ProvidersConfig>(() => getDefaultProviders());

  const isBaseUrlLocked = false;

  // 创建引用来确保内容区域的滚动
  const contentRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 快捷键设置
  const [shortcuts, setShortcuts] = useState({
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
  const [modelFormError, setModelFormError] = useState<string | null>(null);

  useEffect(() => {
    setShowApiKey(false);
  }, [activeProvider]);

  const coworkConfig = useSelector(selectCoworkConfig);

  const [coworkAgentEngine, setCoworkAgentEngine] = useState<CoworkAgentEngine>(
    coworkConfig.agentEngine || 'openclaw',
  );
  const [coworkMemoryEnabled, setCoworkMemoryEnabled] = useState<boolean>(
    coworkConfig.memoryEnabled ?? true,
  );
  const [coworkMemoryLlmJudgeEnabled, setCoworkMemoryLlmJudgeEnabled] = useState<boolean>(
    coworkConfig.memoryLlmJudgeEnabled ?? false,
  );
  const [skipMissedJobs, setSkipMissedJobs] = useState<boolean>(
    coworkConfig.skipMissedJobs ?? false,
  );
  const [coworkMemoryEntries, setCoworkMemoryEntries] = useState<CoworkUserMemoryEntry[]>([]);
  const [coworkMemoryStats, setCoworkMemoryStats] = useState<CoworkMemoryStats | null>(null);
  const [coworkMemoryListLoading, setCoworkMemoryListLoading] = useState<boolean>(false);
  const [coworkMemoryQuery, setCoworkMemoryQuery] = useState<string>('');
  const [coworkMemoryEditingId, setCoworkMemoryEditingId] = useState<string | null>(null);
  const [coworkMemoryDraftText, setCoworkMemoryDraftText] = useState<string>('');
  const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
  const [bootstrapIdentity, setBootstrapIdentity] = useState<string>('');
  const [bootstrapUser, setBootstrapUser] = useState<string>('');
  const [bootstrapSoul, setBootstrapSoul] = useState<string>('');
  const [bootstrapLoaded, setBootstrapLoaded] = useState<boolean>(false);
  const [openClawEngineStatus, setOpenClawEngineStatus] = useState<OpenClawEngineStatus | null>(
    null,
  );
  const [openClawGatewayPort, setOpenClawGatewayPort] = useState<number>(42879);
  const [openClawGatewayPortEditing, setOpenClawGatewayPortEditing] = useState<boolean>(false);
  const [openClawGatewayPortInput, setOpenClawGatewayPortInput] = useState<string>('42879');
  const [openClawGatewayPortSaving, setOpenClawGatewayPortSaving] = useState<boolean>(false);

  useEffect(() => {
    setCoworkAgentEngine(coworkConfig.agentEngine || 'openclaw');
    setCoworkMemoryEnabled(coworkConfig.memoryEnabled ?? true);
    setCoworkMemoryLlmJudgeEnabled(coworkConfig.memoryLlmJudgeEnabled ?? false);
    setSkipMissedJobs(coworkConfig.skipMissedJobs ?? false);
  }, [
    coworkConfig.agentEngine,
    coworkConfig.memoryEnabled,
    coworkConfig.memoryLlmJudgeEnabled,
    coworkConfig.skipMissedJobs,
  ]);

  useEffect(() => {
    let active = true;
    void coworkService.getOpenClawEngineStatus().then(status => {
      if (!active || !status) return;
      setOpenClawEngineStatus(status);
    });
    const unsubscribe = coworkService.onOpenClawEngineStatus(status => {
      if (!active) return;
      setOpenClawEngineStatus(status);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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

      // Set up providers based on saved config
      if (config.api) {
        // For backward compatibility with older config
        // Initialize active provider based on baseUrl
        const normalizedApiBaseUrl = config.api.baseUrl.toLowerCase();
        if (normalizedApiBaseUrl.includes('ollama') || normalizedApiBaseUrl.includes('11434')) {
          setActiveProvider('ollama');
          setProviders(prev => ({
            ...prev,
            ollama: {
              ...prev.ollama,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl,
            },
          }));
        } else {
          // For other URLs, check if it matches a custom provider
          const customProvider = CUSTOM_PROVIDER_KEYS.find(key =>
            normalizedApiBaseUrl.includes(key.toLowerCase()),
          );
          if (customProvider) {
            setActiveProvider(customProvider);
            setProviders(prev => ({
              ...prev,
              [customProvider]: {
                ...prev[customProvider],
                enabled: true,
                apiKey: config.api.key,
                baseUrl: config.api.baseUrl,
              },
            }));
          }
        }
      }

      // Load provider-specific configurations if available
      // 合并已保存的配置和默认配置，确保新添加的 provider 能被显示
      if (config.providers) {
        setProviders(prev => {
          const merged = {
            ...prev, // 保留默认的 providers（包括新添加的 anthropic）
            ...config.providers, // 覆盖已保存的配置
          };

          // After merging, find the first enabled provider to set as activeProvider
          // This ensures we don't use stale activeProvider from old config.api.baseUrl
          const firstEnabledProvider = providerKeys.find(
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
                  apiFormat: getEffectiveApiFormat(
                    providerKey,
                    (providerConfig as ProviderConfig).apiFormat,
                  ),
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
      setActiveTab(initialTab);
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
    // Append custom_N providers that exist in state, sorted by numeric suffix
    for (const key of CUSTOM_PROVIDER_KEYS) {
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
    // Find the first unused custom slot
    const usedKeys = new Set(Object.keys(providers));
    const newKey = CUSTOM_PROVIDER_KEYS.find(k => !usedKeys.has(k));
    if (!newKey) return; // All 10 slots used
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
      setActiveProvider(firstEnabled ?? visibleKeys[0] ?? providerKeys[0]);
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
    setProviders(prev => {
      if (field === 'apiFormat') {
        const nextApiFormat = getEffectiveApiFormat(provider, value);
        const nextProviderConfig: ProviderConfig = {
          ...prev[provider],
          apiFormat: nextApiFormat,
        };

        // Only auto-switch URL when current value is still a known default URL.
        if (shouldAutoSwitchProviderBaseUrl(provider, prev[provider].baseUrl)) {
          const defaultBaseUrl = getProviderDefaultBaseUrl(provider, nextApiFormat);
          if (defaultBaseUrl) {
            nextProviderConfig.baseUrl = defaultBaseUrl;
          }
        }

        return {
          ...prev,
          [provider]: nextProviderConfig,
        };
      }

      // Handle codingPlanEnabled toggle for all supported providers
      if (field === 'codingPlanEnabled') {
        const def = ProviderRegistry.get(provider);
        if (def?.codingPlanSupported) {
          const enabled = value === 'true';
          const nextModels =
            enabled && def.codingPlanModels
              ? def.codingPlanModels.map(m => ({ ...m }))
              : def.defaultModels.map(m => ({ ...m }));
          return {
            ...prev,
            [provider]: {
              ...prev[provider],
              codingPlanEnabled: enabled,
              models: nextModels,
            },
          };
        }
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

  const hasCoworkConfigChanges =
    coworkAgentEngine !== coworkConfig.agentEngine ||
    coworkMemoryEnabled !== coworkConfig.memoryEnabled ||
    coworkMemoryLlmJudgeEnabled !== coworkConfig.memoryLlmJudgeEnabled ||
    skipMissedJobs !== (coworkConfig.skipMissedJobs ?? false);
  const isOpenClawAgentEngine = coworkAgentEngine === 'openclaw';

  const openClawProgressPercent = useMemo(() => {
    if (
      typeof openClawEngineStatus?.progressPercent !== 'number' ||
      !Number.isFinite(openClawEngineStatus.progressPercent)
    ) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(openClawEngineStatus.progressPercent)));
  }, [openClawEngineStatus]);

  const resolveOpenClawStatusText = (status: OpenClawEngineStatus | null): string => {
    if (!status) {
      return i18nService.t('coworkOpenClawNotInstalledNotice');
    }
    if (status.message?.trim()) {
      return status.message.trim();
    }
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

  const loadCoworkMemoryData = useCallback(async () => {
    setCoworkMemoryListLoading(true);
    try {
      const [entries, stats] = await Promise.all([
        coworkService.listMemoryEntries({
          query: coworkMemoryQuery.trim() || undefined,
        }),
        coworkService.getMemoryStats(),
      ]);
      setCoworkMemoryEntries(entries);
      setCoworkMemoryStats(stats);
    } catch (loadError) {
      console.error('Failed to load cowork memory data:', loadError);
      setCoworkMemoryEntries([]);
      setCoworkMemoryStats(null);
    } finally {
      setCoworkMemoryListLoading(false);
    }
  }, [coworkMemoryQuery]);

  useEffect(() => {
    if (activeTab !== 'coworkMemory') return;
    void loadCoworkMemoryData();
  }, [activeTab, loadCoworkMemoryData]);

  /**
   * Detect OpenClaw default template content and return empty string.
   * Templates contain YAML frontmatter and specific marker phrases.
   */
  const stripDefaultTemplate = (content: string): string => {
    if (!content.trim()) return '';
    const TEMPLATE_MARKERS = [
      'Fill this in during your first conversation',
      "You're not a chatbot. You're becoming someone",
      "Learn about the person you're helping",
    ];
    if (TEMPLATE_MARKERS.some(m => content.includes(m))) return '';
    return content;
  };

  useEffect(() => {
    if (activeTab !== 'coworkAgent') return;
    if (!bootstrapLoaded) {
      void (async () => {
        const [identity, user, soul] = await Promise.all([
          coworkService.readBootstrapFile('IDENTITY.md'),
          coworkService.readBootstrapFile('USER.md'),
          coworkService.readBootstrapFile('SOUL.md'),
        ]);
        setBootstrapIdentity(stripDefaultTemplate(identity));
        setBootstrapUser(stripDefaultTemplate(user));
        setBootstrapSoul(stripDefaultTemplate(soul));
        setBootstrapLoaded(true);
      })();
    }
  }, [activeTab, bootstrapLoaded]);

  const resetCoworkMemoryEditor = () => {
    setCoworkMemoryEditingId(null);
    setCoworkMemoryDraftText('');
    setShowMemoryModal(false);
  };

  const handleSaveCoworkMemoryEntry = async () => {
    const text = coworkMemoryDraftText.trim();
    if (!text) return;

    setCoworkMemoryListLoading(true);
    try {
      if (coworkMemoryEditingId) {
        await coworkService.updateMemoryEntry({
          id: coworkMemoryEditingId,
          text,
        });
      } else {
        await coworkService.createMemoryEntry({
          text,
        });
      }
      resetCoworkMemoryEditor();
      await loadCoworkMemoryData();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : i18nService.t('coworkMemoryCrudSaveFailed'),
      );
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const handleEditCoworkMemoryEntry = (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryEditingId(entry.id);
    setCoworkMemoryDraftText(entry.text);
    setShowMemoryModal(true);
  };

  const handleDeleteCoworkMemoryEntry = async (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryListLoading(true);
    try {
      await coworkService.deleteMemoryEntry({ id: entry.id });
      if (coworkMemoryEditingId === entry.id) {
        resetCoworkMemoryEditor();
      }
      await loadCoworkMemoryData();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : i18nService.t('coworkMemoryCrudDeleteFailed'),
      );
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const handleOpenCoworkMemoryModal = () => {
    resetCoworkMemoryEditor();
    setShowMemoryModal(true);
  };

  // Toggle provider enabled status
  const toggleProviderEnabled = (provider: ProviderType) => {
    const providerConfig = providers[provider];
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
          const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
          return [
            providerKey,
            {
              ...providerConfig,
              apiFormat,
              baseUrl: resolveBaseUrl(
                providerKey as ProviderType,
                providerConfig.baseUrl,
                apiFormat,
              ),
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

      // Set API with the primary provider
      apiService.setConfig({
        apiKey: primaryProvider.apiKey,
        baseUrl: primaryProvider.baseUrl,
      });

      // 更新 Redux store 中的可用模型列表
      const allModels: {
        id: string;
        name: string;
        provider?: string;
        providerKey?: string;
        supportsImage?: boolean;
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
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));

      if (hasCoworkConfigChanges) {
        const updated = await coworkService.updateConfig({
          agentEngine: coworkAgentEngine,
          memoryEnabled: coworkMemoryEnabled,
          memoryLlmJudgeEnabled: coworkMemoryLlmJudgeEnabled,
          skipMissedJobs,
        });
        if (!updated) {
          throw new Error(i18nService.t('coworkConfigSaveFailed'));
        }
      }

      // Save bootstrap files (IDENTITY.md, USER.md, SOUL.md) only if loaded
      if (bootstrapLoaded) {
        const results = await Promise.all([
          coworkService.writeBootstrapFile('IDENTITY.md', bootstrapIdentity),
          coworkService.writeBootstrapFile('USER.md', bootstrapUser),
          coworkService.writeBootstrapFile('SOUL.md', bootstrapSoul),
        ]);
        if (results.some(r => !r)) {
          throw new Error(i18nService.t('coworkBootstrapSaveFailed'));
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
      setModelFormError(null);
    }
    setActiveTab(tab);
  };

  // Mapping from shortcut key to i18n label key for conflict messages
  const shortcutLabelMap: Record<string, string> = {
    newChat: 'newChat',
    search: 'search',
    settings: 'openSettings',
    sendMessage: 'sendMessageShortcut',
  };

  // 快捷键更新处理
  const handleShortcutChange = (key: keyof typeof shortcuts, value: string) => {
    // Check for conflicts with other shortcuts
    const conflictKey = Object.keys(shortcuts).find(
      k => k !== key && shortcuts[k as keyof typeof shortcuts] === value,
    );
    if (conflictKey) {
      const conflictLabel = i18nService.t(shortcutLabelMap[conflictKey] ?? conflictKey);
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
    setIsAddingModel(true);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleEditModel = (modelId: string, modelName: string, supportsImage?: boolean) => {
    setIsAddingModel(false);
    setIsEditingModel(true);
    setEditingModelId(modelId);
    setNewModelName(modelName);
    setNewModelId(modelId);
    setNewModelSupportsImage(!!supportsImage);
    setModelFormError(null);
  };

  const handleDeleteModel = (modelId: string) => {
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

    const nextModel = {
      id: modelId,
      name: modelName,
      supportsImage: newModelSupportsImage,
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
    setModelFormError(null);
  };

  const handleCancelModelEdit = () => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
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
    result: Omit<ProviderConnectionTestResult, 'provider'>,
    provider: ProviderType,
  ) => {
    setTestResult({
      ...result,
      provider,
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

    try {
      let response: Awaited<ReturnType<typeof window.electron.api.fetch>>;
      // Apply Coding Plan endpoint switch
      let effectiveBaseUrl = resolveBaseUrl(
        testingProvider,
        providerConfig.baseUrl,
        getEffectiveApiFormat(testingProvider, providerConfig.apiFormat),
      );
      let effectiveApiFormat = getEffectiveApiFormat(testingProvider, providerConfig.apiFormat);

      // Handle Coding Plan endpoint switch for supported providers
      if (
        (providerConfig as { codingPlanEnabled?: boolean }).codingPlanEnabled &&
        (effectiveApiFormat === 'anthropic' || effectiveApiFormat === 'openai')
      ) {
        const resolved = resolveCodingPlanBaseUrl(
          testingProvider,
          true,
          effectiveApiFormat,
          effectiveBaseUrl,
        );
        effectiveBaseUrl = resolved.baseUrl;
        effectiveApiFormat = resolved.effectiveFormat;
      }

      const normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
      const effectiveApiKey = providerConfig.apiKey;

      // Determine format after all overrides
      // 统一为两种协议格式：
      // - anthropic: /v1/messages
      // - openai provider: /v1/responses
      // - other openai-compatible providers: /v1/chat/completions
      const useAnthropicFormat = effectiveApiFormat === 'anthropic';

      if (useAnthropicFormat) {
        const anthropicUrl = normalizedBaseUrl.endsWith('/v1')
          ? `${normalizedBaseUrl}/messages`
          : `${normalizedBaseUrl}/v1/messages`;
        response = await window.electron.api.fetch({
          url: anthropicUrl,
          method: 'POST',
          headers: {
            'x-api-key': effectiveApiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: firstModel.id,
            max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else {
        const useResponsesApi = shouldUseOpenAIResponsesForProvider(testingProvider);
        const openaiUrl = useResponsesApi
          ? buildOpenAIResponsesUrl(normalizedBaseUrl)
          : buildOpenAICompatibleChatCompletionsUrl(normalizedBaseUrl, testingProvider);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (effectiveApiKey) {
          headers.Authorization = `Bearer ${effectiveApiKey}`;
        }
        const openAIRequestBody: Record<string, unknown> = useResponsesApi
          ? {
              model: firstModel.id,
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
              max_output_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            }
          : {
              model: firstModel.id,
              messages: [{ role: 'user', content: 'Hi' }],
            };
        if (
          !useResponsesApi &&
          shouldUseMaxCompletionTokensForOpenAI(testingProvider, firstModel.id)
        ) {
          openAIRequestBody.max_completion_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
        } else {
          if (!useResponsesApi) {
            openAIRequestBody.max_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
          }
        }
        response = await window.electron.api.fetch({
          url: openaiUrl,
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody),
        });
      }

      if (response.ok) {
        enableProvider(testingProvider);
        showTestResultModal(
          { success: true, message: i18nService.t('connectionSuccess') },
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
            { success: true, message: i18nService.t('connectionSuccess') },
            testingProvider,
          );
          return;
        }
        showTestResultModal({ success: false, message: errorMessage }, testingProvider);
      }
    } catch (err) {
      showTestResultModal(
        {
          success: false,
          message: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
        },
        testingProvider,
      );
    } finally {
      setIsTesting(false);
    }
  };

  const buildProvidersExport = async (password: string): Promise<ProvidersExportPayload> => {
    const entries = await Promise.all(
      Object.entries(providers).map(async ([providerKey, providerConfig]) => {
        const apiKey = await encryptWithPassword(providerConfig.apiKey, password);
        const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
        return [
          providerKey,
          {
            enabled: providerConfig.enabled,
            apiKey,
            baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl, apiFormat),
            apiFormat,
            codingPlanEnabled: (providerConfig as ProviderConfig).codingPlanEnabled,
            models: providerConfig.models,
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
      for (const providerKey of providerKeys) {
        const providerData = payload.providers?.[providerKey];
        if (!providerData) {
          continue;
        }

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
              : providers[providerKey].enabled,
          apiKey: apiKey ?? providers[providerKey].apiKey,
          baseUrl:
            typeof providerData.baseUrl === 'string'
              ? providerData.baseUrl
              : providers[providerKey].baseUrl,
          apiFormat: getEffectiveApiFormat(
            providerKey,
            providerData.apiFormat ?? providers[providerKey].apiFormat,
          ),
          codingPlanEnabled:
            typeof providerData.codingPlanEnabled === 'boolean'
              ? providerData.codingPlanEnabled
              : (providers[providerKey] as ProviderConfig).codingPlanEnabled,
          models: models ?? providers[providerKey].models,
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

      for (const providerKey of providerKeys) {
        const providerData = payload.providers[providerKey];
        if (!providerData) {
          continue;
        }

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
              : providers[providerKey].enabled,
          apiKey: apiKey ?? providers[providerKey].apiKey,
          baseUrl:
            typeof providerData.baseUrl === 'string'
              ? providerData.baseUrl
              : providers[providerKey].baseUrl,
          apiFormat: getEffectiveApiFormat(
            providerKey,
            providerData.apiFormat ?? providers[providerKey].apiFormat,
          ),
          codingPlanEnabled:
            typeof providerData.codingPlanEnabled === 'boolean'
              ? providerData.codingPlanEnabled
              : (providers[providerKey] as ProviderConfig).codingPlanEnabled,
          models: models ?? providers[providerKey].models,
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
        key: 'coworkAgentEngine' as TabType,
        label: i18nService.t('coworkAgentEngine'),
        icon: <CpuChipIcon className="h-5 w-5" />,
      },
      {
        key: 'model' as TabType,
        label: i18nService.t('model'),
        icon: <CubeIcon className="h-5 w-5" />,
      },
      {
        key: 'coworkMemory' as TabType,
        label: i18nService.t('coworkMemoryTitle'),
        icon: <BrainIcon className="h-5 w-5" />,
      },
      {
        key: 'coworkAgent' as TabType,
        label: i18nService.t('coworkAgentTab'),
        icon: <UserCircleIcon className="h-5 w-5" />,
      },
      {
        key: 'myAgents' as TabType,
        label: i18nService.t('myAgents'),
        icon: <UserGroupIcon className="h-5 w-5" />,
      },
      {
        key: 'skills' as TabType,
        label: i18nService.t('skills'),
        icon: (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-5 w-5"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.394 48.394 0 01-.3 4.163c1.613-.186 3.25-.293 4.907-.315a.656.656 0 01.663.658v0c0 .355-.186.676-.401.959a1.647 1.647 0 00-.349 1.003c0 1.035 1.007 1.875 2.25 1.875s2.25-.84 2.25-1.875c0-.369-.128-.713-.349-1.003-.215-.283-.401-.604-.401-.959v0c0-.31.26-.555.57-.532a48.394 48.394 0 014.163.3c-.186-1.613-.293-3.25-.315-4.907a.656.656 0 01.658-.663v0c.355 0 .676.186.959.401.29.221.634.349 1.003.349 1.035 0 1.875-1.007 1.875-2.25s-.84-2.25-1.875-2.25c-.369 0-.713.128-1.003.349-.283.215-.604.401-.959.401v0a.64.64 0 01-.643-.657 48.39 48.39 0 01.3-4.163c-1.613.186-3.25.293-4.907.315a.656.656 0 01-.663-.658v0z" />
          </svg>
        ),
      },
      {
        key: 'mcp' as TabType,
        label: i18nService.t('mcpServers'),
        icon: (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-5 w-5"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 16.568a4.5 4.5 0 01-6.38 0 4.5 4.5 0 010-6.38m6.38 0a4.5 4.5 0 01-6.38 0 4.5 4.5 0 010-6.38m6.38 0a4.5 4.5 0 010 6.38m-6.38 0a4.5 4.5 0 010 6.38M7.5 10.5L5.25 8.25m0 0L3 6m2.25 2.25L3 10.5m2.25-2.25L7.5 12m9-3l2.25-2.25m0 0L21 6m-2.25 2.25L21 10.5m-2.25-2.25L16.5 12M7.5 15l-2.25 2.25m0 0L3 19.5m2.25-2.25L3 15m2.25 2.25L7.5 13.5m9 3l2.25 2.25m0 0l2.25 2.25m-2.25-2.25l2.25-2.25m-2.25 2.25L16.5 15" />
          </svg>
        ),
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
    ];
    // Filter out tabs hidden by enterprise config
    // Filter out tabs with 'hide' action in enterprise config
    // e.g., ui: { "settings.im": "hide" } → hide the 'im' tab
    const ui = enterpriseConfig?.ui;
    if (ui) {
      return allTabs.filter(tab => ui[`settings.${tab.key}`] !== 'hide');
    }
    return allTabs;
  }, [language, enterpriseConfig]);

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

            {/* Skip Missed Jobs Section */}
            <div>
              <h4 className="text-sm font-medium text-foreground mb-3">
                {i18nService.t('skipMissedJobs')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-secondary">
                  {i18nService.t('skipMissedJobsDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={skipMissedJobs}
                  onClick={() => {
                    setSkipMissedJobs(prev => !prev);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    skipMissedJobs ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      skipMissedJobs ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* Appearance Section — mode selector + theme gallery */}
            <div>
              <h4
                className="text-sm font-medium mb-3"
                style={{ color: 'var(--gucciai-text-primary)' }}
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
                        borderColor: isSelected
                          ? 'var(--gucciai-primary)'
                          : 'var(--gucciai-border)',
                        backgroundColor: isSelected ? 'var(--gucciai-primary-muted)' : undefined,
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
                            ? 'var(--gucciai-primary)'
                            : 'var(--gucciai-text-primary)',
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
                style={{ color: 'var(--gucciai-text-primary)' }}
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
                        borderColor: isSelected
                          ? 'var(--gucciai-primary)'
                          : 'var(--gucciai-border)',
                        backgroundColor: isSelected ? 'var(--gucciai-primary-muted)' : undefined,
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
                            ? 'var(--gucciai-primary)'
                            : 'var(--gucciai-text-primary)',
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

      case 'coworkAgentEngine':
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

      case 'coworkMemory':
        return (
          <div className="space-y-6">
            {/* Section 1: Long-term Memory (MEMORY.md) */}
            <div className="space-y-3 rounded-xl border px-4 py-4 border-border">
              <div className="text-sm font-medium text-foreground">
                {i18nService.t('coworkMemoryTitle')}
              </div>
              {/* Memory toggle hidden – always enabled by default */}
              <div className="mt-2 text-xs text-secondary">
                <span className="font-medium">{i18nService.t('coworkMemoryFilePath')}:</span>{' '}
                <span className="break-all font-mono opacity-80">
                  {joinWorkspacePath(coworkConfig.workingDirectory, 'MEMORY.md')}
                </span>
              </div>
            </div>

            <div className="space-y-4 rounded-xl border px-4 py-4 border-border">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">
                    {i18nService.t('coworkMemoryCrudTitle')}
                  </div>
                  <div className="text-xs text-secondary">
                    {i18nService.t('coworkMemoryManageHint')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleOpenCoworkMemoryModal}
                  className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm transition-colors active:scale-[0.98]"
                >
                  <PlusCircleIcon className="h-4 w-4 mr-1.5" />
                  {i18nService.t('coworkMemoryCrudCreate')}
                </button>
              </div>

              {coworkMemoryStats && (
                <div className="text-xs text-secondary">
                  {`${i18nService.t('coworkMemoryTotalLabel')}: ${coworkMemoryStats.total}`}
                </div>
              )}

              <input
                type="text"
                value={coworkMemoryQuery}
                onChange={event => setCoworkMemoryQuery(event.target.value)}
                placeholder={i18nService.t('coworkMemorySearchPlaceholder')}
                className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface"
              />

              <div className="rounded-lg border border-border">
                {coworkMemoryListLoading ? (
                  <div className="px-3 py-3 text-xs text-secondary">{i18nService.t('loading')}</div>
                ) : coworkMemoryEntries.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-secondary">
                    {i18nService.t('coworkMemoryEmpty')}
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {coworkMemoryEntries.map(entry => (
                      <div
                        key={entry.id}
                        className="px-3 py-3 text-xs hover:bg-surface-raised transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-foreground break-words">
                              {entry.text}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => handleEditCoworkMemoryEntry(entry)}
                              className="rounded border px-2 py-1 border-border text-foreground hover:bg-surface-raised transition-colors"
                            >
                              {i18nService.t('edit')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void handleDeleteCoworkMemoryEntry(entry);
                              }}
                              className="rounded border px-2 py-1 text-red-500 border-border hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-60 transition-colors"
                              disabled={coworkMemoryListLoading}
                            >
                              {i18nService.t('delete')}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );

      case 'model':
        return (
          <div className="flex h-full">
            {/* Provider List - Left Side */}
            <div className="w-2/5 border-r border-border pr-3 space-y-1.5 overflow-y-auto">
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
                const providerInfo = providerMeta[providerKey];
                const missingApiKey = providerRequiresApiKey(providerKey) && !config.apiKey.trim();
                const canToggleProvider = config.enabled || !missingApiKey;
                const displayLabel = isCustom
                  ? (config as ProviderConfig).displayName || getCustomProviderDefaultName(provider)
                  : (providerInfo?.label ?? getProviderDisplayName(provider));
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
              {CUSTOM_PROVIDER_KEYS.some(k => !providers[k]) && (
                <button
                  type="button"
                  onClick={handleAddCustomProvider}
                  className="w-full flex items-center justify-center p-2 rounded-xl border border-dashed border-claude-border dark:border-claude-darkBorder text-claude-secondaryText dark:text-claude-darkSecondaryText hover:border-claude-accent hover:text-claude-accent transition-colors text-sm"
                >
                  {i18nService.t('addCustomProvider')}
                </button>
              )}
            </div>

            {/* Provider Settings - Right Side */}
            <div className="w-3/5 pl-4 pr-2 space-y-4 overflow-y-auto [scrollbar-gutter:stable]">
              <div className="flex items-center justify-between pb-2 border-b border-border">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-base font-medium text-foreground">
                    {isCustomProvider(activeProvider)
                      ? (providers[activeProvider] as ProviderConfig)?.displayName ||
                        getCustomProviderDefaultName(activeProvider)
                      : (providerMeta[activeProvider]?.label ??
                        getProviderDisplayName(activeProvider))}{' '}
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

              {/* Standard API key section */}
              {providerRequiresApiKey(activeProvider) && (
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
                    onChange={e =>
                      handleProviderConfigChange(activeProvider, 'displayName', e.target.value)
                    }
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                    placeholder={i18nService.t('customDisplayNamePlaceholder')}
                  />
                </div>
              )}

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
                      getProviderDefaultBaseUrl(
                        activeProvider,
                        getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat),
                      ) ||
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
                      {i18nService.t('baseUrlHint1')}
                      <code className="ml-1 text-primary break-all">
                        {i18nService.t('baseUrlHintExample1')}
                      </code>
                    </p>
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

              {/* API 格式选择器 */}
              {shouldShowApiFormatSelector(activeProvider) && (
                <div>
                  <label
                    htmlFor={`${activeProvider}-apiFormat`}
                    className="block text-xs font-medium text-foreground mb-1"
                  >
                    {i18nService.t('apiFormat')}
                  </label>
                  <div className="flex items-center space-x-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="anthropic"
                        checked={
                          getEffectiveApiFormat(
                            activeProvider,
                            providers[activeProvider].apiFormat,
                          ) !== 'openai'
                        }
                        onChange={() =>
                          handleProviderConfigChange(activeProvider, 'apiFormat', 'anthropic')
                        }
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface disabled:opacity-50"
                      />
                      <span className="ml-2 text-xs text-foreground">
                        {i18nService.t('apiFormatNative')}
                      </span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="openai"
                        checked={
                          getEffectiveApiFormat(
                            activeProvider,
                            providers[activeProvider].apiFormat,
                          ) === 'openai'
                        }
                        onChange={() =>
                          handleProviderConfigChange(activeProvider, 'apiFormat', 'openai')
                        }
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface disabled:opacity-50"
                      />
                      <span className="ml-2 text-xs text-foreground">
                        {i18nService.t('apiFormatOpenAI')}
                      </span>
                    </label>
                  </div>
                  <p className="mt-1 text-xs text-secondary">{i18nService.t('apiFormatHint')}</p>
                </div>
              )}

              {/* 测试连接按钮 */}
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

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-xs font-medium text-foreground">
                    {i18nService.t('availableModels')}
                  </h3>
                  <button
                    type="button"
                    onClick={handleAddModel}
                    className="inline-flex items-center text-xs text-primary hover:text-primary-hover"
                  >
                    <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
                    {i18nService.t('addModel')}
                  </button>
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
                          <button
                            type="button"
                            onClick={() =>
                              handleEditModel(model.id, model.name, model.supportsImage)
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
                      <button
                        type="button"
                        onClick={handleAddModel}
                        className="mt-1.5 inline-flex items-center text-[11px] font-medium text-primary hover:text-primary-hover"
                      >
                        <PlusCircleIcon className="h-3 w-3 mr-1" />
                        {i18nService.t('addFirstModel')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );

      case 'coworkAgent':
        return (
          <div className="space-y-6">
            {/* Agent Settings (IDENTITY.md + SOUL.md) */}
            <div className="space-y-4 rounded-xl border px-4 py-4 border-border">
              <div className="text-sm font-medium text-foreground">
                {i18nService.t('coworkBootstrapAgentSectionTitle')}
              </div>
              {[
                {
                  filename: 'IDENTITY.md',
                  titleKey: 'coworkBootstrapIdentityTitle',
                  hintKey: 'coworkBootstrapIdentityHint',
                  value: bootstrapIdentity,
                  setter: setBootstrapIdentity,
                },
                {
                  filename: 'SOUL.md',
                  titleKey: 'coworkBootstrapSoulTitle',
                  hintKey: 'coworkBootstrapSoulHint',
                  value: bootstrapSoul,
                  setter: setBootstrapSoul,
                },
              ].map(({ filename, titleKey, hintKey, value, setter }) => (
                <div key={filename} className="space-y-2">
                  <div className="text-xs font-medium text-secondary">
                    {i18nService.t(titleKey)}
                    <span className="ml-1.5 font-normal opacity-60">
                      （{i18nService.t('coworkBootstrapStoragePath')}：
                      <span className="font-mono">
                        {joinWorkspacePath(coworkConfig.workingDirectory, filename)}
                      </span>
                      ）
                    </span>
                  </div>
                  <textarea
                    value={value}
                    onChange={e => setter(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface text-foreground resize-y"
                    placeholder={i18nService.t(hintKey)}
                  />
                </div>
              ))}
            </div>

            {/* User Profile (USER.md) */}
            <div className="space-y-3 rounded-xl border px-4 py-4 border-border">
              <div className="text-sm font-medium text-foreground">
                {i18nService.t('coworkBootstrapUserTitle')}
                <span className="ml-1.5 text-xs font-normal opacity-60 text-secondary">
                  （{i18nService.t('coworkBootstrapStoragePath')}：
                  <span className="font-mono">
                    {joinWorkspacePath(coworkConfig.workingDirectory, 'USER.md')}
                  </span>
                  ）
                </span>
              </div>
              <textarea
                value={bootstrapUser}
                onChange={e => setBootstrapUser(e.target.value)}
                rows={3}
                className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface text-foreground resize-y"
                placeholder={i18nService.t('coworkBootstrapUserHint')}
              />
            </div>
          </div>
        );

      case 'shortcuts':
        return (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-foreground mb-3">
                {i18nService.t('keyboardShortcuts')}
              </label>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground">{i18nService.t('newChat')}</span>
                  <ShortcutRecorder
                    value={shortcuts.newChat}
                    onChange={v => handleShortcutChange('newChat', v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground">{i18nService.t('search')}</span>
                  <ShortcutRecorder
                    value={shortcuts.search}
                    onChange={v => handleShortcutChange('search', v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground">{i18nService.t('openSettings')}</span>
                  <ShortcutRecorder
                    value={shortcuts.settings}
                    onChange={v => handleShortcutChange('settings', v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground">
                    {i18nService.t('sendMessageShortcut')}
                  </span>
                  <SendShortcutSelect
                    value={shortcuts.sendMessage}
                    onChange={v => handleShortcutChange('sendMessage', v)}
                  />
                </div>
              </div>
            </div>
          </div>
        );

      case 'myAgents':
        return <MyAgentsSettings />;

      case 'skills':
        return (
          <div className="space-y-6">
            <SkillsManager readOnly={enterpriseConfig?.ui?.skills === 'readonly'} />
          </div>
        );

      case 'mcp':
        return (
          <div className="space-y-6">
            <McpManager />
          </div>
        );

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
        className="relative flex w-[900px] h-[80vh] rounded-2xl border-border border shadow-modal overflow-hidden modal-content"
        onClick={handleSettingsClick}
      >
        {/* Left sidebar */}
        <div className="w-[220px] shrink-0 flex flex-col bg-surface-raised border-r border-border rounded-l-2xl overflow-y-auto">
          <div className="px-5 pt-5 pb-3">
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
            onClick={() => setIsTestResultModalOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={i18nService.t('connectionTestResult')}
              onClick={e => e.stopPropagation()}
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

              <div className="flex items-center gap-2 text-xs text-secondary">
                <span>{providerMeta[testResult.provider]?.label ?? testResult.provider}</span>
                <span className="text-[11px]">•</span>
                <span
                  className={`inline-flex items-center gap-1 ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                >
                  {testResult.success ? (
                    <CheckCircleIcon className="h-4 w-4" />
                  ) : (
                    <XCircleIcon className="h-4 w-4" />
                  )}
                  {testResult.success
                    ? i18nService.t('connectionSuccess')
                    : i18nService.t('connectionFailed')}
                </span>
              </div>

              <p className="mt-3 text-xs leading-5 text-foreground whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                {testResult.message}
              </p>

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
            onClick={() => setPendingDeleteProvider(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              onClick={e => e.stopPropagation()}
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
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
            onClick={handleCancelModelEdit}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={
                isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')
              }
              onClick={e => e.stopPropagation()}
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

        {/* Memory Modal */}
        {showMemoryModal && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
            onClick={resetCoworkMemoryEditor}
          >
            <div
              className="bg-surface border-border border rounded-2xl shadow-xl w-full max-w-md"
              onClick={e => e.stopPropagation()}
            >
              <div className="px-5 pt-5 pb-4 border-b border-border">
                <h3 className="text-base font-semibold text-foreground">
                  {coworkMemoryEditingId
                    ? i18nService.t('coworkMemoryCrudUpdate')
                    : i18nService.t('coworkMemoryCrudCreate')}
                </h3>
              </div>

              <div className="px-5 py-4 space-y-4">
                {coworkMemoryEditingId && (
                  <div className="rounded-lg border px-2 py-1 text-xs border-border text-secondary">
                    {i18nService.t('coworkMemoryEditingTag')}
                  </div>
                )}
                <textarea
                  value={coworkMemoryDraftText}
                  onChange={event => setCoworkMemoryDraftText(event.target.value)}
                  placeholder={i18nService.t('coworkMemoryCrudTextPlaceholder')}
                  autoFocus
                  className="min-h-[200px] w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <div className="flex justify-end space-x-2 px-5 pb-5">
                <button
                  type="button"
                  onClick={resetCoworkMemoryEditor}
                  className="px-3 py-1.5 text-sm text-foreground hover:bg-surface-raised rounded-xl border border-border transition-colors"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleSaveCoworkMemoryEntry();
                  }}
                  disabled={!coworkMemoryDraftText.trim() || coworkMemoryListLoading}
                  className="px-3 py-1.5 text-sm text-white bg-primary hover:bg-primary-hover rounded-xl disabled:opacity-60 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  {coworkMemoryEditingId
                    ? i18nService.t('save')
                    : i18nService.t('coworkMemoryCrudCreate')}
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
