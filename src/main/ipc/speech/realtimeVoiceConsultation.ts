import { isRealtimeVoiceIdentity, type RealtimeVoiceSource } from '../../../shared/speech/realtimeVoice';
import type { GatewayClientLike } from '../../engine/gateway/types';

const CONSULT_TOOL = 'openclaw_agent_consult';
const CONTROL_TOOL = 'openclaw_agent_control';
const CONTROL_MODES = new Set(['status', 'steer', 'cancel', 'followup']);
const MAX_CALL_IDENTITIES = 128;
const MAX_PENDING_CALLS = 4;
const MAX_EARLY_RESULTS = 8;
const MAX_CONTENT_BLOCKS = 128;
const MAX_TEXT_CHARS = 10_000;
const MAX_RESULT_BYTES = 40_000;
const MAX_ARGUMENT_BYTES = 64_000;
const ACK_TIMEOUT_MS = 15_000;
const RESULT_TIMEOUT_MS = 120_000;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
type Result = { result: string } | { error: string } | { status: 'cancelled' };
interface PendingConsult {
  callId: string;
  kind: 'consult' | 'control' | 'unsupported';
  turnId?: string;
  runId?: string;
  finished: boolean;
  early: Map<string, Result>;
  timer?: ReturnType<typeof setTimeout>;
}

function parseControlArgs(value: unknown): { text: string; mode?: string } | undefined {
  let args = value;
  if (typeof args === 'string') {
    if (Buffer.byteLength(args, 'utf8') > MAX_ARGUMENT_BYTES) return undefined;
    try { args = JSON.parse(args); } catch { args = { text: args }; }
  }
  if (!record(args)) return undefined;
  const fields = args;
  const text = ['text', 'message', 'request', 'query'].map(key => fields[key])
    .find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()))?.trim();
  if (!text || text.length > MAX_TEXT_CHARS || Buffer.byteLength(text, 'utf8') > MAX_ARGUMENT_BYTES) return undefined;
  if (args.mode === undefined) return { text };
  const mode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : '';
  return CONTROL_MODES.has(mode) ? { text, mode } : undefined;
}

/** The public control result travels unchanged, within a bounded JSON envelope. */
function boundedControlResult(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  let remaining = 512;
  const seen = new Set<object>();
  const valid = (item: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 16) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= MAX_TEXT_CHARS;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) return item.every(child => valid(child, depth + 1));
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    return Object.entries(item).every(([key, child]) => key.length <= 256 && valid(child, depth + 1));
  };
  if (!valid(value, 0)) return undefined;
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, 'utf8') <= MAX_RESULT_BYTES ? JSON.parse(json) as Record<string, unknown> : undefined;
}

/** A bounded RPC result mailbox, never a transcript store or execution-outcome authority. */
export class RealtimeVoiceConsultations {
  private readonly calls = new Map<string, PendingConsult>();
  private closed = false;

  constructor(private readonly deps: {
    client: GatewayClientLike;
    source: RealtimeVoiceSource;
    voiceSessionId: string;
    isCurrent: () => boolean;
    onFailure: () => void;
  }) {}

  accept(event: Record<string, unknown>, turnId?: string): void {
    if (this.closed || !this.deps.isCurrent()) return;
    if (!isRealtimeVoiceIdentity(event.callId)) { this.fail(); return; }
    if (this.calls.has(event.callId)) return;
    if (this.calls.size >= MAX_CALL_IDENTITIES ||
      [...this.calls.values()].filter(call => !call.finished).length >= MAX_PENDING_CALLS) {
      this.fail(); return;
    }
    const kind = event.name === CONSULT_TOOL ? 'consult' : event.name === CONTROL_TOOL ? 'control' : 'unsupported';
    const call: PendingConsult = { callId: event.callId, kind, turnId, finished: false, early: new Map() };
    this.calls.set(call.callId, call);
    if (kind === 'unsupported') {
      void this.submit(call, { error: 'This tool is not available in realtime voice.' });
      return;
    }
    call.timer = setTimeout(() => this.fail(), ACK_TIMEOUT_MS);
    if (kind === 'control') {
      const args = parseControlArgs(event.args);
      if (!args) void this.submit(call, { error: 'Invalid realtime voice control arguments.' });
      else void this.control(call, args);
      return;
    }
    let args: unknown = event.args ?? {};
    try {
      if (typeof args === 'string') args = JSON.parse(args);
      if (!record(args) || Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES)
        throw new Error('Invalid native consultation arguments.');
    } catch { this.fail(); return; }
    void this.launch(call, args);
  }

