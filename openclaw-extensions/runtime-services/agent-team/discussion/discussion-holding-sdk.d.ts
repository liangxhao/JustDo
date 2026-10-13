// Public v2026.9.8 raw transcript export has no packaged declaration. This is the
// narrow signature consumed here, from src/plugin-sdk/session-transcript-runtime.ts.
declare module 'openclaw/plugin-sdk/session-transcript-runtime' {
  export function readSessionTranscriptRawDelta(params: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    cursor?: string;
    maxBytes: number;
    maxEvents: number;
  }): Promise<
    | {
        kind: 'page';
        events: { event: unknown; seq: number }[];
        cursor: string;
        hasMore: boolean;
        requiredBytes?: number;
        serializedBytes: number;
      }
    | { kind: 'reset'; cursor: string; reason: string }
    | { kind: 'unavailable'; reason: 'projection_rebuilding' }
    | { kind: 'missing' }
  >;
}
