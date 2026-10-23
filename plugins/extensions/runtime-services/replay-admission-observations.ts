import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { isCoworkSessionKey } from './contracts/session-key';

const REPLAY_ERROR = 'Persisted user turn changed before replay admission';
const REPLAY_ERRORS = new Set([
  REPLAY_ERROR,
  `Error: ${REPLAY_ERROR}`,
  `Your request couldn't be completed: ${REPLAY_ERROR}`,
  `Your request couldn't be completed: Error: ${REPLAY_ERROR}`,
]);
const SOURCE = { PromptBuild: 'before_prompt_build', AgentEnd: 'agent_end' } as const;
const RUNTIME_FAILURE = 'replay_admission_rejected';
const SITE = 'not_exposed';

type HookContext = {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  trace?: { traceId: string; spanId?: string };
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);

const isTraceId = (value: unknown, length: number): value is string =>
  typeof value === 'string' &&
  value.length === length &&
  /^[0-9a-f]+$/.test(value) &&
  /[1-9a-f]/.test(value);

export function registerReplayAdmissionObservations(api: OpenClawPluginApi): void {
  const observe = (source: (typeof SOURCE)[keyof typeof SOURCE], ctx: HookContext): void => {
    // These are independent hook observations, never a cached "last stage" for a run.
    try {
      if (
        !isIdentifier(ctx.runId) ||
        !isIdentifier(ctx.sessionKey) ||
        !isCoworkSessionKey(ctx.sessionKey)
      )
        return;
      const metadata: Record<string, unknown> = {
        source,
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        ...(isIdentifier(ctx.sessionId) ? { sessionId: ctx.sessionId } : {}),
      };
      const trace = ctx.trace;
      if (trace && isTraceId(trace.traceId, 32)) {
        metadata.traceId = trace.traceId;
        if (isTraceId(trace.spanId, 16)) metadata.spanId = trace.spanId;
      }
      const logger = api.runtime.logging.getChildLogger({ subsystem: 'plugins/runtime-services' });
      if (source === SOURCE.AgentEnd) {
        logger.warn('[runtime-services] Replay admission rejection observed', {
          ...metadata,
          runtimeFailure: RUNTIME_FAILURE,
          site: SITE,
        });
      } else {
        logger.info('[runtime-services] Prompt build hook reached', metadata);
      }
    } catch {
      // Optional diagnostic logging must never change prompt construction or failure handling.
    }
  };

  api.on('before_prompt_build', (_event, ctx) => observe(SOURCE.PromptBuild, ctx));
  api.on('agent_end', (event, ctx) => {
    if (
      event.success !== false ||
      typeof event.error !== 'string' ||
      !REPLAY_ERRORS.has(event.error.trim()) ||
      (event.runId !== undefined && event.runId !== ctx.runId)
    )
      return;
    observe(SOURCE.AgentEnd, ctx);
  });
}
