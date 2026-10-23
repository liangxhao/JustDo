export const ExternalSessionSource = {
  /** Historical persisted namespace; new protocol clients all use Cli. */
  HistoricalAppServer: 'multica',
  Cli: 'cli',
} as const;

export type ExternalSessionSource =
  (typeof ExternalSessionSource)[keyof typeof ExternalSessionSource];

export const ExternalSessionStatus = {
  Running: 'running',
  Completed: 'completed',
  Error: 'error',
  Cancelled: 'cancelled',
} as const;

export type ExternalSessionStatus =
  (typeof ExternalSessionStatus)[keyof typeof ExternalSessionStatus];

export interface ExternalSessionMetadata {
  origin: ExternalSessionSource;
  readOnly: true;
  status: ExternalSessionStatus;
  sessionKey: string;
}
