import type { BrowserExtensionMessageDisplay } from '@shared/browser/browserExtensionDisplay';
import type { BrowserExtensionStreamEvent } from '@shared/browser/browserExtensionStream';
import { readTerminalGuardObservation } from '@shared/openclaw/agentEvent';

import { createChatTranscriptState, type TurnItem } from '../chat-transcript-state';
import { reduceAgentEvent, reduceChatEvent } from '../turn/agent-event-reducer';
import { createRunActivity, type RunActivity } from '../turn/run-activity';
import { projectBrowserExtensionActivity } from './browser-extension-activity';
import { prepareBrowserExtensionStreamEvent } from './browser-extension-display';

export { foldBrowserExtensionEntries, isBrowserQuestionTool } from './browser-extension-timeline';
export { isPresentPlanToolName } from '@shared/cowork/interactions/planPreview';

type Item = Record<string, unknown> & {
  type: string;
  id?: string;
  /** Local presentation identity; never a native ownership or authorization field. */
  displayKey?: string;
  display?: BrowserExtensionMessageDisplay;
};
type Thread = { id: string; turns: Array<{ id: string; items: Item[] }> };
const MAX_PENDING_STREAM_EVENTS = 64;
const MAX_PENDING_STREAM_CHARS = 1_000_000;
const MAX_DISPLAY_ITEM_KEYS = 2048;

