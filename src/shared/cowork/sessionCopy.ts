export const CoworkSessionCopyIpc = {
  Copy: 'cowork:session:copy',
} as const;

export const SessionCopyErrorCode = {
  RuntimeActive: 'runtime_active',
  RuntimeUnknown: 'runtime_unknown',
  SourceUnavailable: 'source_unavailable',
  SourceRestricted: 'source_restricted',
  GatewayUnavailable: 'gateway_unavailable',
  CreationUnconfirmed: 'creation_unconfirmed',
  PreparationFailed: 'preparation_failed',
} as const;

export type SessionCopyErrorCode = (typeof SessionCopyErrorCode)[keyof typeof SessionCopyErrorCode];

export interface CopyCoworkSessionInput {
  sessionId: string;
  title: string;
}
