import type { CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import type { SessionRunTiming } from '../../../shared/cowork/sessionRun';
import type { ExternalSessionStatus } from '../../../shared/integrations/externalSession';
import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import type { PermissionMode } from '../../../shared/security/approvals';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { ExternalExecutionState } from './externalSessionStore';

export interface ExternalAgentModel {
  id: string;
  name: string;
  isDefault: boolean;
  inputModalities?: readonly ('text' | 'image')[];
}

export interface ExternalAgentThread {
  id: string;
  cwd: string;
  agentId: string;
  modelRef?: string;
}

/** Product metadata only; native session identities never cross the client boundary. */
export interface ExternalAgentThreadMetadata extends ExternalAgentThread {
  name: string;
  createdAt: number;
  updatedAt: number;
  permissionMode: PermissionMode;
  status: ExternalSessionStatus;
  executionState?: ExternalExecutionState;
}

/** Main-only native identity supplied to the authenticated history loader. */
export interface ExternalAgentHistoryInput {
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string;
}

export interface ExternalAgentHistorySnapshot {
  messages: unknown[];
}

/** One verified native snapshot and its separately persisted execution receipts. */
export interface ExternalAgentThreadHistory extends ExternalAgentHistorySnapshot {
  threadId: string;
  runs: SessionRunTiming[];
  /** Exact external execution receipt permitted to appear even before native message admission. */
  latestExternalRunId?: string;
  unknownRunId?: string;
  /** Opaque incarnation pin for pagination; never contains raw native identities. */
  identityRevision?: string;
}

export interface ExternalAgentNativeBinding {
  localSessionId: string;
  runId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  client: GatewayClientLike;
  /** Media-only native admission binds approvals only after its verified ACK. */
  runIdReady?: Promise<string | undefined>;
}

export interface ExternalAgentRunHooks {
  /** Validated host media; text-only transports leave this absent. */
  attachments?: readonly CoworkAttachmentPayload[];
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
  describe?: (id: string) => ExternalAgentThreadMetadata;
  list?: () => ExternalAgentThreadMetadata[];
  setName?: (id: string, name: string) => void;
  history?: (id: string) => Promise<ExternalAgentThreadHistory>;
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
  attachments?: readonly CoworkAttachmentPayload[];
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

/** Admission was rejected because the product conversation is already reserved. */
export class ExternalAgentBusyError extends Error {}

/** Exact native cancellation, or explicit withdrawal before native submission. */
export class ExternalAgentCancelledError extends Error {}

/** A reservation survives this error; a new task must not replay uncertain work. */
export class ExternalAgentOutcomeUnknownError extends Error {}
