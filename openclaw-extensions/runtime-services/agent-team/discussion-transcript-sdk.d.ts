// v2026.9.8 still publishes this SDK entry point without its .d.ts. Keep the narrow
// consumed signatures aligned with src/plugin-sdk/session-transcript-runtime.ts.
declare module 'openclaw/plugin-sdk/session-transcript-runtime' {
  interface Target {
    agentId?: string;
    sessionId: string;
    sessionKey: string;
  }
  export function readVisibleSessionTranscriptMessageEntries(target: Target): Promise<
    Array<{
      entryId: string;
      message: unknown;
      seq: number;
    }>
  >;
  export function appendSessionTranscriptMessageByIdentity<T>(
    params: Target & {
      config?: import('openclaw/plugin-sdk/core').OpenClawConfig;
      message: T;
      idempotencyLookup?: 'scan' | 'scan-assistant' | 'caller-checked';
      beforeFreshMessageCommit?: () => void;
    },
  ): Promise<{ messageId: string; appended: boolean; message: T } | undefined>;
}