  receiveChat(value: unknown): void {
    if (this.closed || !this.deps.isCurrent() || !record(value) ||
      value.sessionKey !== this.deps.source.sessionKey || !isRealtimeVoiceIdentity(value.runId) ||
      (value.sessionId !== undefined && value.sessionId !== this.deps.source.sessionId) ||
      !['final', 'error', 'aborted'].includes(String(value.state))) return;
    const pending = [...this.calls.values()].filter(call => call.kind === 'consult' &&
      !call.finished && (!call.runId || call.runId === value.runId));
    if (!pending.length) return;
    let result: Result;
    if (value.state === 'aborted') result = { status: 'cancelled' };
    else if (value.state === 'error') result = { error: 'The native voice consultation failed.' };
    else {
      const message = record(value.message) ? value.message : {};
      const content = message.content;
      if (Array.isArray(content) && content.length > MAX_CONTENT_BLOCKS) { this.fail(); return; }
      const parts = Array.isArray(content) ? content.flatMap(block =>
        record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
        : typeof content === 'string' ? [content] : [];
      if (parts.some(part => part.length > MAX_TEXT_CHARS) ||
        parts.reduce((length, part) => length + part.length, 0) > MAX_TEXT_CHARS) { this.fail(); return; }
      const text = parts.join('\n').trim();
      // Empty/deferred finals do not own an answer. A later exact native final may still arrive.
      if (message.role !== 'assistant' || !text) return;
      if (text.length > MAX_TEXT_CHARS || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
        this.fail(); return;
      } else result = { result: text };
    }
    for (const call of pending) {
      if (call.runId === value.runId) void this.submit(call, result);
      else if (!call.runId) {
        // Final delivery can precede its RPC ACK. Only that ACK may claim an exact run.
        if (!call.early.has(value.runId) && call.early.size >= MAX_EARLY_RESULTS) {
          this.fail(); return;
        }
        if (!call.early.has(value.runId)) call.early.set(value.runId, result);
      }
    }
  }

  retire(callId: unknown): void {
    const call = typeof callId === 'string' ? this.calls.get(callId) : undefined;
    if (call) this.finish(call);
  }

  cancelTurn(turnId: unknown): void {
    if (typeof turnId !== 'string') return;
    // A cancel control can itself retire the consult turn before its own RPC result arrives.
    for (const call of this.calls.values()) if (call.kind === 'consult' && call.turnId === turnId) this.finish(call);
  }

  close(): void {
    this.closed = true;
    for (const call of this.calls.values()) this.finish(call);
    this.calls.clear();
  }

  private finish(call: PendingConsult): void {
    call.finished = true;
    if (call.timer) clearTimeout(call.timer);
    call.early.clear();
  }

  private fail(): void {
    if (this.closed) return;
    this.close();
    if (this.deps.isCurrent()) this.deps.onFailure();
  }

  private async launch(call: PendingConsult, args: unknown): Promise<void> {
    try {
      if (!this.deps.isCurrent()) { this.close(); return; }
      const result = await this.deps.client.request<Record<string, unknown>>('talk.client.toolCall', {
        sessionKey: this.deps.source.sessionKey,
        voiceSessionId: this.deps.voiceSessionId,
        relaySessionId: this.deps.voiceSessionId,
        callId: call.callId, name: CONSULT_TOOL, args,
      }, { timeoutMs: ACK_TIMEOUT_MS });
      if (this.closed || call.finished) return;
      if (!this.deps.isCurrent()) { this.close(); return; }
      if (!record(result) || !isRealtimeVoiceIdentity(result.runId) ||
        result.agentSessionKey !== this.deps.source.sessionKey ||
        [...this.calls.values()].some(other => other !== call && other.runId === result.runId)) {
        this.fail(); return;
      }
      if (call.timer) clearTimeout(call.timer);
      call.runId = result.runId;
      const early = call.early.get(call.runId);
      call.early.clear();
      call.timer = setTimeout(() => this.fail(), RESULT_TIMEOUT_MS);
      if (early) await this.submit(call, early);
    } catch {
      // This non-idempotent launch may already own a run. Close its known relay; never retry.
      if (!this.closed && !call.finished) this.fail();
    }
  }

  private async control(call: PendingConsult, args: { text: string; mode?: string }): Promise<void> {
    try {
      if (!this.deps.isCurrent()) { this.close(); return; }
      const result = await this.deps.client.request('talk.session.steer', {
        sessionId: this.deps.voiceSessionId, sessionKey: this.deps.source.sessionKey, ...args,
      }, { timeoutMs: ACK_TIMEOUT_MS });
      if (this.closed || call.finished) return;
      if (!this.deps.isCurrent()) { this.close(); return; }
      const bounded = boundedControlResult(result);
      if (!bounded) { this.fail(); return; }
      await this.submit(call, bounded);
    } catch {
      // Steering may already have changed native work. Never repeat an uncertain control.
      if (!this.closed && !call.finished) this.fail();
    }
  }

  private async submit(call: PendingConsult, result: Record<string, unknown>): Promise<void> {
    if (this.closed || call.finished || !this.deps.isCurrent()) return;
    this.finish(call);
    try {
      // A chat result is an output artifact, not proof that native execution settled.
      await this.deps.client.request('talk.session.submitToolResult', {
        sessionId: this.deps.voiceSessionId, callId: call.callId, result,
      }, { timeoutMs: ACK_TIMEOUT_MS });
    } catch { if (!this.closed && this.deps.isCurrent()) this.fail(); }
  }
}
