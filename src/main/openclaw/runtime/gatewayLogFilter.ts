import { stripVTControlCharacters } from 'node:util';

type BufferedAgentStream = 'assistant' | 'item' | 'thinking';

type BufferedStreamState = {
  runId: string;
  tail: string | null;
};

type AgentEvent = {
  runId: string;
  stream: string;
};

const parseAgentEvent = (line: string): AgentEvent | null => {
  if (!line.includes('[ws] → event agent ')) return null;
  const runId = line.match(/\brun=([^\s]+)/)?.[1];
  const stream = line.match(/\bstream=([^\s]+)/)?.[1];
  return runId && stream ? { runId, stream } : null;
};

const getBufferedAgentStream = (stream: string): BufferedAgentStream | null => {
  if (stream === 'thinking' || stream === 'assistant' || stream === 'item') return stream;
  return null;
};

const STREAM_PREVIEW_CHARS = 80;

const summarizeStreamText = (line: string): string => {
  const textIndex = line.indexOf(' text=');
  if (textIndex < 0) return line;
  const newline = line.endsWith('\n') ? '\n' : '';
  const text = line.slice(textIndex + 6).replace(/\r?\n$/, '');
  const characters = Array.from(text);
  const preview =
    characters.length <= STREAM_PREVIEW_CHARS
      ? text
      : `${characters.slice(0, STREAM_PREVIEW_CHARS).join('')}…`;
  return `${line.slice(0, textIndex)} textChars=${characters.length} preview=${JSON.stringify(preview)}${newline}`;
};

const isDiscardedTransportEvent = (line: string): boolean =>
  line.includes('possibly sensitive key found:') ||
  line.includes('[plugins] loading ') ||
  (line.includes('[ws] → event chat ') && line.includes('dropIfSlow=true')) ||
  (line.includes('[ws] → event task ') && line.includes('dropIfSlow=true')) ||
  line.includes('[ws] → event tick ') ||
  line.includes('[ws] → event health ');

export class GatewayStdoutLogFilter {
  private partialLine = '';
  private bufferedStreams = new Map<string, BufferedStreamState>();

  push(text: string): string {
    const combined = this.partialLine + text;
    const lastNewlineIndex = combined.lastIndexOf('\n');
    if (lastNewlineIndex < 0) {
      this.partialLine = combined;
      return '';
    }

    const completeText = combined.slice(0, lastNewlineIndex + 1);
    this.partialLine = combined.slice(lastNewlineIndex + 1);
    let output = '';

    for (const line of completeText.match(/.*\n/g) ?? []) {
      output += this.processLine(line);
    }

    return output;
  }

  flush(): string {
    const partialLine = this.partialLine;
    this.partialLine = '';
    return (partialLine ? this.processLine(partialLine) : '') + this.flushAllStreams();
  }

  private processLine(line: string): string {
    // OpenClaw normally disables colors when stdout is piped, but inherited
    // FORCE_COLOR settings can still insert ANSI sequences between tokens.
    // Classify and persist the visible text so terminal capabilities cannot
    // change which high-volume transport events the filter recognizes.
    const visibleLine = stripVTControlCharacters(line);
    if (isDiscardedTransportEvent(visibleLine)) return '';

    const agentEvent = parseAgentEvent(visibleLine);
    if (!agentEvent) return visibleLine;

    const bufferedStream = getBufferedAgentStream(agentEvent.stream);
    if (!bufferedStream) {
      return this.flushRunStreams(agentEvent.runId) + visibleLine;
    }

    const key = `${agentEvent.runId}:${bufferedStream}`;
    const summarizedLine = summarizeStreamText(visibleLine);
    const activeState = this.bufferedStreams.get(key);
    if (activeState) {
      activeState.tail = summarizedLine;
      return '';
    }

    const previousStreamTail = this.flushRunStreams(agentEvent.runId);
    this.bufferedStreams.set(key, { runId: agentEvent.runId, tail: null });
    return previousStreamTail + summarizedLine;
  }

  private flushRunStreams(runId: string): string {
    let output = '';
    for (const [key, state] of this.bufferedStreams) {
      if (state.runId !== runId) continue;
      output += state.tail ?? '';
      this.bufferedStreams.delete(key);
    }
    return output;
  }

  private flushAllStreams(): string {
    let output = '';
    for (const state of this.bufferedStreams.values()) {
      output += state.tail ?? '';
    }
    this.bufferedStreams.clear();
    return output;
  }
}
