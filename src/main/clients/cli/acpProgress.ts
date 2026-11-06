import {
  type NormalizedAgentEvent,
  readAssistantTextScope,
  readTerminalGuardObservation,
} from '../../../shared/openclaw/agentEvent';
import { t } from '../../core/i18n';

const MAX_TEXT_CHARS = 2 * 1024 * 1024;

interface TextIdentity {
  scopeId?: string;
  itemId?: string;
}

interface TextSnapshot extends TextIdentity {
  text: string;
}

const changedTextIdentity = (previous: TextIdentity, next: TextIdentity): boolean => {
  if (previous.scopeId && next.scopeId) return previous.scopeId !== next.scopeId;
  return Boolean(previous.itemId && next.itemId && previous.itemId !== next.itemId);
};

/** A transient projection of native events; never a second conversation store. */
export class AcpProgress {
  private assistant: TextSnapshot = { text: '' };
  private thinking: TextSnapshot = { text: '' };
  private guarded: { token: string; text: string; identity: TextIdentity } | null = null;
  private readonly tools = new Set<string>();

  constructor(private readonly update: (value: Record<string, unknown>) => void) {}

  accept(event: NormalizedAgentEvent): void {
    const data = event.data;
    if (event.stream === 'assistant') {
      const observation = readTerminalGuardObservation(data);
      if (observation?.action === 'rollback') {
        if (this.guarded?.token === observation.token) this.guarded = null;
        return;
      }
      if (observation?.action === 'commit') {
        if (this.guarded?.token === observation.token) {
          this.text('agent_message_chunk', this.guarded.text, this.guarded.identity);
          this.guarded = null;
        }
        return;
      }
      const scope = readAssistantTextScope(data);
      const identity: TextIdentity = {
        ...(scope ? { scopeId: scope.id } : {}),
        ...(typeof data.itemId === 'string' && data.itemId ? { itemId: data.itemId } : {}),
      };
      const previous = observation
        ? this.guarded?.token === observation.token
          ? this.guarded.text
          : ''
        : changedTextIdentity(this.assistant, identity)
          ? ''
          : this.assistant.text;
      const text =
        typeof data.text === 'string'
          ? data.text
          : previous + (typeof data.delta === 'string' ? data.delta : '');
      this.check(text);
      if (observation) {
        this.guarded = {
          token: observation.token,
          text,
          identity: {
            ...(this.guarded?.token === observation.token ? this.guarded.identity : {}),
            ...identity,
          },
        };
      } else this.text('agent_message_chunk', text, identity);
    } else if (event.stream === 'thinking') {
      const text =
        typeof data.thinking === 'string'
          ? data.thinking
          : typeof data.text === 'string'
            ? data.text
            : this.thinking.text + (typeof data.delta === 'string' ? data.delta : '');
      this.text('agent_thought_chunk', text);
    } else if (event.stream === 'tool' && typeof data.toolCallId === 'string') {
      const toolCallId = data.toolCallId;
      if (data.phase !== 'start' && data.phase !== 'result' && data.phase !== 'update') return;
      const first = !this.tools.has(toolCallId);
      if (first) {
        if (this.tools.size >= 10_000) throw new Error('Too many tool events.');
        this.tools.add(toolCallId);
        this.assistant = { text: '' };
        this.thinking = { text: '' };
      }
      const status =
        data.phase === 'result' ? (data.isError === true ? 'failed' : 'completed') : 'in_progress';
      const rawOutput = data.result ?? data.partialResult ?? data.output;
      if (rawOutput !== undefined) this.check(JSON.stringify(rawOutput));
      this.update({
        sessionUpdate: first ? 'tool_call' : 'tool_call_update',
        toolCallId,
        ...(first
          ? {
              title: typeof data.name === 'string' ? data.name : t('externalAgentTool'),
              kind: 'other',
              rawInput: data.args ?? {},
            }
          : {}),
        status,
        ...(rawOutput !== undefined ? { rawOutput } : {}),
      });
    }
  }

  finish(text?: string): void {
    this.guarded = null;
    if (text) this.text('agent_message_chunk', text);
  }

  private check(text: string): void {
    if (text.length > MAX_TEXT_CHARS) throw new Error('ACP output exceeded the event limit.');
  }

  private text(
    kind: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string,
    identity: TextIdentity = {},
  ): void {
    this.check(text);
    let item = kind === 'agent_message_chunk' ? this.assistant : this.thinking;
    if (changedTextIdentity(item, identity) || !text.startsWith(item.text)) {
      item = { text: '' };
      if (kind === 'agent_message_chunk') this.assistant = item;
      else this.thinking = item;
    }
    Object.assign(item, identity);
    const delta = text.slice(item.text.length);
    item.text = text;
    if (delta) this.update({ sessionUpdate: kind, content: { type: 'text', text: delta } });
  }
}
