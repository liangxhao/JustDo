import type { AskUserInteractionEnvelope } from './askUserQuestion';
import type { PlanModeInteractionEnvelope } from './planMode';

export type CoworkInteractionEnvelope = AskUserInteractionEnvelope | PlanModeInteractionEnvelope;

/** Display ownership only. Native request identity and authorization remain independent. */
export interface CoworkInteractionOrigin {
  sessionKey: string;
  nativeSessionId?: string;
  toolCallId?: string;
  runId?: string;
  agentId?: string;
  createdAt?: number;
  ownerSessionId?: string;
  label?: string;
  pluginId?: string;
  epoch?: string;
  available: boolean;
}

export const CoworkInteractionKind = {
  STRUCTURED_QUESTION: 'structured-question',
  PLAN_APPROVAL: 'plan-approval',
} as const;

export const CoworkInteractionIpc = {
  Respond: 'cowork:interaction:respond',
  Replay: 'cowork:interaction:replay',
  Stream: 'cowork:stream:interaction',
  Dismiss: 'cowork:stream:interactionDismiss',
} as const;

export type CoworkInteractionKind =
  (typeof CoworkInteractionKind)[keyof typeof CoworkInteractionKind];
