import { EXTERNAL_AGENT_CATALOG, type ExternalAgentId } from './externalAgentCatalog';

export const ExternalAgentPermissionMode = {
  DenyAll: 'deny-all',
  ReadOnly: 'read-only',
  FullAccess: 'full-access',
} as const;

export type ExternalAgentPermissionMode =
  (typeof ExternalAgentPermissionMode)[keyof typeof ExternalAgentPermissionMode];

export const ExternalAgentReadOnlyViolationBehavior = {
  Continue: 'continue',
  FailTask: 'fail-task',
} as const;

export type ExternalAgentReadOnlyViolationBehavior =
  (typeof ExternalAgentReadOnlyViolationBehavior)[keyof typeof ExternalAgentReadOnlyViolationBehavior];

export const EXTERNAL_AGENT_OPERATION_TIMEOUT_OPTIONS = [30, 60, 120, 180, 300] as const;
export type ExternalAgentOperationTimeoutSeconds =
  (typeof EXTERNAL_AGENT_OPERATION_TIMEOUT_OPTIONS)[number];

export interface ExternalAgentSettings {
  version: 1;
  permissionMode: ExternalAgentPermissionMode;
  readOnlyViolationBehavior: ExternalAgentReadOnlyViolationBehavior;
  operationTimeoutSeconds: ExternalAgentOperationTimeoutSeconds;
  pluginToolsMcpBridge: boolean;
  openClawToolsMcpBridge: boolean;
  shareConfiguredMcpServers: boolean;
  agents: Record<ExternalAgentId, { enabled: boolean }>;
}

export type ExternalAgentTestResult =
  | {
      success: true;
      ready: boolean;
      message: string;
      code?: string;
      details?: string[];
    }
  | { success: false; error: string };

export type ExternalAgentSettingsValidationResult =
  | { ok: true; settings: ExternalAgentSettings }
  | { ok: false; error: string };

const createAgentSettings = (): ExternalAgentSettings['agents'] =>
  Object.fromEntries(
    EXTERNAL_AGENT_CATALOG.map(definition => [
      definition.id,
      { enabled: definition.defaultEnabled },
    ]),
  ) as ExternalAgentSettings['agents'];

export const createDefaultExternalAgentSettings = (): ExternalAgentSettings => ({
  version: 1,
  permissionMode: ExternalAgentPermissionMode.ReadOnly,
  readOnlyViolationBehavior: ExternalAgentReadOnlyViolationBehavior.Continue,
  operationTimeoutSeconds: 120,
  pluginToolsMcpBridge: false,
  openClawToolsMcpBridge: false,
  shareConfiguredMcpServers: false,
  agents: createAgentSettings(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isPermissionMode = (value: unknown): value is ExternalAgentPermissionMode =>
  Object.values(ExternalAgentPermissionMode).some(mode => mode === value);

const isReadOnlyViolationBehavior = (
  value: unknown,
): value is ExternalAgentReadOnlyViolationBehavior =>
  Object.values(ExternalAgentReadOnlyViolationBehavior).some(behavior => behavior === value);

const isOperationTimeout = (value: unknown): value is ExternalAgentOperationTimeoutSeconds =>
  EXTERNAL_AGENT_OPERATION_TIMEOUT_OPTIONS.some(option => option === value);

/**
 * Reads only agents present in the build-time catalog. Missing entries use
 * their safe defaults so a later product build can add agents without a data
 * migration; stale entries from an older build are discarded.
 */
export const validateExternalAgentSettings = (
  value: unknown,
): ExternalAgentSettingsValidationResult => {
  if (!isRecord(value)) {
    return { ok: false, error: 'Invalid external agent settings.' };
  }

  const {
    version,
    permissionMode,
    readOnlyViolationBehavior,
    operationTimeoutSeconds,
    pluginToolsMcpBridge,
    openClawToolsMcpBridge,
    shareConfiguredMcpServers,
    agents: storedAgents,
  } = value;

  if (version !== 1 || !isPermissionMode(permissionMode) || !isRecord(storedAgents)) {
    return { ok: false, error: 'Invalid external agent settings.' };
  }
  let validatedReadOnlyViolationBehavior: ExternalAgentReadOnlyViolationBehavior =
    ExternalAgentReadOnlyViolationBehavior.Continue;
  if (readOnlyViolationBehavior !== undefined) {
    if (!isReadOnlyViolationBehavior(readOnlyViolationBehavior)) {
      return { ok: false, error: 'Invalid external agent settings.' };
    }
    validatedReadOnlyViolationBehavior = readOnlyViolationBehavior;
  }

  let validatedOperationTimeoutSeconds: ExternalAgentOperationTimeoutSeconds = 120;
  if (operationTimeoutSeconds !== undefined) {
    if (!isOperationTimeout(operationTimeoutSeconds)) {
      return { ok: false, error: 'Invalid external agent settings.' };
    }
    validatedOperationTimeoutSeconds = operationTimeoutSeconds;
  }

  let validatedPluginToolsMcpBridge = false;
  if (pluginToolsMcpBridge !== undefined) {
    if (typeof pluginToolsMcpBridge !== 'boolean') {
      return { ok: false, error: 'Invalid external agent settings.' };
    }
    validatedPluginToolsMcpBridge = pluginToolsMcpBridge;
  }

  let validatedOpenClawToolsMcpBridge = false;
  if (openClawToolsMcpBridge !== undefined) {
    if (typeof openClawToolsMcpBridge !== 'boolean') {
      return { ok: false, error: 'Invalid external agent settings.' };
    }
    validatedOpenClawToolsMcpBridge = openClawToolsMcpBridge;
  }

  let validatedShareConfiguredMcpServers = false;
  if (shareConfiguredMcpServers !== undefined) {
    if (typeof shareConfiguredMcpServers !== 'boolean') {
      return { ok: false, error: 'Invalid external agent settings.' };
    }
    validatedShareConfiguredMcpServers = shareConfiguredMcpServers;
  }

  const agents = createAgentSettings();
  for (const definition of EXTERNAL_AGENT_CATALOG) {
    const entry = storedAgents[definition.id];
    if (entry === undefined) continue;
    if (!isRecord(entry) || typeof entry.enabled !== 'boolean') {
      return { ok: false, error: `Invalid external agent settings for ${definition.id}.` };
    }
    agents[definition.id] = { enabled: entry.enabled };
  }

  return {
    ok: true,
    settings: {
      version: 1,
      permissionMode,
      readOnlyViolationBehavior: validatedReadOnlyViolationBehavior,
      operationTimeoutSeconds: validatedOperationTimeoutSeconds,
      pluginToolsMcpBridge: validatedPluginToolsMcpBridge,
      openClawToolsMcpBridge: validatedOpenClawToolsMcpBridge,
      shareConfiguredMcpServers: validatedShareConfiguredMcpServers,
      agents,
    },
  };
};

export const parseExternalAgentSettings = (value: unknown): ExternalAgentSettings => {
  const validation = validateExternalAgentSettings(value);
  return validation.ok ? validation.settings : createDefaultExternalAgentSettings();
};

export const ExternalAgentIpc = {
  GET_SETTINGS: 'openclaw:externalAgents:getSettings',
  SET_SETTINGS: 'openclaw:externalAgents:setSettings',
  TEST: 'openclaw:externalAgents:test',
} as const;

export type { ExternalAgentId } from './externalAgentCatalog';
export { EXTERNAL_AGENT_CATALOG, EXTERNAL_AGENT_IDS } from './externalAgentCatalog';