function projectItem(item: Exclude<TurnItem, { type: 'compaction' }>): Item {
  const identity = {
    id: item.id,
    displayKey: item.id,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    status: item.status,
  };
  if (item.type === 'content') return { ...identity, type: 'agentMessage', text: item.text };
  if (item.type === 'thinking') return { ...identity, type: 'reasoning', content: [item.text] };
  if (item.type === 'terminal') return { ...identity, type: 'systemMessage', text: item.message };
  return {
    ...identity,
    type: 'toolCall',
    toolUseId: item.toolCallId,
    toolName: item.name,
    input: item.input,
    output: item.error ?? item.output,
    progressText: item.progressText,
    status: item.status === 'running' ? 'inProgress' : item.status,
    isError: item.status === 'failed',
    ...(item.presentation?.questionResult ? { questionResult: item.presentation.questionResult } : {}),
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
      ? {
          ...history,
          id: live.id,
          displayKey: live.displayKey,
          status: live.status,
          startedAt: live.startedAt,
          updatedAt: live.updatedAt,
        }
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
  private activity: RunActivity | null = null;
  private boundRunId: string | null = null;
  private pendingRunEvents: BrowserExtensionStreamEvent[] | null = null;
  private pendingRunChars = 0;
  private historyOnly = false;
  private anchor: number | null = null;
  private completedRuns = new Set<string>();
  private settled = false;
  private beforeStart: Thread | null = null;
  private readonly displayTurnIds = new Map<number, string>();
  private readonly displayItemKeys = new Map<string, string>();
  private readonly dependencies = {
    now: () => Date.now(),
    createId: (prefix: string) => `live-${prefix}-${++this.nextId}`,
  };

  constructor(private readonly threadId: string) {
    this.history = { id: threadId, turns: [] };
  }

  /** Retain only IDs for uniquely identified rows already joined by display reconciliation. */
  private retainDisplayKeys(turn: Thread['turns'][number]): Thread['turns'][number] {
    const sources = turn.items.map(item => {
      const display = item.display;
      if (!display?.sourceId || !Number.isSafeInteger(display.sourceIndex)) return null;
      return JSON.stringify([
        turn.id,
        item.type,
        display.sourceId,
        display.sourceSegmentId ?? '',
        display.sourceIndex,
      ]);
    });
    const counts = new Map<string, number>();
    for (const source of sources) if (source) counts.set(source, (counts.get(source) ?? 0) + 1);
    return {
      ...turn,
      items: turn.items.map((item, index) => {
        const source = sources[index];
        if (!source) return item;
        if (counts.get(source) !== 1) {
          this.displayItemKeys.delete(source);
          return item;
        }
        if (item.displayKey) {
          this.displayItemKeys.set(source, item.displayKey);
          if (this.displayItemKeys.size > MAX_DISPLAY_ITEM_KEYS) {
            this.displayItemKeys.delete(this.displayItemKeys.keys().next().value!);
          }
          return item;
        }
        const displayKey = this.displayItemKeys.get(source);
        return displayKey ? { ...item, displayKey } : item;
      }),
    };
  }

  /** Bind a server-confirmed run before its first native stream event. */
  bindRun(runId: string, startedAt = Date.now()): boolean {
    if (
      !runId.trim() ||
      this.completedRuns.has(runId) ||
      (this.boundRunId !== null && this.boundRunId !== runId) ||
      (this.state.activeTurn && this.state.activeTurn.runId !== runId)
    )
      return false;
    this.boundRunId = runId;
    if (!this.historyOnly) this.activity ??= createRunActivity(runId, startedAt);
    const pending = this.pendingRunEvents;
    this.pendingRunEvents = null;
    this.pendingRunChars = 0;
    for (const value of pending ?? []) {
      if (value.event.runId === runId) this.accept(value);
    }
    return true;
  }

  start(message: string, rawMessage?: Record<string, unknown>): void {
    this.finish();
    this.pendingRunEvents = [];
    this.pendingRunChars = 0;
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
      turns: thread.turns.map((turn, index) =>
        this.retainDisplayKeys({
          ...turn,
          id: this.displayTurnIds.get(index) ?? turn.id,
        }),
      ),
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
    if (this.pendingRunEvents !== null) {
      // A new send can overlap delayed events from an earlier run on the same
      // subscription. Only an explicit native binding can adopt these frames.
      if (this.pendingRunChars >= 0) {
        const size = JSON.stringify(value).length;
        if (
          this.pendingRunEvents.length >= MAX_PENDING_STREAM_EVENTS ||
          this.pendingRunChars + size > MAX_PENDING_STREAM_CHARS
        ) {
          // Do not replay a truncated delta lane. The next authenticated history
          // read calibrates the view without guessing the missing prefix.
          this.pendingRunEvents = [];
          this.pendingRunChars = -1;
          this.historyOnly = true;
        } else {
          this.pendingRunEvents.push(value);
          this.pendingRunChars += size;
        }
      }
      return false;
    }
    // Missing deltas cannot be repaired by appending later fragments, even
    // after one history page arrives. Keep this run on authoritative history.
    if (this.historyOnly) return false;
    const prepared = prepareBrowserExtensionStreamEvent(value);
    if (!prepared) return false;
    value = prepared;
    const event = value.event;
    if (!event.sessionKey || (event.runId && this.completedRuns.has(event.runId))) return false;
    if (this.boundRunId && event.runId !== this.boundRunId) return false;
    if (!this.state.sessionKey) this.state.sessionKey = event.sessionKey;
    // Native Agent snapshots own the live text once available. Chat deltas are
    // a second delivery path, not another segment to append to the same reply.
    if (value.kind === 'chat' && value.event.state === 'delta' && this.agentTextRun === event.runId)
      return false;
    // Error notifications can describe a retry attempt. The app-server's
    // authoritative turn/completed decides whether the product run failed.
    if (value.kind === 'chat' && value.event.state === 'error') return false;
    const previousHighWater =
      this.state.activeTurn?.runId === event.runId ? this.state.activeTurn.lastAgentSeq : -1;
    const result =
      value.kind === 'agent'
        ? reduceAgentEvent(this.state, value.event, this.dependencies, {
            allowSequenceBackfill:
              value.event.deliveryEvent === 'session.tool' ||
              Number.isSafeInteger(value.event.data.progressSegmentFirstSeq),
          })
        : reduceChatEvent(this.state, value.event, this.dependencies);
    if (result !== 'applied' && result !== 'needs-text-snapshot') return false;
    this.activity = projectBrowserExtensionActivity(
      this.activity,
      value,
      this.state.activeTurn,
      previousHighWater,
    );
    if (value.kind === 'agent' && value.event.stream === 'assistant') {
      if (readTerminalGuardObservation(value.event.data)?.action === 'rollback') {
        this.agentTextRun = null;
      } else if (this.state.activeTurn?.assistantTextSourceSelected) {
        this.agentTextRun = event.runId;
      }
    }
    return true;
  }

  project(): Thread & { activity?: RunActivity } {
    const history = {
      ...this.history,
      ...(this.activity ? { activity: this.activity } : {}),
    };
    const turn = this.state.activeTurn;
    if (!turn?.items.length) return history;
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
    turns[index] = this.retainDisplayKeys({
      ...historical,
      items: reconcileItems(historical.items, live).items,
    });
    return { ...history, turns };
  }

  finish(preserveUnpersisted = false): void {
    this.pendingRunEvents = null;
    this.pendingRunChars = 0;
    this.historyOnly = false;
    if (this.boundRunId) this.completedRuns.add(this.boundRunId);
    this.activity = null;
    this.boundRunId = null;
    if (this.state.activeTurn) {
      this.completedRuns.add(this.state.activeTurn.runId);
    }
    if (this.completedRuns.size > 24)
      this.completedRuns.delete(this.completedRuns.values().next().value!);
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
    // Preserve display identities only for the overlap already reconciled in
    // this turn. Native history remains the owner of its content and boundaries.
    if (this.state.activeTurn?.items.length) {
      const index = this.anchor ?? Math.max(0, this.history.turns.length - 1);
      const historical = this.history.turns[index];
      if (historical) {
        const live = this.state.activeTurn.items
          .filter(item => item.type !== 'compaction' && item.type !== 'terminal')
          .map(projectItem);
        const { matches } = reconcileItems(historical.items, live);
        const ids = new Map(matches.map((match, position) => [match, live[position]]));
        this.history = {
          ...this.history,
          turns: this.history.turns.map((turn, position) =>
            position === index
              ? this.retainDisplayKeys({
                  ...turn,
                  items: turn.items.map((item, itemIndex) =>
                    ids.get(itemIndex)
                      ? {
                          ...item,
                          id: ids.get(itemIndex)!.id,
                          displayKey: ids.get(itemIndex)!.displayKey,
                        }
                      : item,
                  ),
                })
              : turn,
          ),
        };
      }
    }
    this.state = createChatTranscriptState();
    this.agentTextRun = null;
    this.anchor = null;
    this.settled = false;
    this.beforeStart = null;
  }
}
