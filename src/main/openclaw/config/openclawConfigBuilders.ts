import { type AgentRuntimeSettings } from '../../../shared/agents/agentRuntimeSettings';
import { type BrowserMode as BrowserModeValue } from '../../../shared/browser/browser';
import { type ExternalAgentSettings } from '../../../shared/integrations/externalAgents';
import type { Agent, CoworkConfig } from '../../data/coworkStore';
import type { OpenClawHookRecord } from '../../plugins/hooks';
import type { McpServerRecord } from '../../plugins/mcp';
import type { OpenClawEngineManager } from '../runtime/openclawEngineManager';
import type { ManagedSpeechModelSettings } from './speech/speechModelConfig';

// Public configuration entry point; projections live with their owning capability.

// Context compaction has its own OpenClaw safety timeout. Keep it aligned with
// the provider ceiling so a healthy long-context SSE response is not aborted
// by the much shorter upstream default (180s).
export { OPENCLAW_COMPACTION_TIMEOUT_SECONDS } from '../../../shared/openclaw/compaction';

export type OpenClawConfigSyncDeps = {
  engineManager: OpenClawEngineManager;
  getCoworkConfig: () => CoworkConfig;
  getAgentRuntimeSettings?: () => AgentRuntimeSettings;
  getExternalAgentSettings?: () => ExternalAgentSettings;
  getMcpServers?: () => McpServerRecord[];
  getHooks?: () => OpenClawHookRecord[];
  getAgents?: () => Agent[];
  getAppPluginEntries?: () => Record<string, unknown>;
  getAppPluginDefaults?: () => Record<string, { defaultEnabled: boolean; userToggleable: boolean }>;
  getAppPluginPolicy?: () => { sandboxTools?: string[]; surfaces?: Record<string, unknown> };
  getBrowserMode?: () => BrowserModeValue;
  getDecisionModelCategory?: () => unknown;
  getNativeVideoCategory?: () => unknown;
  getSpeechModelSettings?: () => ManagedSpeechModelSettings;
  getLocalSttConfig?: () => Record<string, unknown> | null;
  getLocalTtsConfig?: () => Record<string, unknown> | null;
  getLocalSpeechExtensionTtsConfig?: () => Record<string, unknown> | null;
  getSpeechOutputState?: () => { enabled: boolean; mode: 'local' | 'online' };
  getWindowsSandboxEnvironment?: () => Record<string, string>;
};

export * from './agents/agentProjection';
export * from './configCompatibility';
export * from './configShape';
export * from './configVerification';
export * from './models/authScopedProjection';
export * from './models/builtinSecretProjection';
export * from './models/providerProjection';
export * from './plugins/extensionInventory';
export * from './plugins/mcpProjection';
export * from './plugins/pluginProjection';
export * from './policies/executionPolicyProjection';
export * from './speech/onlineSpeechProjection';
