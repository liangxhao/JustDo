import { normalizeAgentEvent } from '../../../shared/openclaw/agentEvent';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { GatewayClientLike, GatewayEventFrame } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import type { OpenClawEngineStatus } from '../../openclaw/runtime/openclawEngineManager';
import { ExternalAgentProgress } from './externalAgentProgress';
import {
  ExternalAgentCancelledError,
  type ExternalAgentExecution,
  ExternalAgentExecutionOutcome,
  type ExternalAgentNativeBinding,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentTypes';

export type { ExternalAgentNativeBinding, ExternalAgentRunHooks } from './externalAgentTypes';

interface Dependencies {
  getStore: () => CoworkStore;
  getRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  ensureReady: () => Promise<Pick<OpenClawEngineStatus, 'phase' | 'message'>>;
}

interface ReconciliationTiming {
  timeoutMs?: number;
  pollIntervalMs?: number;
  outputRecoveryTimeoutMs?: number;
  progressTimeoutMs?: number;
}

interface NativeSessionIdentity {
  sessionId: string;
  lifecycleRevision: string;
  activeRunIds?: string[];
}

interface NativeResult {
  runId?: string;
  status: string;
  outputRecovered?: boolean;
  summary?: string;
  result?: {
    meta?: {
      yielded?: boolean;
      terminalReply?: { disposition?: string; text?: string };
    };
    payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
  };
}

interface SettledResult extends NativeResult {
  terminalReplyText?: string;
}

interface NativeReceipt {
  runId?: string;
  status?: string;
  endedAt?: number;
  yielded?: boolean;
  error?: string;
  stopReason?: string;
  terminalReply?: { disposition?: string; text?: string };
}

class NativeIdentityChangedError extends Error {}

const TERMINAL_REPLY_MAX_CHARS = 4096;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const UNSTAMPED_PROGRESS_STREAMS = new Set(['assistant', 'thinking', 'tool']);

/** Native final-RPC payloads are display projections; do not recreate private metadata stripping. */
const projectTerminalReplyText = (value: string): string => {
  const text = value.trim();
  if (text.length <= TERMINAL_REPLY_MAX_CHARS) return text;
  let end = TERMINAL_REPLY_MAX_CHARS - 1;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
};

const textResult = (result: NativeResult): string =>
  (result.result?.payloads ?? [])
    .flatMap(payload => [
      payload.text ?? '',
      ...(payload.mediaUrls ?? []),
      ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ])
    .filter(Boolean)
    .join('\n');

/** Authenticated native execution; all transport adapters share this boundary. */
export function createExternalAgentExecution(
  deps: Dependencies,
  timing: ReconciliationTiming = {},
): ExternalAgentExecution {
  const reconciliationTimeoutMs = timing.timeoutMs ?? 30_000;
  const pollIntervalMs = timing.pollIntervalMs ?? 1000;
  const outputRecoveryTimeoutMs = timing.outputRecoveryTimeoutMs ?? 5000;
  return async ({
    sessionId,
    runId,
    message,
    modelRef,
    onEvent,
    signal,
    hooks,
    onUnconfirmed,
    onSettled,
    expectedBinding,
  }) => {
    const checkCancelled = () => {
      if (signal.aborted)
        throw new ExternalAgentCancelledError('Task cancelled before native submission.');
    };
    checkCancelled();
    const readiness = await deps.ensureReady();
    if (readiness.phase !== 'running')
      throw new Error(readiness.message || 'Execution runtime is unavailable.');
    checkCancelled();
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
      ...(expectedBinding ? { expectedSessionId: expectedBinding.sessionId } : {}),
    });
    checkCancelled();
    const runtime = deps.getRuntime();
    if (!runtime) throw new Error('Execution runtime is unavailable.');
    await runtime.ensureReady();
    const initialClient = runtime.getGatewayClient();
    const key = prepared.sessionKey;
    if (!initialClient || !key || !prepared.gatewaySessionId)
      throw new Error('The native conversation identity is unavailable.');
    let client: GatewayClientLike = initialClient;
    const describe = async (current: GatewayClientLike): Promise<NativeSessionIdentity> => {
      const result = await current.request<{
        session?: {
          sessionId?: string;
          lifecycleRevision?: string;
          activeRunIds?: unknown;
        };
      }>('sessions.describe', { key });
      const described = result.session;
      if (
        runtime.getGatewayClient() !== current ||
        described?.sessionId !== prepared.gatewaySessionId ||
        typeof described.lifecycleRevision !== 'string' ||
        !described.lifecycleRevision
      )
        throw new NativeIdentityChangedError(
          'The native conversation identity changed or could not be verified.',
        );
      return {
        sessionId: described.sessionId,
        lifecycleRevision: described.lifecycleRevision,
        ...(Array.isArray(described.activeRunIds) &&
        described.activeRunIds.every(value => typeof value === 'string')
          ? { activeRunIds: described.activeRunIds as string[] }
          : {}),
      };
    };
    const identity = await describe(client);
    if (
      expectedBinding &&
      (expectedBinding.sessionKey !== key ||
        expectedBinding.sessionId !== identity.sessionId ||
        expectedBinding.lifecycleRevision !== identity.lifecycleRevision)
    )
      throw new Error('The external conversation native identity changed.');
    const binding: ExternalAgentNativeBinding = {
      localSessionId: sessionId,
      runId,
      sessionKey: key,
      ...identity,
      client,
    };
    const assertIdentity = async (current: GatewayClientLike): Promise<NativeSessionIdentity> => {
      const next = await describe(current);
      if (next.lifecycleRevision !== identity.lifecycleRevision)
        throw new NativeIdentityChangedError(
          'The native conversation incarnation changed during execution.',
        );
      return next;
    };
    checkCancelled();
    if (modelRef) {
      const result = await runtime.patchSessionModel(sessionId, modelRef, session.agentId);
      if (result.ok === false)
        throw new Error(result.error || 'The selected model could not be applied.');
      checkCancelled();
      await assertIdentity(client);
    }

    let cleanup: void | (() => void | Promise<void>) = undefined;
    let submitted = false;
    let settled = false;
    let yielded = false;
    let nativeGeneration: string | null = null;
    let lastSequence = -1;
    let lastProgressSequence = -1;
    let startProgressProof: { source: GatewayClientLike; sequence: number } | undefined;
    let terminalProgressProof: { source: GatewayClientLike; sequence: number } | undefined;
    let terminal:
      | { status: string; text?: string; silent?: boolean; yielded?: boolean; replyKnown?: boolean }
      | undefined;
    const terminalWake = Symbol('execution-settled');
    let wakeTerminal!: (value: typeof terminalWake) => void;
    const terminalAvailable = new Promise<typeof terminalWake>(resolve => {
      wakeTerminal = resolve;
    });
    let outputError: Error | undefined;
    let timingId: string | undefined;
    let nativeOutcome: ExternalAgentExecutionOutcome | undefined;
    let finalResponse: Promise<NativeResult> | undefined;
    let finalResponsePending = false;
    let finalWaitController: AbortController | undefined;
    const subscription = { key, subscriptionId: `external-agent:${runId}` };
    const subscriptions = new Set<GatewayClientLike>();
    const subscribe = async (current: GatewayClientLike): Promise<void> => {
      if (subscriptions.has(current)) return;
      // The subscription may be admitted even when its ACK is lost. Record
      // ownership before sending so terminal cleanup covers a late ACK too.
      subscriptions.add(current);
      await current.request('sessions.messages.subscribe', subscription);
    };
    const abort = (): void => {
      // Exact run cancellation is safe even when its ACK cannot prove settlement.
      void runtime
        .getGatewayClient()
        ?.request('sessions.abort', { key, runId })
        .catch(() => {});
    };
    const progress = new ExternalAgentProgress({
      isCurrent: source => runtime.getGatewayClient() === source && client === source,
      verify: async (source, events) => {
        const current = await assertIdentity(source);
        if (
          nativeGeneration &&
          events.some(
            event => event.lifecycleGeneration && event.lifecycleGeneration !== nativeGeneration,
          )
        ) {
          throw new ExternalAgentStreamError('The native progress generation changed.');
        }
        const terminalProof = terminalProgressProof;
        const hasTerminal = terminalProof?.source === source;
        const provenBeforeTerminal =
          hasTerminal && events.every(event => event.agentSeq < terminalProof.sequence);
        const startProof = startProgressProof;
        const provenAfterStart =
          startProof?.source === source &&
          events.every(event => event.agentSeq > startProof.sequence);
        // Projected native owners may omit activeRunIds. An exact native start
        // also binds this display stream, but can never extend it past terminal.
        if (
          (hasTerminal && !provenBeforeTerminal) ||
          (!current.activeRunIds?.includes(runId) && !provenBeforeTerminal && !provenAfterStart)
        ) {
          throw new ExternalAgentStreamError('Native progress has no exact current run proof.');
        }
        return identity.sessionId;
      },
      deliver: onEvent,
      fail: error => {
        outputError = error;
        abort();
      },
      timeoutMs: timing.progressTimeoutMs,
    });
    const handle = (frame: GatewayEventFrame): void => {
      if (
        runtime.getGatewayClient() !== client ||
        (frame.event !== 'agent' && frame.event !== 'session.tool')
      )
        return;
      const event = normalizeAgentEvent({
        deliveryEvent: frame.event,
        payload: frame.payload,
        frameSeq: frame.seq,
      }).event;
      if (
        !event ||
        event.sessionKey !== key ||
        (event.sessionId !== null && event.sessionId !== identity.sessionId) ||
        (event.sessionId === null && !UNSTAMPED_PROGRESS_STREAMS.has(event.stream)) ||
        event.runId !== runId ||
        event.spawnedBy ||
        (event.sessionId !== null && event.agentSeq <= lastSequence) ||
        (nativeGeneration &&
          event.lifecycleGeneration &&
          event.lifecycleGeneration !== nativeGeneration)
      )
        return;
      // Unverified display events must never advance execution's generation or
      // sequence frontier and suppress a later exact whole-run terminal.
      if (event.sessionId !== null) {
        if (event.lifecycleGeneration) nativeGeneration = event.lifecycleGeneration;
        lastSequence = event.agentSeq;
      }
      if (event.stream === 'lifecycle' && event.data.phase === 'start' && !startProgressProof) {
        startProgressProof = { source: client, sequence: event.agentSeq };
      }
      if (
        event.stream === 'lifecycle' &&
        event.data.executionSettled === true &&
        (event.data.phase === 'end' || event.data.phase === 'error')
      ) {
        const reply = event.data.terminalReply as
          { disposition?: string; text?: string } | undefined;
        terminal = {
          status:
            event.data.aborted === true ||
            event.data.stopReason === 'aborted' ||
            event.data.stopReason === 'rpc'
              ? 'cancelled'
              : event.data.phase === 'error'
                ? 'error'
                : 'ok',
          ...(typeof reply?.text === 'string' && reply.text.length <= 2 * 1024 * 1024
            ? { text: reply.text }
            : {}),
          silent: reply?.disposition === 'silent' || reply?.disposition === 'empty',
          replyKnown:
            reply?.disposition === 'silent' ||
            reply?.disposition === 'empty' ||
            (reply?.disposition === 'visible' &&
              typeof reply.text === 'string' &&
              reply.text.length <= 2 * 1024 * 1024),
          yielded: event.data.yielded === true,
        };
        if (!terminal.yielded) {
          terminalProgressProof = { source: client, sequence: event.agentSeq };
          wakeTerminal(terminalWake);
        }
      }
      if (event.agentSeq <= lastProgressSequence) return;
      lastProgressSequence = event.agentSeq;
      progress.enqueue(event, client);
    };
    const receiptResult = (receipt: NativeReceipt): SettledResult => ({
      status:
        receipt.stopReason === 'aborted' || receipt.stopReason === 'rpc'
          ? 'cancelled'
          : receipt.status === 'ok'
            ? 'ok'
            : 'error',
      summary: receipt.error,
      ...(receipt.terminalReply?.disposition === 'visible' &&
      typeof receipt.terminalReply.text === 'string'
        ? { terminalReplyText: receipt.terminalReply.text }
        : {}),
      outputRecovered:
        receipt.terminalReply?.disposition === 'silent' ||
        receipt.terminalReply?.disposition === 'empty' ||
        (receipt.terminalReply?.disposition === 'visible' &&
          typeof receipt.terminalReply.text === 'string' &&
          receipt.terminalReply.text.length <= 2 * 1024 * 1024),
      result: {
        payloads:
          receipt.terminalReply?.disposition === 'visible'
            ? [{ text: receipt.terminalReply.text }]
            : [],
      },
    });
    const awaitSettlement = async (initial?: NativeResult): Promise<SettledResult> => {
      // agent.wait is the native whole-run receipt API. A chat final, idle state,
      // cancellation ACK, or new owner cannot replace its exact terminal evidence.
      let deadline = Date.now() + reconciliationTimeoutMs;
      const unavailable = () =>
        new ExternalAgentOutcomeUnknownError(
          'Native execution could not be reconciled within the authority wait window; the conversation remains reserved.',
        );
      const withinWindow = async <T>(task: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            task,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(unavailable()), Math.max(0, deadline - Date.now()));
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      for (;;) {
        if (terminal && !terminal.yielded) {
          // A matching live terminal can arrive while a read is pending. Give
          // its identity check a bounded window before adopting that evidence.
          deadline = Date.now() + reconciliationTimeoutMs;
          const confirmed = terminal;
          await withinWindow(assertIdentity(client));
          settled = true;
          return {
            status: confirmed.status,
            ...(confirmed.text !== undefined ? { terminalReplyText: confirmed.text } : {}),
            outputRecovered: confirmed.replyKnown || Array.isArray(initial?.result?.payloads),
            result: {
              payloads:
                confirmed.text || confirmed.silent
                  ? [{ text: confirmed.text }]
                  : initial?.result?.payloads,
            },
          };
        }
        if (Date.now() >= deadline) throw unavailable();
        try {
          await withinWindow(runtime.ensureReady());
          const current = runtime.getGatewayClient();
          if (current) {
            await withinWindow(assertIdentity(current));
            if (current !== client) {
              if (typeof cleanup === 'function')
                throw new ExternalAgentOutcomeUnknownError(
                  'The native connection changed while external tools or approval ownership were installed; the conversation remains reserved.',
                );
              client = current;
              nativeGeneration = null;
              lastSequence = -1;
              lastProgressSequence = -1;
              startProgressProof = undefined;
              terminalProgressProof = undefined;
              // Session-scoped MCP and approval leases belong to the original
              // native incarnation; connection recovery never recreates a run.
            }
            const subscribed = await withinWindow(
              Promise.race([subscribe(current), terminalAvailable]),
            );
            if (subscribed === terminalWake) continue;
            if (signal.aborted || outputError)
              void current.request('sessions.abort', { key, runId }).catch(() => {});
            const receipt = await withinWindow(
              Promise.race([
                current.request<NativeReceipt>('agent.wait', {
                  runId,
                  timeoutMs: 0,
                }),
                terminalAvailable,
              ]),
            );
            // The abandoned read has no stateful continuation. A late receipt
            // cannot overwrite the terminal adopted after identity verification.
            if (receipt === terminalWake) continue;
            if (runtime.getGatewayClient() !== current) continue;
            const observation = await withinWindow(assertIdentity(current));
            if (receipt.runId !== runId) {
              onUnconfirmed?.();
            } else if (receipt.yielded || yielded || terminal?.yielded) {
              // Public session ownership/currentRunId does not prove a wake's
              // predecessor. Keep the reservation instead of guessing from a
              // run suffix or the latest assistant message in history.
              throw new ExternalAgentOutcomeUnknownError(
                'Native execution yielded. Its continuation cannot be attributed through the current public API; the conversation remains reserved.',
              );
            } else if (
              typeof receipt.endedAt === 'number' &&
              Number.isFinite(receipt.endedAt) &&
              (receipt.status === 'ok' ||
                receipt.status === 'error' ||
                receipt.status === 'timeout')
            ) {
              settled = true;
              return receipt.terminalReply ||
                receipt.stopReason === 'aborted' ||
                receipt.stopReason === 'rpc'
                ? receiptResult(receipt)
                : initial && receipt.status === 'ok'
                  ? {
                      ...initial,
                      status: 'ok',
                      outputRecovered: Array.isArray(initial.result?.payloads),
                    }
                  : receiptResult(receipt);
            }
            if (
              observation.activeRunIds?.includes(runId) ||
              (receipt.runId === runId &&
                ['pending', 'accepted', 'running'].includes(receipt.status ?? ''))
            )
              deadline = Date.now() + reconciliationTimeoutMs;
            else onUnconfirmed?.();
          }
        } catch (error) {
          if (error instanceof ExternalAgentOutcomeUnknownError) {
            if (terminal && !terminal.yielded) continue;
            throw error;
          }
          if (error instanceof NativeIdentityChangedError)
            throw new ExternalAgentOutcomeUnknownError(error.message);
          // A missing authority or a plain wait timeout is an unknown outcome.
          onUnconfirmed?.();
        }
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            terminalAvailable,
            new Promise<void>(resolve => {
              pollTimer = setTimeout(
                resolve,
                Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())),
              );
            }),
          ]);
        } finally {
          if (pollTimer) clearTimeout(pollTimer);
        }
      }
    };
    const recoverFullOutput = async (outcome: SettledResult): Promise<NativeResult> => {
      const snapshot = outcome.terminalReplyText;
      // The native snapshot reserves one UTF-16 unit for an ellipsis and trims
      // whitespace/surrogate boundaries, so a truncated snapshot may be shorter
      // than 4096. An ellipsis alone cannot prove the final reply is complete.
      if (!snapshot?.endsWith('…')) return outcome;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const full = await Promise.race([
          finalResponse
            ?.then(async response => {
              await assertIdentity(client);
              return response;
            })
            .catch((): undefined => undefined),
          new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), outputRecoveryTimeoutMs);
          }),
        ]);
        const reply = full?.result?.meta?.terminalReply;
        const text = (full?.result?.payloads ?? [])
          .flatMap(payload => (typeof payload.text === 'string' ? [payload.text] : []))
          .filter(Boolean)
          .join('\n');
        if (
          full?.runId === runId &&
          full.status === 'ok' &&
          full.result?.meta?.yielded !== true &&
          reply?.disposition === 'visible' &&
          reply.text === snapshot &&
          text.length <= MAX_OUTPUT_CHARS &&
          projectTerminalReplyText(text) === snapshot
        ) {
          return { ...outcome, result: full.result, outputRecovered: true };
        }
        return { ...outcome, result: undefined, outputRecovered: false };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    runtime.on('gatewayEvent', handle);
    try {
      cleanup = await hooks?.onPrepared?.(binding);
      checkCancelled();
      await assertIdentity(client);
      await subscribe(client);
      checkCancelled();
      timingId = store.beginSessionRun({
        sessionId,
        clientTurnId: runId,
        modelRef: store.getSession(sessionId)?.modelRef,
        startedAt: Date.now(),
      }).id;
      store.updateSession(sessionId, { status: 'running' });
      signal.addEventListener('abort', abort, { once: true });
      checkCancelled();
      submitted = true;
      let result: NativeResult | undefined;
      try {
        finalWaitController = new AbortController();
        finalResponsePending = true;
        finalResponse = client
          .request<NativeResult>(
            'agent',
            {
              sessionKey: key,
              agentId: session.agentId,
              message,
              idempotencyKey: runId,
              expectedExistingSessionId: identity.sessionId,
              expectedExistingSessionLifecycleRevision: identity.lifecycleRevision,
              ...(hooks?.interactiveApprovals === true
                ? { channel: 'webchat', deliver: false }
                : {}),
            },
            // Cancels this transport wait only. The abort listener separately
            // requests exact native cancellation; settlement still needs evidence.
            { expectFinal: true, signal: AbortSignal.any([signal, finalWaitController.signal]) },
          )
          .then(
            response => {
              finalResponsePending = false;
              return response;
            },
            error => {
              finalResponsePending = false;
              throw error;
            },
          );
        const response = await Promise.race([finalResponse, terminalAvailable]);
        if (response !== terminalWake) {
          result = response;
          yielded = result.result?.meta?.yielded === true;
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error as Error & { requestSent?: unknown }).requestSent === false
        ) {
          submitted = false;
          throw error;
        }
        onUnconfirmed?.();
        runtime.registerUnknownSessionRun(sessionId, runId, { cancelled: signal.aborted });
      }
      const outcome = await awaitSettlement(result);
      nativeOutcome =
        outcome.status === 'ok'
          ? ExternalAgentExecutionOutcome.Completed
          : outcome.status === 'cancelled'
            ? ExternalAgentExecutionOutcome.Cancelled
            : ExternalAgentExecutionOutcome.Failed;
      onSettled?.(nativeOutcome);
      store.finishSessionRun(
        timingId,
        nativeOutcome === ExternalAgentExecutionOutcome.Completed
          ? 'completed'
          : nativeOutcome === ExternalAgentExecutionOutcome.Cancelled
            ? 'aborted'
            : 'failed',
        Date.now(),
      );
      store.updateSession(sessionId, {
        status:
          nativeOutcome === ExternalAgentExecutionOutcome.Completed
            ? 'completed'
            : nativeOutcome === ExternalAgentExecutionOutcome.Cancelled
              ? 'idle'
              : 'error',
      });
      // Native settlement never waits for progress admission. Preserve its
      // outcome, then finish the bounded, ordered protocol output separately.
      await progress.flush();
      if (outputError) throw outputError;
      if (signal.reason instanceof ExternalAgentStreamError) throw signal.reason;
      // Whole-run evidence determines execution outcome. Only the exact native
      // final RPC and its producer-owned snapshot may restore a capped reply.
      const output =
        nativeOutcome === ExternalAgentExecutionOutcome.Completed
          ? await recoverFullOutput(outcome)
          : outcome;
      if (
        nativeOutcome === ExternalAgentExecutionOutcome.Completed &&
        output.outputRecovered === false
      )
        throw new ExternalAgentStreamError(
          'Native execution completed, but its final reply could not be recovered.',
        );
      if (outcome.status === 'cancelled')
        throw new ExternalAgentCancelledError('Native execution was cancelled.');
      if (outcome.status !== 'ok') throw new Error(outcome.summary || 'Native execution failed.');
      return textResult(output);
    } catch (error) {
      if (submitted && !settled) {
        onUnconfirmed?.();
        runtime.registerUnknownSessionRun(sessionId, runId, { cancelled: signal.aborted });
        throw error instanceof ExternalAgentOutcomeUnknownError
          ? error
          : new ExternalAgentOutcomeUnknownError(
              'Native execution could not be confirmed; the conversation remains reserved.',
            );
      }
      const cancelled = error instanceof ExternalAgentCancelledError;
      if (timingId && !nativeOutcome)
        store.finishSessionRun(timingId, cancelled ? 'aborted' : 'failed', Date.now());
      if (timingId && !nativeOutcome)
        store.updateSession(sessionId, { status: cancelled ? 'idle' : 'error' });
      throw error;
    } finally {
      progress.close();
      // Retire an orphaned final-RPC waiter after the bounded output recovery.
      // This does not issue a native Stop or change an established outcome.
      if (finalResponsePending) finalWaitController?.abort();
      runtime.off('gatewayEvent', handle);
      if (!submitted || settled) {
        signal.removeEventListener('abort', abort);
        if (typeof cleanup === 'function') {
          try {
            await cleanup();
          } catch {
            console.warn('[ExternalAgentExecution] Native turn cleanup failed.');
          }
        }
        await Promise.allSettled(
          [...subscriptions].map(current =>
            current.request('sessions.messages.unsubscribe', subscription),
          ),
        );
      } else if (signal.aborted) {
        // Preserve cancellation after returning an unknown outcome. Protocol
        // owners retain the signal until EOF/close, and the exact run guard
        // prevents a late abort from stopping a replacement native turn.
        abort();
      }
    }
  };
}
