import type { BrowserExtensionStreamEvent } from '@shared/browser/browserExtensionStream';
import { readTerminalGuardObservation } from '@shared/openclaw/agentEvent';

import { createChatTranscriptState, type TurnItem } from '../chat-transcript-state';
import { reduceAgentEvent, reduceChatEvent } from '../turn/agent-event-reducer';
import { prepareBrowserExtensionStreamEvent } from './browser-extension-display';

type Item = Record<string, unknown> & { type: string; id?: string };
type Thread = { id: string; turns: Array<{ id: string; items: Item[] }> };

function projectItem(item: Exclude<TurnItem, { type: 'compaction' }>): Item {
  if (item.type === 'content') return { id: item.id, type: 'agentMessage', text: item.text };
  if (item.type === 'thinking')
    return { id: item.id, type: 'reasoning', content: [item.text], status: item.status };
  if (item.type === 'terminal') return { id: item.id, type: 'systemMessage', text: item.message };
  return {
    id: item.id,
    type: 'toolCall',
    toolUseId: item.toolCallId,
    toolName: item.name,
    input: item.input,
    output: item.error ?? item.output,
    status: item.status === 'running' ? 'inProgress' : item.status,
    isError: item.status === 'failed',
  };
}

function itemText(item: Item): string {
  return item.type === 'reasoning'
    ? [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : []),
      ].join('\n')
    : typeof item.text === 'string'
      ? item.text
      : '';
}

function sameItem(history: Item, live: Item): boolean {
  if (history.type !== live.type) return false;
  if (live.type === 'toolCall')
    return Boolean(live.toolUseId) && history.toolUseId === live.toolUseId;
  const a = itemText(history).trim();
  const b = itemText(live).trim();
  return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
}

function mergeItem(history: Item, live: Item): Item {
  if (live.type !== 'toolCall') {
    return itemText(history).startsWith(itemText(live))
      ? { ...history, status: live.status }
      : live;
  }
  const merged = {
    ...history,
    ...Object.fromEntries(Object.entries(live).filter(([, value]) => value !== undefined)),
  } as Item;
  // A subscriber can join after the start, or receive an older start after a
  // persisted result. Neither case should erase the known input/result.
  if (history.status !== 'inProgress' && live.status === 'inProgress') {
    merged.status = history.status;
    merged.output = history.output;
    merged.isError = history.isError;
  }
  return merged;
}

function reconcileItems(history: Item[], live: Item[]): { items: Item[]; matches: number[] } {
  const toolIndex = (item: Item) =>
    item.type === 'toolCall' ? history.findIndex(candidate => sameItem(candidate, item)) : -1;
  const matches: number[] = [];
  let previousMatch = -1;
  let unanchoredTool = false;
  for (let index = 0; index < live.length; index += 1) {
    const item = live[index];
    let match = toolIndex(item);
    if (item.type !== 'toolCall' && !unanchoredTool) {
      const followingTool = live
        .slice(index + 1)
        .map(toolIndex)
        .find(value => value >= 0);
      const end = followingTool ?? history.length;
      // Text identity is only meaningful inside the same Tool-delimited
      // segment. Identical prefixes before an earlier Tool are a different
      // message, not an overlap to truncate.
      let boundary = end - 1;
      while (boundary >= 0 && history[boundary].type !== 'toolCall') boundary -= 1;
      const start = Math.max(previousMatch + 1, boundary + 1);
      match = history.findIndex(
        (candidate, position) => position >= start && position < end && sameItem(candidate, item),
      );
    }
    if (match <= previousMatch) match = -1;
    // Until this Tool is persisted, following text belongs beyond the known
    // historical boundary, even if it repeats the preceding response exactly.
    if (item.type === 'toolCall') unanchoredTool = match < 0;
    matches.push(match);
    if (match >= 0) previousMatch = match;
  }
  const items: Item[] = [];
  let cursor = 0;
  for (let index = 0; index < live.length; index += 1) {
    const match = matches[index];
    if (match >= 0) {
      items.push(...history.slice(cursor, match), mergeItem(history[match], live[index]));
      cursor = match + 1;
    } else {
      const followingMatch = matches.slice(index + 1).find(value => value >= 0);
      const position = followingMatch ?? history.length;
      items.push(...history.slice(cursor, position), live[index]);
      cursor = position;
    }
  }
  items.push(...history.slice(cursor));
  return { items, matches };
}

/** Browser-only projection. Durable history remains owned by Gateway. */
export class BrowserExtensionStream {
  private history: Thread;
  private state = createChatTranscriptState();
  private nextId = 0;
  private agentTextRun: string | null = null;
  private anchor: number | null = null;
  private completedRuns = new Set<string>();
  private settled = false;
  private beforeStart: Thread | null = null;
  private readonly displayTurnIds = new Map<number, string>();
  private readonly dependencies = {
    now: () => Date.now(),
    createId: (prefix: string) => `live-${prefix}-${++this.nextId}`,
  };

  constructor(private readonly threadId: string) {
    this.history = { id: threadId, turns: [] };
  }

  start(message: string, rawMessage?: Record<string, unknown>): void {
    this.finish();
    this.beforeStart = this.history;
    this.anchor = this.history.turns.length;
    const turnId = `pending-${this.nextId++}`;
    this.displayTurnIds.set(this.anchor, turnId);
    this.history = {
      ...this.history,
      turns: [
        ...this.history.turns,
        {
          id: turnId,
          items: [
            {
              type: 'userMessage',
              content: [{ type: 'text', text: message }],
              ...(rawMessage ? { rawMessage } : {}),
            },
          ],
        },
      ],
    };
  }

