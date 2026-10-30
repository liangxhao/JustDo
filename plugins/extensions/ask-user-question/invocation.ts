import {
  APP_EXECUTION_SOURCE_BINDING,
  readAppExecutionSourceBinding,
} from '@app-plugin/sdk/execution-source';

import type { AskUserSource } from './contracts/result';

type NativeEntry = {
  sessionId?: string;
  lifecycleRevision?: string;
  pluginOwnerId?: string;
};
type ToolContext = {
  toolName: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  abortSignal?: AbortSignal;
};
type Call = {
  source: Pick<
    AskUserSource,
    'sessionKey' | 'nativeSessionId' | 'runId' | 'toolCallId' | 'lifecycleRevision'
  >;
  signal?: AbortSignal;
  claimed: boolean;
  release(): void;
};
const key = (sessionKey: string, sessionId: string, toolCallId: string): string =>
  JSON.stringify([sessionKey, sessionId, toolCallId]);
const unavailable = (): Error => new Error('The question has no current native tool invocation.');

/** The hook supplies run provenance; V2 assertInvocationCurrent remains execution authority. */
export class AskUserInvocationScopes {
  private active = false;
  private readonly calls = new Map<string, Call>();

  constructor(private readonly readEntry: (sessionKey: string) => NativeEntry | undefined) {}

  activate(): void {
    this.active = true;
  }

  clear(): void {
    this.active = false;
    for (const call of this.calls.values()) call.release();
  }

  prepare(context: ToolContext): void {
    const { sessionKey, sessionId, runId, toolCallId, abortSignal } = context;
    if (
      !this.active ||
      !sessionKey ||
      !sessionId ||
      !runId ||
      !toolCallId ||
      context.toolName !== 'ask_user_question' ||
      abortSignal?.aborted
    )
      throw unavailable();
    const entry = this.readEntry(sessionKey);
    if (entry?.sessionId !== sessionId) throw unavailable();
    const callKey = key(sessionKey, sessionId, toolCallId);
    if (this.calls.has(callKey) || this.calls.size >= 8_192) throw unavailable();
    const call: Call = {
      source: {
        sessionKey,
        nativeSessionId: sessionId,
        runId,
        toolCallId,
        lifecycleRevision: entry.lifecycleRevision ?? null,
      },
      signal: abortSignal,
      claimed: false,
      release: () => {
        abortSignal?.removeEventListener('abort', call.release);
        if (this.calls.get(callKey) === call) this.calls.delete(callKey);
      },
    };
    this.calls.set(callKey, call);
    abortSignal?.addEventListener('abort', call.release, { once: true });
  }

  finish(context: ToolContext): void {
    if (!context.sessionKey || !context.sessionId || !context.toolCallId) return;
    const call = this.calls.get(key(context.sessionKey, context.sessionId, context.toolCallId));
    if (call?.source.runId === context.runId) call.release();
  }

  claim(
    context: {
      sessionKey: string;
      sessionId: string;
      agentId?: string;
      toolBindings?: unknown;
      assertInvocationCurrent(): void;
    },
    toolCallId: string,
  ): { source: AskUserSource; signal?: AbortSignal; assertCurrent(): void } {
    const callKey = key(context.sessionKey, context.sessionId, toolCallId);
    const call = this.calls.get(callKey);
    if (!call || call.claimed) throw unavailable();
    const assertCurrent = (): void => {
      context.assertInvocationCurrent();
      const entry = this.readEntry(context.sessionKey);
      if (
        !this.active ||
        this.calls.get(callKey) !== call ||
        call.signal?.aborted ||
        entry?.sessionId !== context.sessionId ||
        (entry.lifecycleRevision ?? null) !== call.source.lifecycleRevision
      )
        throw unavailable();
    };
    assertCurrent();
    call.claimed = true;
    const entry = this.readEntry(context.sessionKey);
    const binding = readAppExecutionSourceBinding(context.toolBindings, call.source);
    if (
      context.toolBindings &&
      typeof context.toolBindings === 'object' &&
      Object.hasOwn(context.toolBindings, APP_EXECUTION_SOURCE_BINDING) &&
      !binding
    )
      throw unavailable();
    const ownerPluginId = binding?.ownerPluginId ?? entry?.pluginOwnerId;
    return {
      source: {
        ...call.source,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(ownerPluginId ? { ownerPluginId } : {}),
      },
      signal: call.signal,
      assertCurrent,
    };
  }
}
