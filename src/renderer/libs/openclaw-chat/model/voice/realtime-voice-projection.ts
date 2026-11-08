import { normalizeMessageSessionKey } from '@shared/openclaw/messageDomain';
import type {
  RealtimeVoiceEvent,
  RealtimeVoiceSession,
  RealtimeVoiceTimelineUpdate,
} from '@shared/speech/realtimeVoice';

export interface VoiceProjectionContext {
  connected: boolean;
  sessionKey: string;
  sessionId: string | null;
  client: object | null;
  clientGeneration: number;
  historyGeneration: number;
  messages: readonly unknown[];
}

export interface LiveVoiceTranscript {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  final: boolean;
  turnId: string;
  transcriptId?: string;
}

interface VoiceScope {
  session: RealtimeVoiceSession;
  client: object;
  clientGeneration: number;
  historyGeneration: number;
  open: boolean;
  sequence: number;
  turnId?: string;
  blockedAssistantTurns: Set<string>;
  retiredTurns: Set<string>;
  entries: LiveVoiceTranscript[];
}

const MAX_PENDING_TRANSCRIPTS = 40;
const MAX_TRANSCRIPT_CHARS = 8_000;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sameSource = (a: RealtimeVoiceSession['source'], b: RealtimeVoiceSession['source']) =>
  a.productSessionId === b.productSessionId && a.sessionId === b.sessionId &&
  normalizeMessageSessionKey(a.sessionKey) === normalizeMessageSessionKey(b.sessionKey);
const boundedText = (text: string) => text.slice(0, MAX_TRANSCRIPT_CHARS).replace(/[\uD800-\uDBFF]$/, '');

/** A current native stream overlay, never a history source or an execution receipt. */
export class RealtimeVoiceProjection {
  private scope?: VoiceScope;

  clear(): boolean {
    const changed = this.scope !== undefined;
    this.scope = undefined;
    return changed;
  }

  private current(context: VoiceProjectionContext): VoiceScope | undefined {
    const scope = this.scope;
    if (scope && context.connected && context.client === scope.client &&
      context.clientGeneration === scope.clientGeneration &&
      context.historyGeneration === scope.historyGeneration &&
      context.sessionId === scope.session.source.sessionId &&
      normalizeMessageSessionKey(context.sessionKey) === normalizeMessageSessionKey(scope.session.source.sessionKey)) {
      return scope;
    }
    this.scope = undefined;
    return undefined;
  }

  accept(update: RealtimeVoiceTimelineUpdate, context: VoiceProjectionContext, now = Date.now()): boolean {
    if (update.type === 'opened') {
      const session = update.session;
      if (!context.connected || !context.client || context.sessionId !== session.source.sessionId ||
        normalizeMessageSessionKey(context.sessionKey) !== normalizeMessageSessionKey(session.source.sessionKey)) return false;
      const previous = this.current(context);
      if (previous?.session.requestId === session.requestId &&
        previous.session.voiceSessionId === session.voiceSessionId && sameSource(previous.session.source, session.source)) return false;
      this.scope = { session: { ...session, source: { ...session.source } }, client: context.client, clientGeneration: context.clientGeneration,
        historyGeneration: context.historyGeneration, open: true, sequence: 0, retiredTurns: new Set(),
        blockedAssistantTurns: new Set(), entries: [] };
      return true;
    }
    const scope = this.current(context);
    const identity = update.type === 'ended' ? update.session : update.event;
    if (!scope || identity.requestId !== scope.session.requestId ||
      identity.voiceSessionId !== scope.session.voiceSessionId || !sameSource(identity.source, scope.session.source)) return false;
    if (update.type === 'ended') {
      scope.open = false;
      scope.entries = scope.entries.filter(entry => entry.final);
      return true;
    }
    if (!scope.open) return false;
    const event = update.event;
    if (event.type === 'responseStarted') {
      if (event.turnId && !scope.retiredTurns.has(event.turnId)) scope.blockedAssistantTurns.delete(event.turnId);
      return false;
    }
    if (event.type === 'clear') {
      const turnId = event.turnId ?? scope.turnId;
      if (turnId) scope.blockedAssistantTurns.add(turnId);
      if (scope.blockedAssistantTurns.size > 256) {
        scope.open = false;
        scope.entries = scope.entries.filter(entry => entry.final);
        return true;
      }
      scope.entries = scope.entries.filter(entry => entry.final || entry.role === 'user' ||
        (event.turnId && entry.turnId !== event.turnId));
      return true;
    }
    if (event.type !== 'transcript' || !event.turnId || typeof event.text !== 'string' ||
      (event.role !== 'user' && event.role !== 'assistant') || scope.retiredTurns.has(event.turnId) ||
      (event.role === 'assistant' && scope.blockedAssistantTurns.has(event.turnId))) return false;
    if (scope.turnId !== event.turnId) {
      if (scope.turnId) {
        scope.retiredTurns.add(scope.turnId);
        scope.blockedAssistantTurns.delete(scope.turnId);
      }
      // Stop projecting rather than forgetting a retired identity and admitting late text.
      if (scope.retiredTurns.size > 256) {
        scope.open = false;
        scope.entries = scope.entries.filter(entry => entry.final);
        return true;
      }
      scope.turnId = event.turnId;
      scope.entries = scope.entries.filter(entry => entry.final);
    }
    const transcriptId = this.nativeTranscriptId(scope, event);
    const previous = [...scope.entries].reverse().find(entry => entry.role === event.role && entry.turnId === event.turnId);
    const entry = scope.entries.find(candidate => transcriptId && candidate.transcriptId === transcriptId) ??
      (previous && !previous.final ? previous : undefined);
    const text = boundedText(event.final || event.textMode === 'snapshot' || !entry
      ? event.text : entry.text + event.text);
    if (event.final && !transcriptId) return false;
    if (entry) {
      entry.text = text;
      entry.final = event.final === true;
      if (transcriptId) entry.transcriptId = transcriptId;
    } else if (text.trim()) {
      scope.entries.push({ key: `voice-live:${scope.session.requestId}:${++scope.sequence}`, role: event.role,
        text, timestamp: now, final: event.final === true, turnId: event.turnId,
        ...(transcriptId ? { transcriptId } : {}) });
    }
    // The ordinary session.message connection can beat the final caption IPC.
    this.reconcile(scope, context.messages);
    scope.entries = scope.entries.slice(-MAX_PENDING_TRANSCRIPTS);
    return true;
  }

  private nativeTranscriptId(scope: VoiceScope, event: RealtimeVoiceEvent): string | undefined {
    const id = event.transcriptId;
    return event.final && id?.startsWith(`voice:${scope.session.voiceSessionId}:`) ? id : undefined;
  }

  private reconcile(scope: VoiceScope, messages: readonly unknown[]): void {
    const ids = new Set(messages.map(message => record(record(message)?.__openclaw)?.id)
      .filter((id): id is string => typeof id === 'string'));
    scope.entries = scope.entries.filter(entry => !entry.transcriptId || !ids.has(entry.transcriptId));
  }

  entries(context: VoiceProjectionContext): readonly LiveVoiceTranscript[] {
    const scope = this.current(context);
    if (!scope) return [];
    this.reconcile(scope, context.messages);
    return scope.entries;
  }
}