  setHistory(thread: Thread, authoritative = false): void {
    if (thread.id !== this.threadId) return;
    // A pre-send snapshot must not remove the optimistic user/streaming turn.
    if (this.anchor !== null && thread.turns.length <= this.anchor) {
      if (!authoritative) return;
      // Completion can compact the transcript. Count alone no longer locates
      // this run; the freshly read final history owns its new turn boundaries.
      const displayId = this.displayTurnIds.get(this.anchor);
      this.displayTurnIds.clear();
      this.anchor = Math.max(0, thread.turns.length - 1);
      if (displayId && thread.turns.length) this.displayTurnIds.set(this.anchor, displayId);
    }
    this.history = {
      ...thread,
      turns: thread.turns.map((turn, index) => ({
        ...turn,
        id: this.displayTurnIds.get(index) ?? turn.id,
      })),
    };
    this.beforeStart = null;
    if (this.settled) this.finish(true);
  }

  cancelStart(): void {
    const original = this.beforeStart;
    if (original && this.anchor !== null) this.displayTurnIds.delete(this.anchor);
    this.finish();
    if (original) this.history = original;
  }

  accept(value: BrowserExtensionStreamEvent): boolean {
    const prepared = prepareBrowserExtensionStreamEvent(value);
    if (!prepared) return false;
    value = prepared;
    const event = value.event;
    if (!event.sessionKey || (event.runId && this.completedRuns.has(event.runId))) return false;
    if (!this.state.sessionKey) this.state.sessionKey = event.sessionKey;
    // Native Agent snapshots own the live text once available. Chat deltas are
    // a second delivery path, not another segment to append to the same reply.
    if (value.kind === 'chat' && value.event.state === 'delta' && this.agentTextRun === event.runId)
      return false;
    // Error notifications can describe a retry attempt. The app-server's
    // authoritative turn/completed decides whether the product run failed.
    if (value.kind === 'chat' && value.event.state === 'error') return false;
    const result =
      value.kind === 'agent'
        ? reduceAgentEvent(this.state, value.event, this.dependencies, {
            allowSequenceBackfill:
              value.event.deliveryEvent === 'session.tool' ||
              Number.isSafeInteger(value.event.data.progressSegmentFirstSeq),
          })
        : reduceChatEvent(this.state, value.event, this.dependencies);
    if (result !== 'applied' && result !== 'needs-text-snapshot') return false;
    if (value.kind === 'agent' && value.event.stream === 'assistant') {
      if (readTerminalGuardObservation(value.event.data)?.action === 'rollback') {
        this.agentTextRun = null;
      } else if (this.state.activeTurn?.assistantTextSourceSelected) {
        this.agentTextRun = event.runId;
      }
    }
    return true;
  }

  project(): Thread {
    const turn = this.state.activeTurn;
    if (!turn?.items.length) return this.history;
    const turns = this.history.turns.slice();
    const index = this.anchor ?? Math.max(0, turns.length - 1);
    const historical = turns[index] ?? { id: turn.id, items: [] };
    const live = turn.items
      .filter(item => item.type !== 'compaction')
      .filter(
        item =>
          !(
            item.type === 'content' &&
            (item.assistantTextScopeSuppressed || item.assistantTextSourcePending)
          ),
      )
      .map(projectItem);
    turns[index] = { ...historical, items: reconcileItems(historical.items, live).items };
    return { ...this.history, turns };
  }

  finish(preserveUnpersisted = false): void {
    if (this.state.activeTurn) {
      this.completedRuns.add(this.state.activeTurn.runId);
      if (this.completedRuns.size > 24)
        this.completedRuns.delete(this.completedRuns.values().next().value!);
    }
    if (preserveUnpersisted && this.state.activeTurn?.items.length) {
      const historical =
        this.history.turns[this.anchor ?? Math.max(0, this.history.turns.length - 1)]?.items ?? [];
      const live = this.state.activeTurn.items
        .filter(item => item.type !== 'terminal' && item.type !== 'compaction')
        .filter(
          item =>
            !(
              item.type === 'content' &&
              (item.assistantTextScopeSuppressed || item.assistantTextSourcePending)
            ),
        )
        .map(projectItem);
      const { matches } = reconcileItems(historical, live);
      const covered = live.every((item, index) => {
        const candidate = historical[matches[index]];
        if (!candidate) return false;
        if (!sameItem(candidate, item)) return false;
        return item.type === 'toolCall'
          ? candidate.status !== 'inProgress' && Boolean(candidate.output || !item.output)
          : itemText(candidate).includes(itemText(item));
      });
      if (!covered) {
        this.settled = true;
        for (const item of this.state.activeTurn.items) {
          if (item.type === 'tool' && item.status === 'running') item.status = 'interrupted';
          if (item.type === 'thinking' && item.status === 'running') item.status = 'interrupted';
          if (item.type === 'content' && item.status === 'streaming') item.status = 'interrupted';
        }
        return;
      }
    }
    this.state = createChatTranscriptState();
    this.agentTextRun = null;
    this.anchor = null;
    this.settled = false;
    this.beforeStart = null;
  }
}
