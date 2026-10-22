/** Trusted local proof: preparation failed before invoking the native run API. */
export class NativeLaunchNotInvokedError extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = 'NativeLaunchNotInvokedError';
  }
}
