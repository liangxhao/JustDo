import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { captureNativeRegistrationProbe } from '../sdk/native-lifecycle';

const GOAL_TOOL_NAME = 'update_goal';
const GOAL_FINISH_TOOL_NAME = 'finish_goal_turn';
const TOOL_CALL_NAME = 'tool_call';
const CORE_GOAL_TOOL_ID = 'openclaw:core:update_goal';
const GOAL_FINISH_TOOL_ID = 'openclaw:runtime-services:finish_goal_turn';
const PLUGIN_ID = 'runtime-services';
const NATIVE_RUNTIME = 'openclaw';
const GOAL_ACTIVE = 'active';
const GOAL_COMPLETE = 'complete';
const GOAL_UPDATED = 'updated';
const FINISH_UNCONFIRMED = 'unconfirmed';
const FINISH_UNAVAILABLE = 'unavailable';
const FINISH_CONFIRMED = 'finished';
const REPLY_NONE = 'none';
const MAX_GOAL_ID_CHARS = 256;
const MAX_RESULT_CHARS = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_RESULT_DEPTH = 12;
const MAX_RESULT_NODES = 2048;
const GOAL_READ_TIMEOUT_MS = 1500;
const GOAL_RESULT_GUIDANCE = [
  'The Goal completion update succeeded. This automatic continuation is not a new user request.',
  'If the requested result was already delivered and there is no new user-relevant result, call finish_goal_turn with this goal.id and reply:"none" in a separate tool_call after receiving this update_goal result.',
  'Call it alone: do not batch it with update_goal or other tools, and do not invoke it inside Code Mode exec. A confirmed finish ends this turn without another reply; NO_REPLY alone does not confirm that finish.',
  'Do not repeat, regenerate, paraphrase, summarize, or announce the already delivered result.',
  'If a requested result has not been delivered or this turn produced a new user-relevant result, provide that requested answer instead.',
].join(' ');
const FINISH_UNCONFIRMED_GUIDANCE = 'Ending this turn without another reply is not confirmed. Continue normally and provide any requested answer that has not been delivered. Do not claim that the turn finished silently.';
const FINISH_CONFIRMED_GUIDANCE = 'This explicit request to finish the automatic Goal bookkeeping turn without another reply was confirmed. No Goal status was changed.';

type Middleware = Parameters<OpenClawPluginApi['registerAgentToolResultMiddleware']>[0];
type ToolResult = Parameters<Middleware>[0]['result'];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };
type PreparedResult = { goalId: string; result: ToolResult; invocation?: JsonRecord };
const record = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

/** Bound the native JSON envelope before copying or comparing it; no arbitrary text traversal. */
function copyJson(value: unknown): Json | undefined {
  let nodes = MAX_RESULT_NODES;
  let chars = MAX_RESULT_CHARS;
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number): Json | undefined => {
    if (--nodes < 0 || depth > MAX_RESULT_DEPTH) return;
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : undefined;
    if (typeof input === 'string') return (chars -= input.length) >= 0 ? input : undefined;
    if (!input || typeof input !== 'object' || seen.has(input)) return;
    seen.add(input);
    if (Array.isArray(input)) {
      if (input.length > nodes) return;
      const result: Json[] = [];
      for (const value of input) {
        const copy = visit(value, depth + 1);
        if (copy === undefined) return;
        result.push(copy);
      }
      return result;
    }
    const result: JsonRecord = Object.create(null);
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      if ((chars -= key.length) < 0) return;
      const copy = visit(Reflect.get(input, key), depth + 1);
      if (copy === undefined) return;
      result[key] = copy;
    }
    return result;
  };
  return visit(value, 0);
}

function sameJson(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

function jsonResultPair(result: ToolResult) {
  if (result.content.length !== 1) return null;
  const block = result.content[0];
  if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length > MAX_RESULT_CHARS || Buffer.byteLength(block.text, 'utf8') > MAX_RESULT_BYTES) return null;
  const details = copyJson(result.details);
  const model = copyJson(JSON.parse(block.text));
  return record(details) && record(model) && Buffer.byteLength(JSON.stringify(details), 'utf8') <= MAX_RESULT_BYTES ? { details, model } : null;
}

function completedGoal(payload: JsonRecord) {
  return payload.status === GOAL_UPDATED && record(payload.goal) && nonempty(payload.goal.id) &&
    payload.goal.status === GOAL_COMPLETE && nonempty(payload.nextAction) ? payload.goal : null;
}

function replacePayload(result: ToolResult, details: JsonRecord, model: JsonRecord): ToolResult | null {
  const text = JSON.stringify(model, null, 2);
  if (text.length > MAX_RESULT_CHARS || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES ||
    Buffer.byteLength(JSON.stringify(details), 'utf8') > MAX_RESULT_BYTES || copyJson(details) === undefined) return null;
  return { ...result, details, content: [{ ...result.content[0], type: 'text', text }] };
}

