import { randomUUID } from 'node:crypto';

import {
  type NormalizedAgentEvent,
  readTerminalGuardObservation,
} from '../../../shared/openclaw/agentEvent';

const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

interface TextItem {
  id: string;
  text: string;
}

/** Transient projection for one turn; the Gateway owns the transcript. */
export class MulticaCodexProgress {
  private inputStarted = false;
  private assistant: TextItem | null = null;
  private reasoning: TextItem | null = null;
  private guarded: { token: string; text: string } | null = null;

  constructor(
    private readonly input: string,
    private readonly notify: (method: string, params: Record<string, unknown>) => void,
    private readonly fail: (message: string) => void,
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
        content: [{ type: 'text', text: this.input }],
      };
      this.notify('item/started', { item });
      this.notify('item/completed', { item });
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
        this.notify('item/started', {
          item: { id: this.reasoning.id, type: 'reasoning', summary: [], content: [] },
        });
      }
      const delta = text.slice(this.reasoning.text.length);
      this.reasoning.text = text;
      if (delta)
        this.notify('item/reasoning/textDelta', {
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
          const text = this.guarded.text;
          this.guarded = null;
          this.updateAssistant(text);
        }
        return;
      }
      const previous = observation
        ? this.guarded?.token === observation.token
          ? this.guarded.text
          : undefined
        : this.assistant?.text;
      const text = typeof data.text === 'string' ? data.text : (previous ?? '') + this.delta(data);
      if (!this.withinLimit(text, 'Assistant')) return;
      if (observation) {
        // Multica's transcript is append-only. Hold provisional output until
        // the native guard commits it, so rollback never leaks hidden text.
        this.guarded = { token: observation.token, text };
        return;
      }
      if (typeof data.text === 'string' || typeof data.delta === 'string')
        this.updateAssistant(text);
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

  private updateAssistant(text: string): void {
    if (!this.withinLimit(text, 'Assistant')) return;
    this.completeReasoning();
    if (this.assistant && !text.startsWith(this.assistant.text))
      this.completeAssistant('commentary');
    if (!text || (!this.assistant && !text.trim())) return;
    if (!this.assistant) {
      this.assistant = { id: randomUUID(), text: '' };
      this.notify('item/started', {
        item: { id: this.assistant.id, type: 'agentMessage', text: '', phase: 'commentary' },
      });
    }
    const delta = text.slice(this.assistant.text.length);
    this.assistant.text = text;
    if (delta) this.notify('item/agentMessage/delta', { itemId: this.assistant.id, delta });
  }

  private completeAssistant(phase: 'commentary' | 'final_answer'): void {
    if (!this.assistant) return;
    this.notify('item/completed', {
      item: { ...this.assistant, type: 'agentMessage', phase },
    });
    this.assistant = null;
  }

  private completeReasoning(): void {
    if (!this.reasoning) return;
    this.notify('item/completed', {
      item: {
        id: this.reasoning.id,
        type: 'reasoning',
        summary: [],
        content: [this.reasoning.text],
      },
    });
    this.reasoning = null;
  }
}
