import { normalizeAgentEvent } from '../../../shared/openclaw/agentEvent';
import { isGatewayRequestOutcomeUnknown } from '../../../shared/openclaw/gatewayRequestOutcome';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { GatewayClientLike, GatewayEventFrame } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import type { OpenClawEngineStatus } from '../../openclaw/runtime/openclawEngineManager';
import type { MulticaCodexBackendOptions } from './multicaCodexBackend';
import { MulticaCodexStreamError } from './multicaCodexSession';

interface Dependencies {
  getStore: () => CoworkStore;
  getRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  ensureReady: () => Promise<Pick<OpenClawEngineStatus, 'phase' | 'message'>>;
}

/** Uses the same authenticated Gateway and subscriptions as browser chat. */
export function createMulticaCodexExecution(
  deps: Dependencies,
): MulticaCodexBackendOptions['execute'] {
  return async ({ sessionId, runId, message, modelRef, onEvent, signal, onPrepared }) => {
    const readiness = await deps.ensureReady();
    if (readiness.phase !== 'running')
      throw new Error(readiness.message || 'Execution runtime is unavailable.');
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) throw new Error('Conversation is unavailable.');
    const router = deps.getRouter();
    if (router.isSessionActive(sessionId))
      throw new Error('Conversation already has an active turn.');
    const prepared = await router.prepareSession(sessionId, {
      agentId: session.agentId,
      permissionMode: session.permissionMode,
      workspaceRoot: session.cwd,
    });
    const runtime = deps.getRuntime();
    if (!runtime) throw new Error('Execution runtime is unavailable.');
    await runtime.ensureReady();
    const client = runtime.getGatewayClient();
    const key = prepared.sessionKey;
    if (!client || !key) throw new Error('Native conversation is unavailable.');
    const subscription = { key, subscriptionId: `multica:${runId}` };
    let subscribedClient: GatewayClientLike | undefined;
    let subscriptionCleanupClient: GatewayClientLike | undefined;
    const subscribe = async (current: GatewayClientLike): Promise<void> => {
      if (subscribedClient === current) return;
      if (subscribedClient) continuationReply = undefined;
      subscriptionCleanupClient = current;
      await current.request('sessions.messages.subscribe', subscription);
      subscribedClient = current;
    };
    let yielded = false;
    let continuationReply: { status: string; text?: string; silent?: boolean } | undefined;
    onPrepared(key);
    if (signal.aborted) throw new Error('Task cancelled.');
    if (modelRef) {
      const patched = await runtime.patchSessionModel(sessionId, modelRef, session.agentId);
      if (patched.ok === false)
        throw new Error(patched.error || 'The selected model could not be applied.');
      if (signal.aborted) throw new Error('Task cancelled.');
    }
    const handle = (frame: GatewayEventFrame): void => {
      if (frame.event !== 'agent' && frame.event !== 'session.tool') return;
      const event = normalizeAgentEvent({
        deliveryEvent: frame.event,
        payload: frame.payload,
        frameSeq: frame.seq,
      }).event;
      if (event?.sessionKey !== key) return;
      if (
        yielded &&
        event.runId !== runId &&
        event.stream === 'lifecycle' &&
        event.data.phase === 'start'
      )
        continuationReply = undefined;
      if (
        yielded &&
        event.runId !== runId &&
        event.stream === 'lifecycle' &&
        event.data.executionSettled === true &&
        event.data.yielded !== true
      ) {
        const reply = event.data.terminalReply as
          { disposition?: string; text?: string } | undefined;
        const text = reply?.text;
        continuationReply = {
          status:
            event.data.phase === 'error' ||
            event.data.aborted === true ||
            event.data.stopReason === 'aborted' ||
            event.data.stopReason === 'rpc'
              ? 'error'
              : 'ok',
          ...(typeof text === 'string' && text.length <= 2 * 1024 * 1024 ? { text } : {}),
          silent: reply?.disposition === 'silent',
        };
      }
      if (event.runId === runId || yielded) onEvent(event);
    };
    const abort = (): void => {
      if (yielded) {
        void router.stopSession(sessionId).catch(() => {});
        return;
      }
      void runtime
        .getGatewayClient()
        ?.request('sessions.abort', { key, runId })
        .catch(() => {});
    };
    type Result = {
      status: string;
      summary?: string;
      result?: {
        meta?: { yielded?: boolean };
        payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
      };
    };
    const waitForContinuation = async (): Promise<Result> => {
      yielded = true;
      for (;;) {
        try {
          await runtime.ensureReady();
          const current = runtime.getGatewayClient();
          if (current) {
            await subscribe(current);
            if (signal.aborted) await router.stopSession(sessionId);
            const state = await runtime.getSessionRuntimeStatus(sessionId, {
              includeSubagents: true,
              forceRefresh: true,
              fullScan: true,
            });
            if (state.known && !state.running) {
              if (signal.aborted) return { status: 'ok', result: { payloads: [] } };
              if (
                !continuationReply ||
                (continuationReply.status === 'ok' &&
                  !continuationReply.text &&
                  !continuationReply.silent)
              ) {
                // Read through the Gateway only after settlement. Require the
                // current user input identity and an attributable terminal reply;
                // never mistake an earlier conversation's answer for this turn.
                const history = await current
                  .request<{
                    messages?: Array<Record<string, unknown>>;
                  }>('chat.history', { sessionKey: key, limit: 200 })
                  .catch(() => ({ messages: [] as Array<Record<string, unknown>> }));
                const messages = history.messages ?? [];
                const metadata = (value: Record<string, unknown>) =>
                  (value.__openclaw ?? {}) as Record<string, unknown>;
                const start = messages.findIndex(
                  value =>
                    value.role === 'user' &&
                    (value.idempotencyKey === `${runId}:user` ||
                      metadata(value).idempotencyKey === `${runId}:user`),
                );
                const tail = start < 0 ? [] : messages.slice(start + 1);
                if (!tail.some(value => value.role === 'user')) {
                  const last = tail.findLast(
                    value =>
                      value.role === 'assistant' &&
                      typeof metadata(value).runId === 'string' &&
                      metadata(value).runId !== runId,
                  );
                  if (last) {
                    const receipt = await current
                      .request<{
                        runId?: string;
                        status?: string;
                        endedAt?: number;
                        yielded?: boolean;
                        terminalReply?: { disposition?: string; text?: string };
                      }>('agent.wait', { runId: metadata(last).runId, timeoutMs: 0 })
                      .catch((): null => null);
                    const authoritative =
                      receipt &&
                      (!receipt.runId || receipt.runId === metadata(last).runId) &&
                      !receipt.yielded &&
                      (receipt.status === 'ok' ||
                        receipt.status === 'error' ||
                        (receipt.status === 'timeout' && typeof receipt.endedAt === 'number'));
                    const historyText =
                      typeof last.text === 'string'
                        ? last.text
                        : Array.isArray(last.content)
                          ? last.content
                              .filter(
                                value => value?.type === 'text' && typeof value.text === 'string',
                              )
                              .map(value => value.text)
                              .join('\n')
                          : '';
                    const silent = receipt?.terminalReply?.disposition === 'silent';
                    const terminalContent =
                      last.stopReason !== 'toolUse' &&
                      !(
                        Array.isArray(last.content) &&
                        last.content.some(value =>
                          ['toolCall', 'toolUse', 'functionCall'].includes(value?.type),
                        )
                      );
                    const text = silent
                      ? ''
                      : receipt?.terminalReply?.disposition === 'visible'
                        ? receipt.terminalReply.text
                        : terminalContent
                          ? historyText
                          : undefined;
                    if (
                      authoritative &&
                      (silent || (typeof text === 'string' && text.length <= 2 * 1024 * 1024))
                    )
                      continuationReply = {
                        status: receipt.status === 'ok' ? 'ok' : 'error',
                        text,
                        silent,
                      };
                  }
                }
              }
              return continuationReply && (continuationReply.text || continuationReply.silent)
                ? {
                    status: continuationReply.status,
                    result: { payloads: [{ text: continuationReply.text }] },
                  }
                : {
                    status: 'error',
                    summary:
                      'Execution settled, but its continuation reply could not be recovered.',
                  };
            }
          }
        } catch {
          // A failed status query cannot establish whole-session settlement.
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    };
    const recover = async (): Promise<Result> => {
      runtime.registerUnknownSessionRun(sessionId, runId, { cancelled: signal.aborted });
      // The transport can disappear while native execution continues. Keep the
      // caller's reservation until the Gateway supplies an authoritative receipt.
      for (;;) {
        try {
          await runtime.ensureReady();
          const current = runtime.getGatewayClient();
          if (current) {
            await subscribe(current);
            if (signal.aborted) await current.request('sessions.abort', { key, runId });
            const receipt = await current.request<{
              runId?: string;
              status?: string;
              endedAt?: number;
              yielded?: boolean;
              error?: string;
              terminalReply?: { disposition?: string; text?: string };
            }>('agent.wait', { runId, timeoutMs: 0 });
            if ((!receipt.runId || receipt.runId === runId) && receipt.yielded)
              return waitForContinuation();
            if (
              (!receipt.runId || receipt.runId === runId) &&
              !receipt.yielded &&
              (receipt.status === 'ok' ||
                receipt.status === 'error' ||
                (receipt.status === 'timeout' && typeof receipt.endedAt === 'number'))
            ) {
              return {
                status:
                  receipt.status === 'ok' && !receipt.terminalReply ? 'error' : receipt.status,
                summary:
                  receipt.error ||
                  (receipt.status === 'ok' && !receipt.terminalReply
                    ? 'Execution settled, but its final reply could not be recovered.'
                    : undefined),
                result: {
                  payloads:
                    receipt.terminalReply?.disposition === 'visible'
                      ? [{ text: receipt.terminalReply.text }]
                      : [],
                },
              };
            }
          }
        } catch {
          // Unavailable authority and a plain wait timeout do not prove settlement.
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    };
    const timing = store.beginSessionRun({
      sessionId,
      clientTurnId: runId,
      modelRef: store.getSession(sessionId)?.modelRef,
      startedAt: Date.now(),
    });
    runtime.on('gatewayEvent', handle);
    try {
      await subscribe(client);
      if (signal.aborted) throw new Error('Task cancelled.');
      store.updateSession(sessionId, { status: 'running' });
      signal.addEventListener('abort', abort, { once: true });
      let result = await client
        .request<Result>(
          'agent',
          { sessionKey: key, agentId: session.agentId, message, idempotencyKey: runId },
          { expectFinal: true },
        )
        .catch(error => {
          if (isGatewayRequestOutcomeUnknown(error)) return recover();
          throw error;
        });
      if (result.result?.meta?.yielded) result = await waitForContinuation();
      if (signal.reason instanceof MulticaCodexStreamError) throw signal.reason;
      if (result.status !== 'ok') throw new Error(result.summary || 'Native execution failed.');
      store.finishSessionRun(timing.id, signal.aborted ? 'aborted' : 'completed', Date.now());
      store.updateSession(sessionId, { status: signal.aborted ? 'idle' : 'completed' });
      return (result.result?.payloads ?? [])
        .flatMap(payload => [
          payload.text ?? '',
          ...(payload.mediaUrls ?? []),
          ...(payload.mediaUrl ? [payload.mediaUrl] : []),
        ])
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      abort();
      const cancelled = signal.aborted && !(signal.reason instanceof MulticaCodexStreamError);
      store.finishSessionRun(timing.id, cancelled ? 'aborted' : 'failed', Date.now());
      store.updateSession(sessionId, { status: cancelled ? 'idle' : 'error' });
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      runtime.off('gatewayEvent', handle);
      // Native subscription owners are keyed separately, including the unnamed
      // owner used by browser chat. Release only this turn's subscription.
      void subscriptionCleanupClient
        ?.request('sessions.messages.unsubscribe', subscription)
        .catch(() => {});
    }
  };
}
