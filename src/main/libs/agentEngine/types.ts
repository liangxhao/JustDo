/**
 * Permission result type for tool permission responses.
 * Matches the structure used by OpenClaw runtime.
 */
export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>;
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
    };

import type { CoworkMessage } from '../../coworkStore';

export type CoworkAgentEngine = 'openclaw';

// ============================================================
// Gateway Skill Types
// ============================================================

/**
 * Gateway skill status response from skills.status RPC.
 */
export interface GatewaySkillStatus {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: GatewaySkillEntry[];
}

/**
 * Single skill entry in skills.status response.
 */
export interface GatewaySkillEntry {
  name: string;
  description: string;
  source:
    | 'workspace'
    | 'agents-project'
    | 'agents-personal'
    | 'managed'
    | 'openclaw-bundled'
    | 'extra-dir'
    | 'unknown';
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  missing: GatewaySkillMissing;
  install: GatewaySkillInstallOption[];
  configChecks: Array<{ path: string; satisfied: boolean }>;
}

/**
 * Missing requirements for a skill.
 */
export interface GatewaySkillMissing {
  bins: string[];
  env: string[];
  config: string[];
  os: string[];
}

/**
 * Install option for a skill with missing requirements.
 */
export interface GatewaySkillInstallOption {
  id: string;
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download' | 'script';
  label: string;
  bins?: string[];
  formula?: string;
  url?: string;
  hint?: string;
  optional?: boolean;
}

/**
 * ClawHub search result from skills.search RPC.
 */
export interface ClawHubSearchResult {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  homepage?: string;
}

/**
 * ClawHub skill detail from skills.detail RPC.
 */
export interface ClawHubDetail {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  homepage?: string;
  readme?: string;
  install?: {
    requires?: {
      bins?: string[];
      env?: string[];
    };
  };
}

/**
 * Parameters for skills.install RPC.
 */
export type SkillInstallParams =
  | {
      source: 'clawhub';
      slug: string;
      version?: string;
      force?: boolean;
    }
  | {
      name: string;
      installId: string;
      dangerouslyForceUnsafeInstall?: boolean;
      timeoutMs?: number;
    };

/**
 * Parameters for skills.update RPC (config mode).
 */
export interface SkillUpdateParams {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string | { source: string; provider: string; id: string };
  env?: Record<string, string>;
}

/**
 * Result from skills.install or skills.update RPC.
 */
export interface SkillRpcResult {
  ok: boolean;
  error?: string;
  message?: string;
}

// ============================================================
// End Gateway Skill Types
// ============================================================

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string | null;
}

export interface CoworkRuntimeEvents {
  message: (sessionId: string, message: CoworkMessage) => void;
  messageUpdate: (sessionId: string, messageId: string, content: string) => void;
  messageMetadataUpdate: (
    sessionId: string,
    messageId: string,
    metadata: Partial<CoworkMessage['metadata']>,
  ) => void;
  messageDelete: (sessionId: string, messageId: string) => void;
  thinkingUpdate: (sessionId: string, messageId: string, thinkingDelta: string) => void;
  permissionRequest: (sessionId: string, request: PermissionRequest) => void;
  complete: (
    sessionId: string,
    claudeSessionId: string | null,
    finalStatus?: 'idle' | 'running' | 'completed' | 'error',
  ) => void;
  error: (sessionId: string, error: string) => void;
  sessionStopped: (sessionId: string) => void;
}

export type CoworkImageAttachment = {
  name: string;
  mimeType: string;
  base64Data: string;
};

export type CoworkStartOptions = {
  skipInitialUserMessage?: boolean;
  skillIds?: string[];
  autoApprove?: boolean;
  workspaceRoot?: string;
  confirmationMode?: 'modal' | 'text';
  imageAttachments?: CoworkImageAttachment[];
  agentId?: string;
};

export type CoworkContinueOptions = {
  skillIds?: string[];
  imageAttachments?: CoworkImageAttachment[];
};

export interface CoworkRuntime {
  on<U extends keyof CoworkRuntimeEvents>(event: U, listener: CoworkRuntimeEvents[U]): this;
  off<U extends keyof CoworkRuntimeEvents>(event: U, listener: CoworkRuntimeEvents[U]): this;
  startSession(sessionId: string, prompt: string, options?: CoworkStartOptions): Promise<void>;
  continueSession(
    sessionId: string,
    prompt: string,
    options?: CoworkContinueOptions,
  ): Promise<void>;
  stopSession(sessionId: string): void;
  stopAllSessions(): void;
  respondToPermission(requestId: string, result: PermissionResult): void;
  isSessionActive(sessionId: string): boolean;
  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null;
  onSessionDeleted?(sessionId: string, agentId?: string): void;
  /**
   * Generate a session title using the configured model.
   * Optional: only implemented by OpenClawRuntimeAdapter which has Gateway access.
   * @param userIntent The user's initial prompt to generate title from
   * @param timeoutMs Timeout in milliseconds (default 30000ms)
   * @returns Generated title, or fallback if generation fails
   */
  generateTitle?(userIntent: string | null, timeoutMs?: number): Promise<string>;
  /**
   * Patch the model for a session via OpenClaw gateway sessions.patch API.
   * Optional: only implemented by OpenClawRuntimeAdapter which has Gateway access.
   * @param sessionId The session ID to patch
   * @param model The qualified model reference (e.g. "provider/model-id")
   * @param agentId The agent ID (defaults to 'main')
   */
  patchSessionModel?(
    sessionId: string,
    model: string,
    agentId?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  getSessionRuntimeStatus?(sessionId: string): Promise<{
    mainRunning: boolean;
    subagentRunning: boolean;
    running: boolean;
  }>;
}
