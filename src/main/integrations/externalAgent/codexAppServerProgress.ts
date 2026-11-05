import { randomUUID } from 'node:crypto';

import {
  type NormalizedAgentEvent,
  readAssistantTextScope,
  readTerminalGuardObservation,
} from '../../../shared/openclaw/agentEvent';
import {
  AppServerNotificationMethod,
  type AppServerNotify,
} from '../../appServer/appServerProtocol';

const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

interface TextIdentity {
  scopeId?: string;
  nativeItemId?: string;
}

interface TextItem extends TextIdentity {
  id: string;
  text: string;
}

const changedTextIdentity = (previous: TextIdentity, next: TextIdentity): boolean => {
  if (previous.scopeId && next.scopeId) return previous.scopeId !== next.scopeId;
  return Boolean(previous.nativeItemId && next.nativeItemId && previous.nativeItemId !== next.nativeItemId);
};

const assistantFields = {
  type: 'agentMessage',
  memoryCitation: null as null,
  delivery: null as null,
  questions: null as null,
} as const;

/** Transient projection for one turn; the Gateway owns the transcript. */
export class CodexAppServerProgress {
  private inputStarted = false;
  private assistant: TextItem | null = null;
  private reasoning: TextItem | null = null;
  private guarded: { token: string; text: string; identity: TextIdentity } | null = null;

  constructor(
    private readonly input: string,
    private readonly notify: AppServerNotify,
    private readonly fail: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  accept(event: NormalizedAgentEvent): void {
    const data = event.data;
    if (event.stream === 'lifecycle' && data.phase === 'start' && !this.inputStarted) {
      this.inputStarted = true;
      // A real native start admits this user input. Like Codex, publish its
      // item even when the model has not produced its first token yet.
      const item = {
        id: randomUUID(),
        type: 'userMessage',
        clientId: null as null,
        content: [{ type: 'text', text: this.input, text_elements: [] as never[] }],
      };
      this.notify(AppServerNotificationMethod.ItemStarted, { item, startedAtMs: this.now() });
      this.notify(AppServerNotificationMethod.ItemCompleted, { item, completedAtMs: this.now() });
    }
    if (event.stream === 'thinking') {
      this.completeAssistant('commentary');
      const snapshot =
        typeof data.thinking === 'string'
          ? data.thinking
          : typeof data.text === 'string'
            ? data.text
            : undefined;
      const text = snapshot ?? (this.reasoning?.text ?? '') + this.delta(data);
      if (!this.withinLimit(text, 'Reasoning')) return;
      if (this.reasoning && !text.startsWith(this.reasoning.text)) this.completeReasoning();
      if (!this.reasoning) {
        this.reasoning = { id: randomUUID(), text: '' };
        this.notify(AppServerNotificationMethod.ItemStarted, {
          item: { id: this.reasoning.id, type: 'reasoning', summary: [], content: [] },
          startedAtMs: this.now(),
        });
      }
      const delta = text.slice(this.reasoning.text.length);
      this.reasoning.text = text;
      if (delta)
        this.notify(AppServerNotificationMethod.ReasoningTextDelta, {
          itemId: this.reasoning.id,
          contentIndex: 0,
          delta,
        });
    }
    if (event.stream === 'assistant') {
      const observation = readTerminalGuardObservation(data);
      if (observation?.action === 'rollback') {
        if (this.guarded?.token === observation.token) this.guarded = null;
        return;
      }
      if (observation?.action === 'commit') {
        if (this.guarded?.token === observation.token) {
          const { text, identity } = this.guarded;
          this.guarded = null;
          this.updateAssistant(text, identity);
        }
        return;
      }
      const scope = readAssistantTextScope(data);
      const identity: TextIdentity = {
        ...(scope ? { scopeId: scope.id } : {}),
        ...(typeof data.itemId === 'string' && data.itemId ? { nativeItemId: data.itemId } : {}),
      };
      const previous = observation
        ? this.guarded?.token === observation.token
          && !changedTextIdentity(this.guarded.identity, identity)
          ? this.guarded.text
          : undefined
        : this.assistant && !changedTextIdentity(this.assistant, identity)
          ? this.assistant.text
          : undefined;
      const text = typeof data.text === 'string' ? data.text : (previous ?? '') + this.delta(data);
      if (!this.withinLimit(text, 'Assistant')) return;
      if (observation) {
        // Client transcripts are append-only. Hold provisional output until
        // the native guard commits it, so rollback never leaks hidden text.
        this.guarded = {
          token: observation.token,
          text,
          identity: {
            ...(this.guarded?.token === observation.token ? this.guarded.identity : {}),
            ...identity,
          },
        };
        return;
      }
      if (typeof data.text === 'string' || typeof data.delta === 'string')
        this.updateAssistant(text, identity);
    }
  }

  beforeTool(): void {
    this.completeReasoning();
    this.completeAssistant('commentary');
  }

  finish(finalText?: string): void {
    this.guarded = null;
    this.completeReasoning();
    if (finalText && !this.withinLimit(finalText, 'Assistant')) {
      this.completeAssistant('commentary');
      return;
    }
    if (finalText?.trim()) this.updateAssistant(finalText);
    this.completeAssistant(finalText?.trim() ? 'final_answer' : 'commentary');
  }

  private delta(data: Record<string, unknown>): string {
    return typeof data.delta === 'string' ? data.delta : '';
  }

  private withinLimit(text: string, kind: string): boolean {
    if (text.length <= MAX_TEXT_LENGTH) return true;
    this.fail(`${kind} output exceeded the event limit.`);
    return false;
  }

  private updateAssistant(text: string, identity: TextIdentity = {}): void {
    if (!this.withinLimit(text, 'Assistant')) return;
    this.completeReasoning();
    if (this.assistant && (changedTextIdentity(this.assistant, identity) || !text.startsWith(this.assistant.text)))
      this.completeAssistant('commentary');
    if (!text || (!this.assistant && !text.trim())) return;
    if (!this.assistant) {
      this.assistant = { id: randomUUID(), text: '', ...identity };
      this.notify(AppServerNotificationMethod.ItemStarted, {
        item: { id: this.assistant.id, ...assistantFields, text: '', phase: 'commentary' },
        startedAtMs: this.now(),
      });
    }
    const delta = text.slice(this.assistant.text.length);
    this.assistant = { ...this.assistant, ...identity, text };
    if (delta) this.notify(AppServerNotificationMethod.AgentMessageDelta, { itemId: this.assistant.id, delta });
  }

  private completeAssistant(phase: 'commentary' | 'final_answer'): void {
    if (!this.assistant) return;
    this.notify(AppServerNotificationMethod.ItemCompleted, {
      item: { id: this.assistant.id, text: this.assistant.text, ...assistantFields, phase },
      completedAtMs: this.now(),
    });
    this.assistant = null;
  }

  private completeReasoning(): void {
    if (!this.reasoning) return;
    this.notify(AppServerNotificationMethod.ItemCompleted, {
      item: {
        id: this.reasoning.id,
        type: 'reasoning',
        summary: [],
        content: [this.reasoning.text],
      },
      completedAtMs: this.now(),
    });
    this.reasoning = null;
  }
}
