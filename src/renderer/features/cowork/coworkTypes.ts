import type { CoworkAttachmentPayload } from '@shared/cowork/attachments';
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import type { CoworkInteractionKind } from '@shared/openclaw/extensions';

export type { CoworkAttachmentPayload } from '@shared/cowork/attachments';

// Cowork session status
export type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error';

// Session Group types
export interface SessionGroup {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  createdAt: number;
}

export interface CreateGroupInput {
  name: string;
  color?: string;
}

export interface UpdateGroupInput {
  name?: string;
  color?: string;
  sortOrder?: number;
}

// Group color presets — balanced accents that remain distinct in light and dark themes
export const GROUP_COLORS = [
  '#ef6a6a', // coral
  '#e9894a', // amber
  '#d6a51d', // ochre
  '#84b83f', // leaf
  '#3daf7d', // emerald
  '#359daf', // cyan
  '#4f8edc', // blue
  '#6f7ed8', // indigo
  '#956fd1', // violet
  '#bf68bd', // orchid
  '#d96893', // rose
  '#8b72ca', // amethyst
  '#52a96a', // green
  '#74839a', // slate
  '#81766f', // stone
  '#9297a3', // gray
];

// Cowork message types
export type CoworkMessageType =
  'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'subagent_completion';

// Cowork execution mode
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';
export type CoworkAgentEngine = 'openclaw';

// Cowork message metadata
export interface CoworkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string | Record<string, unknown>;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  isThinking?: boolean;
  skillIds?: string[]; // Skills used for this message
  [key: string]: unknown;
}

// Token usage for a single message
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// Cowork message
export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
  thinkingContent?: string; // Accumulated thinking content during streaming
  modelName?: string; // Model that generated this message (for assistant messages)
  usage?: TokenUsage; // Token usage for assistant messages
}

// Cowork session
export interface CoworkSession {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  cwd: string;
  executionMode: CoworkExecutionMode;
  permissionMode: PermissionMode;
  activeSkillIds: string[];
  agentId: string;
  modelRef?: string;
  messages: CoworkMessage[];
  createdAt: number;
  updatedAt: number;
}

// Cowork configuration
export interface CoworkConfig {
  workingDirectory: string;
  executionMode: CoworkExecutionMode;
  agentEngine: CoworkAgentEngine;
  permissionMode: PermissionMode;
  maxGoalContinuationTurns?: number;
}

export type CoworkConfigUpdate = Partial<
  Pick<
    CoworkConfig,
    | 'workingDirectory'
    | 'executionMode'
    | 'agentEngine'
    | 'permissionMode'
    | 'maxGoalContinuationTurns'
  >
>;

export interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'openai';
}

export type OpenClawEnginePhase = 'ready' | 'starting' | 'running' | 'error';

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  message?: string;
  canRetry: boolean;
}

// Cowork pending extension interaction request
export interface CoworkInteractionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
  interactionKind?: CoworkInteractionKind;
}

export type CoworkInteractionPresentation = 'modal' | 'floating';

export type CoworkInteractionResult =
  | {
      behavior: 'submit';
      updatedInput?: Record<string, unknown>;
      toolUseID?: string;
    }
  | {
      behavior: 'cancel';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

// Cowork extension interaction response
export interface CoworkInteractionResponse {
  requestId: string;
  result: CoworkInteractionResult;
}

// Session summary for list display (without full messages)
export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  groupId?: string | null;
  agentId?: string;
  createdAt: number;
  updatedAt: number;
}

// Start session options
export interface CoworkStartOptions {
  prompt: string;
  cwd?: string;
  title?: string;
  activeSkillIds?: string[];
  agentId?: string;
  attachments?: CoworkAttachmentPayload[];
  permissionMode?: PermissionMode;
  clientTurnId?: string;
  startedAt?: number;
}

// Continue session options
export interface CoworkContinueOptions {
  sessionId: string;
  prompt: string;
  activeSkillIds?: string[];
  attachments?: CoworkAttachmentPayload[];
}

export type { SessionRunTiming };

// IPC result types
export interface CoworkSessionResult {
  success: boolean;
  session?: CoworkSession;
  error?: string;
}

export interface CoworkSessionListResult {
  success: boolean;
  sessions?: CoworkSessionSummary[];
  error?: string;
}

export interface CoworkConfigResult {
  success: boolean;
  config?: CoworkConfig;
  error?: string;
}

// Stream event types for IPC communication
export type CoworkStreamEventType =
  'message' | 'tool_use' | 'tool_result' | 'interaction_request' | 'complete' | 'error';

export interface CoworkStreamEvent {
  type: CoworkStreamEventType;
  sessionId: string;
  data: {
    message?: CoworkMessage;
    interaction?: CoworkInteractionRequest;
    error?: string;
  };
}
import type { PermissionMode } from '@shared/openclaw/approvals';
