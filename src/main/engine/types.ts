import type { OpenClawSkillSource } from '../../shared/plugins/skills';
import type { CoworkMessage } from '../data/coworkStore';

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
  source: OpenClawSkillSource;
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
 * Parameters for skills.update RPC (config mode).
 */
export interface SkillUpdateParams {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string | { source: string; provider: string; id: string };
  env?: Record<string, string>;
}

/**
 * Result from the skills.update RPC.
 */
export interface SkillRpcResult {
  ok: boolean;
  error?: string;
  message?: string;
}

// ============================================================
// End Gateway Skill Types
// ============================================================

export interface CoworkRuntimeEvents {
  message: (sessionId: string, message: CoworkMessage) => void;
  messageUpdate: (sessionId: string, messageId: string, content: string) => void;
  messageMetadataUpdate: (
    sessionId: string,
    messageId: string,
    metadata: Partial<NonNullable<CoworkMessage['metadata']>>,
    extra?: {
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    },
  ) => void;
  messageDelete: (sessionId: string, messageId: string) => void;
  thinkingUpdate: (sessionId: string, messageId: string, thinkingDelta: string) => void;
  complete: (sessionId: string, finalStatus?: 'idle' | 'running' | 'completed' | 'error') => void;
  error: (sessionId: string, error: string) => void;
  sessionStopped: (sessionId: string) => void;
}

import type { CoworkAttachmentPayload } from '../../shared/cowork/attachments';

export type CoworkStartOptions = {
  skipInitialUserMessage?: boolean;
  skillIds?: string[];
  autoApprove?: boolean;
  workspaceRoot?: string;
  confirmationMode?: 'modal' | 'text';
  attachments?: CoworkAttachmentPayload[];
  agentId?: string;
};

export type CoworkContinueOptions = {
  skillIds?: string[];
  attachments?: CoworkAttachmentPayload[];
};

export type CoworkStopOptions = {
  /** Continue local cleanup when Gateway confirmation is unavailable. */
  bestEffort?: boolean;
};

export interface CoworkGenerateTitleOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export interface CoworkRuntime {
  on<U extends keyof CoworkRuntimeEvents>(event: U, listener: CoworkRuntimeEvents[U]): this;
  off<U extends keyof CoworkRuntimeEvents>(event: U, listener: CoworkRuntimeEvents[U]): this;
  startSession(sessionId: string, prompt: string, options?: CoworkStartOptions): Promise<void>;
  continueSession(
    sessionId: string,
    prompt: string,
    options?: CoworkContinueOptions,
  ): Promise<void>;
  stopSession(sessionId: string, options?: CoworkStopOptions): Promise<void>;
  stopAllSessions(): Promise<void>;
  isSessionActive(sessionId: string): boolean;
  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null;
  onSessionDeleted?(sessionId: string, agentId?: string): void;
  /**
   * Generate a session title using the configured model.
   * Optional: only implemented by OpenClawRuntimeAdapter which has Gateway access.
   * @param userIntent The user's initial prompt to generate title from
   * @param options Local session context and timeout.
   * @returns Generated title, or fallback if generation fails
   */
  generateTitle?(
    userIntent: string | null,
    options?: CoworkGenerateTitleOptions,
  ): Promise<string>;
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
  getSessionRuntimeStatus?(
    sessionId: string,
    options?: { includeSubagents?: boolean; forceRefresh?: boolean },
  ): Promise<{
    known: boolean;
    mainRunning: boolean;
    subagentRunning: boolean;
    running: boolean;
  }>;
  getSessionRuntimeStatuses?(
    sessionIds: string[],
    options?: { includeSubagents?: boolean; forceRefresh?: boolean },
  ): Promise<
    Record<
      string,
      {
        known: boolean;
        mainRunning: boolean;
        subagentRunning: boolean;
        running: boolean;
      }
    >
  >;
}