async function boundedRead(read: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), GOAL_READ_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function finishInput(value: unknown): value is { goalId: string; reply: typeof REPLY_NONE } {
  return record(value) && Object.keys(value).length === 2 && nonempty(value.goalId) &&
    value.goalId.length <= MAX_GOAL_ID_CHARS && value.reply === REPLY_NONE;
}

function prepareFinish(result: ToolResult, args: unknown): PreparedResult | null {
  const pair = jsonResultPair(result);
  if (!pair || !finishInput(args) || !sameJson(pair.details, pair.model) ||
    pair.details.status !== FINISH_UNCONFIRMED || pair.details.reply !== REPLY_NONE ||
    pair.details.goalId !== args.goalId || !record(pair.details.invocation)) return null;
  const invocation = pair.details.invocation;
  if (![invocation.agentId, invocation.sessionKey, invocation.sessionId].every(nonempty)) return null;
  const payload = { ...pair.details, status: FINISH_CONFIRMED, nextAction: FINISH_CONFIRMED_GUIDANCE };
  const replacement = replacePayload(result, payload, payload);
  return replacement ? { goalId: args.goalId, invocation, result: { ...replacement, terminate: true } } : null;
}

function prepareResult(event: Parameters<Middleware>[0]): PreparedResult | null {
  if (event.toolName === GOAL_FINISH_TOOL_NAME) return prepareFinish(event.result, event.args);
  if (event.toolName !== GOAL_TOOL_NAME && event.toolName !== TOOL_CALL_NAME) return null;
  const pair = jsonResultPair(event.result);
  if (!pair) return null;
  if (event.toolName === GOAL_TOOL_NAME) {
    const goal = completedGoal(pair.details);
    if (!goal || event.args.status !== GOAL_COMPLETE || !sameJson(pair.details, pair.model)) return null;
    const payload = { ...pair.details, nextAction: GOAL_RESULT_GUIDANCE };
    const result = replacePayload(event.result, payload, payload);
    return result ? { goalId: goal.id as string, result } : null;
  }
  if (event.toolName !== TOOL_CALL_NAME) return null;
  const { tool, result: inner } = pair.details;
  const modelTool = pair.model.tool;
  if (!record(tool) || !record(modelTool) || !record(inner) || !Array.isArray(inner.content) ||
    tool.source !== NATIVE_RUNTIME ||
    modelTool.id !== tool.id || modelTool.source !== tool.source || modelTool.name !== tool.name ||
    !sameJson(inner, pair.model.result) || inner.isError === true) return null;
  if (tool.id === GOAL_FINISH_TOOL_ID && tool.sourceName === PLUGIN_ID && tool.name === GOAL_FINISH_TOOL_NAME &&
    (event.args.id === GOAL_FINISH_TOOL_NAME || event.args.id === GOAL_FINISH_TOOL_ID)) {
    const prepared = prepareFinish(inner as unknown as ToolResult, event.args.args);
    if (!prepared) return null;
    const replacement = prepared.result as unknown as JsonRecord;
    const result = replacePayload(event.result, { ...pair.details, result: replacement }, { ...pair.model, result: replacement });
    return result ? { ...prepared, result: { ...result, terminate: true } } : null;
  }
  if (tool.id !== CORE_GOAL_TOOL_ID || tool.sourceName !== 'core' || tool.name !== GOAL_TOOL_NAME ||
    (event.args.id !== GOAL_TOOL_NAME && event.args.id !== CORE_GOAL_TOOL_ID) || !record(event.args.args) || event.args.args.status !== GOAL_COMPLETE) return null;
  const innerResult = inner as unknown as ToolResult;
  const nested = jsonResultPair(innerResult);
  const goal = nested && completedGoal(nested.details);
  if (!nested || !goal || !sameJson(nested.details, nested.model)) return null;
  const payload = { ...nested.details, nextAction: GOAL_RESULT_GUIDANCE };
  const replacement = replacePayload(innerResult, payload, payload) as unknown as JsonRecord | null;
  if (!replacement) return null;
  const result = replacePayload(event.result, { ...pair.details, result: replacement }, { ...pair.model, result: replacement });
  return result ? { goalId: goal.id as string, result } : null;
}

