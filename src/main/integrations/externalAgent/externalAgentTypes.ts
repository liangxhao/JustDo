import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import type { GatewayClientLike } from '../../engine/gateway/types';

export interface ExternalAgentModel {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface ExternalAgentThread {
  id: string;
  cwd: string;
  agentId: string;
  modelRef?: string;
}

export interface ExternalAgentNativeBinding {
  localSessionId: string;
  runId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  client: GatewayClientLike;
}

export interface ExternalAgentRunHooks {
  /** Main-only declaration of an interactive approval presenter installed by onPrepared. */
  interactiveApprovals?: true;
  /** Installs session-scoped tools and approval ownership before native admission. */
  onPrepared?: (
    binding: ExternalAgentNativeBinding,
  ) => Promise<void | (() => void | Promise<void>)>;
}

export const ExternalAgentExecutionOutcome = {
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type ExternalAgentExecutionOutcome =
  (typeof ExternalAgentExecutionOutcome)[keyof typeof ExternalAgentExecutionOutcome];

export interface ExternalAgentBackend {
  models: () => ExternalAgentModel[];
  start: (params: {
    cwd: string;
    agentId?: string;
    model?: string;
    /** Local metadata setup before a new, empty product conversation is exposed. */
    onCreated?: (thread: ExternalAgentThread) => void;
  }) => Promise<ExternalAgentThread>;
  resume: (id: string, params: { cwd?: string; model?: string }) => Promise<ExternalAgentThread>;
  run: (
    thread: ExternalAgentThread,
    runId: string,
    message: string,
    onEvent: (event: NormalizedAgentEvent) => void,
    signal: AbortSignal,
    hooks?: ExternalAgentRunHooks,
  ) => Promise<string>;
}

export type ExternalAgentExecution = (input: {
  sessionId: string;
  runId: string;
  message: string;
  modelRef?: string;
  onEvent: (event: NormalizedAgentEvent) => void;
  signal: AbortSignal;
  hooks?: ExternalAgentRunHooks;
  onUnconfirmed?: () => void;
  onSettled?: (outcome: ExternalAgentExecutionOutcome) => void;
  expectedBinding?: {
    sessionKey: string;
    sessionId: string;
    lifecycleRevision: string;
  };
}) => Promise<string>;

/** An output transport failure must not be classified as a human cancellation. */
export class ExternalAgentStreamError extends Error {}

/** Exact native cancellation, or explicit withdrawal before native submission. */
export class ExternalAgentCancelledError extends Error {}

/** A reservation survives this error; a new task must not replay uncertain work. */
export class ExternalAgentOutcomeUnknownError extends Error {}
