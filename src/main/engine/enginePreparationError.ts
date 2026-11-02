/** A preparation observation was superseded or is still pending, rather than a concrete engine failure. */
export const EnginePreparationPendingCode = {
  SUPERSEDED: 'superseded',
  LIFECYCLE_CHANGED: 'lifecycle_changed',
  STARTING: 'starting',
  UNCONFIRMED: 'unconfirmed',
} as const;

export class EnginePreparationPendingError extends Error {
  constructor(
    readonly code: (typeof EnginePreparationPendingCode)[keyof typeof EnginePreparationPendingCode],
    message: string,
  ) {
    super(message);
    this.name = 'EnginePreparationPendingError';
  }
}