/** Exact automatic successors can adapt completion guidance and explicitly request no further reply. */
export function registerGoalResultPolicy(api: OpenClawPluginApi): void {
  const lifecycle = api.lifecycle;
  const isCurrent = captureNativeRegistrationProbe(lifecycle);
  const runInBackgroundContext = lifecycle.runInBackgroundContext;
  api.registerTool({
    contextVersion: 2,
    create(context) {
      try {
        const { agentId, sessionKey, sessionId } = context;
        if (!isCurrent() || !context.assertInvocationCurrent || !nonempty(agentId) || !nonempty(sessionKey) || !nonempty(sessionId)) return null;
        context.assertInvocationCurrent();
        const session = api.runtime.agent.session;
        const storePath = session.resolveStorePath((context.runtimeConfig ?? context.config)?.session?.store, { agentId });
        const entry = session.getSessionEntry({ agentId, sessionKey, storePath, readConsistency: 'latest' });
        if (!isCurrent()) return null;
        context.assertInvocationCurrent();
        // This narrows discovery only. A retained same-attempt tool must remain
        // callable after update_goal completes; exact run proof still owns termination.
        if (entry?.sessionId !== sessionId || !nonempty(entry.goal?.id) || entry.goal?.status !== GOAL_ACTIVE) return null;
      } catch {
        return null;
      }
      return {
        name: GOAL_FINISH_TOOL_NAME,
        label: 'Finish Goal turn',
        description: 'Explicitly request no further reply for an automatic Goal bookkeeping turn, only after update_goal completed the exact goal and its requested result was already delivered with no new user-relevant result. Pass the returned goal.id and reply:"none". Call this tool alone through a separate tool_call after the successful update_goal result; never batch it with other tools or call it inside Code Mode exec. It does not update a Goal or prove result delivery. An unconfirmed or unavailable result does not end the turn: provide any still-requested answer normally.',
        parameters: { type: 'object', additionalProperties: false, required: ['goalId', 'reply'], properties: {
          goalId: { type: 'string', minLength: 1, maxLength: MAX_GOAL_ID_CHARS, description: 'Exact id returned by the successful update_goal result.' },
          reply: { type: 'string', const: REPLY_NONE, description: 'Explicitly confirm no new reply is owed because the requested result was already delivered.' },
        } } as never,
        async execute(_toolCallId, args, signal) {
          try {
            if (!finishInput(args) || !isCurrent() || !context.assertInvocationCurrent ||
              ![context.agentId, context.sessionKey, context.sessionId].every(nonempty)) throw new Error('Finish unavailable');
            signal?.throwIfAborted();
            context.assertInvocationCurrent();
            const details = { status: FINISH_UNCONFIRMED, goalId: args.goalId, reply: REPLY_NONE,
              invocation: { agentId: context.agentId!, sessionKey: context.sessionKey!, sessionId: context.sessionId! },
              nextAction: FINISH_UNCONFIRMED_GUIDANCE };
            return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
          } catch {
            const details = { status: FINISH_UNAVAILABLE, nextAction: FINISH_UNCONFIRMED_GUIDANCE };
            return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
          }
        },
      };
    },
  }, { name: GOAL_FINISH_TOOL_NAME });
  api.registerAgentToolResultMiddleware(async (event, context) => {
    try {
      const { runtime, agentId, sessionKey, sessionId, runId } = context;
      if (runtime !== NATIVE_RUNTIME || event.isError === true || Reflect.get(event.result, 'isError') === true ||
        ![agentId, sessionKey, sessionId, runId].every(nonempty) || !runInBackgroundContext || !isCurrent()) return;
      const prepared = prepareResult(event);
      if (!prepared) return;
      if (prepared.invocation && (prepared.invocation.agentId !== agentId || prepared.invocation.sessionKey !== sessionKey ||
        prepared.invocation.sessionId !== sessionId)) return;
      const response: unknown = await boundedRead(() => runInBackgroundContext(() => api.runtime.gateway.request('sessions.describe', {
        key: sessionKey, agentId,
      }, { scopes: ['operator.read'], timeoutMs: GOAL_READ_TIMEOUT_MS })));
      if (!isCurrent() || !record(response) || !record(response.session)) return;
      const session = response.session;
      const continuation = record(session.goalContinuation) ? session.goalContinuation : null;
      const accepted = continuation && record(continuation.lastAccepted) ? continuation.lastAccepted : null;
      if (session.key !== sessionKey || session.sessionId !== sessionId || session.agentId !== agentId ||
        !nonempty(session.lifecycleRevision) || !record(session.goal) || session.goal.id !== prepared.goalId || session.goal.status !== GOAL_COMPLETE ||
        !accepted || accepted.runId !== runId || accepted.goalId !== prepared.goalId || !nonempty(accepted.predecessorRunId) ||
        !positiveInteger(accepted.continuationTurns) || !positiveInteger(accepted.acceptedAt)) return;
      return { result: prepared.result };
    } catch {
      // Read failures and unfamiliar native shapes retain the actual tool result.
      return;
    }
  }, { runtimes: [NATIVE_RUNTIME], matcher: [GOAL_TOOL_NAME, GOAL_FINISH_TOOL_NAME, TOOL_CALL_NAME] });
}
