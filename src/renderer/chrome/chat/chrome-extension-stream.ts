import type { ChromeExtensionMessageDisplay } from '@shared/chrome/chromeExtensionDisplay';
import type { ChromeExtensionStreamEvent } from '@shared/chrome/chromeExtensionStream';
import { readTerminalGuardObservation } from '@shared/openclaw/agentEvent';

import {
  type AssistantTurn,
  createChatTranscriptState,
  type TurnItem,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import {
  reduceAgentEvent,
  reduceChatEvent,
} from '@/libs/openclaw-chat/model/turn/agent-event-reducer';
import { createRunActivity, type RunActivity } from '@/libs/openclaw-chat/model/turn/run-activity';

import { projectChromeExtensionActivity } from './chrome-extension-activity';
import { prepareChromeExtensionStreamEvent } from './chrome-extension-display';

export { hasChromeProcessFoldText, isOmittedChromeDeliveryText } from './chrome-extension-display';
export { foldChromeExtensionEntries, isChromeQuestionTool } from './chrome-extension-timeline';
export { isPresentPlanToolName } from '@/libs/openclaw-chat/model/turn/plan-preview';

type Item = Record<string, unknown> & {
  type: string;
  id?: string;
  inputRunId?: string;
  /** Local presentation identity; never a native ownership or authorization field. */
  displayKey?: string;
  display?: ChromeExtensionMessageDisplay;
  rawMessage?: Record<string, unknown>;
  /** Native commentary ownership, used only to reconcile this browser view. */
  preambleItemId?: string;
  commentaryItemIds?: readonly string[];
};
/** Optional browser presentation groups; not the app-server's canonical Thread/Turn. */
type ChromeDisplayTurn = { id: string; items: Item[]; processMode?: 'live' | 'failed' };
type ChromeDisplayView = { id: string; turns: ChromeDisplayTurn[] };
type ChromeStreamEvent = ChromeExtensionStreamEvent & { retryAttempt?: number; startedAt?: number };
const MAX_PENDING_STREAM_EVENTS = 64;
const MAX_PENDING_STREAM_CHARS = 1_000_000;
const MAX_DISPLAY_ITEM_KEYS = 2048;
const MAX_OPTIMISTIC_INPUTS = 8;

type OptimisticInput = {
  submissionId: string;
  displayId: string;
  inputRunId: string | undefined;
  item: Item;
  turnIndex: number;
};

const readInputRunId = (item: Item): string | undefined =>
  item.type === 'userMessage' && typeof item.inputRunId === 'string' && item.inputRunId
    ? item.inputRunId
    : undefined;

function projectItem(item: Exclude<TurnItem, { type: 'compaction' }>, turn: AssistantTurn): Item {
  const identity = {
    id: item.id,
    displayKey: item.id,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    status: item.status,
  };
  if (item.type === 'content')
    return {
      ...identity,
      type: 'agentMessage',
      text: item.text,
      ...(item.preambleItemId ? { preambleItemId: item.preambleItemId } : {}),
      ...(item.commentarySnapshot === 'message' && item.assistantTextScopeId
        ? {
            commentaryItemIds: [
              ...new Set([
                ...turn.items.flatMap(candidate =>
                  candidate.type === 'content' &&
                  candidate.assistantTextScopeId === item.assistantTextScopeId &&
                  candidate.preambleItemId
                    ? [candidate.preambleItemId]
                    : [],
                ),
                ...(turn.assistantTextScopes?.get(item.assistantTextScopeId)?.commentaryItemIds ??
                  []),
              ]),
            ],
          }
        : {}),
    };
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
    ...(item.presentation?.questionResult
      ? { questionResult: item.presentation.questionResult }
      : {}),
  };
}

function projectLiveItems(turn: AssistantTurn, includeTerminal = true): Item[] {
  return turn.items
    .filter(
      (item): item is Exclude<TurnItem, { type: 'compaction' }> =>
        item.type !== 'compaction' && (includeTerminal || item.type !== 'terminal'),
    )
    .filter(
      item =>
        !(
          item.type === 'content' &&
          (item.assistantTextScopeSuppressed || item.assistantTextSourcePending)
        ),
    )
    .map(item => projectItem(item, turn));
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
  if (
    live.preambleItemId &&
    history.display?.sourceSegmentId &&
    live.preambleItemId !== history.display.sourceSegmentId
  )
    return false;
  const a = itemText(history).trim();
  const b = itemText(live).trim();
  return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
}

/** Update a display copy while retaining the native row's media and metadata. */
function withItemText(item: Item, text: string): Item {
  const raw = item.rawMessage;
  return {
    ...item,
    text,
    ...(raw
      ? {
          rawMessage: {
            ...raw,
            text: undefined,
            content: Array.isArray(raw.content)
              ? [
                  { type: 'text', text },
                  ...raw.content.filter(
                    block => !block || typeof block !== 'object' || block.type !== 'text',
                  ),
                ]
              : text,
          },
        }
      : {}),
  };
}

function withoutItemText(item: Item): Item | null {
  const raw = item.rawMessage;
  const hasRichContent =
    raw &&
    ((Array.isArray(raw.content) &&
      raw.content.some(block => block && typeof block === 'object' && block.type !== 'text')) ||
      ['MediaPaths', 'MediaUrls', 'MediaPath', 'MediaUrl', '__openclaw', 'openclawDelivery'].some(
        key => Boolean(raw[key]),
      ));
  return hasRichContent ? withItemText(item, '') : null;
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
      : {
          ...withItemText(history, itemText(live)),
          ...live,
        };
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

function reconcileItems(
  history: Item[],
  live: Item[],
): { items: Item[]; matches: number[]; covered: boolean } {
  const toolIndex = (item: Item) =>
    item.type === 'toolCall' ? history.findIndex(candidate => sameItem(candidate, item)) : -1;
  const matches: number[] = [];
  const commentaryGroups = new Map<number, number[]>();
  const matchedPositions = new Set<number>();
  let previousMatch = -1;
  let unanchoredTool = false;
  for (let index = 0; index < live.length; index += 1) {
    const item = live[index];
    let match = toolIndex(item);
    let nativeCommentary = false;
    if (item.type === 'agentMessage') {
      const owners = new Set(
        item.commentaryItemIds ?? (item.preambleItemId ? [item.preambleItemId] : []),
      );
      let candidates = history.flatMap((candidate, position) =>
        candidate.type === item.type &&
        candidate.display?.sourceSegmentId &&
        owners.has(candidate.display.sourceSegmentId) &&
        itemText(candidate).trim()
          ? [position]
          : [],
      );
      const sources = new Set(candidates.map(position => history[position].display?.sourceId));
      const sourceId = sources.size === 1 ? history[candidates[0]]?.display?.sourceId : undefined;
      // A subscriber can join after the earlier owners were emitted. A native
      // whole-message snapshot also covers those commentary siblings once its
      // current owner has anchored the exact persisted message.
      if (item.commentaryItemIds && sourceId) {
        candidates = history.flatMap((candidate, position) =>
          candidate.type === item.type &&
          candidate.display?.sourceId === sourceId &&
          candidate.display.sourceSegmentId &&
          itemText(candidate).trim()
            ? [position]
            : [],
        );
      }
      const discriminators = new Set(
        candidates.map(position =>
          JSON.stringify([
            history[position].display?.sourceSegmentId,
            history[position].display?.sourceIndex,
          ]),
        ),
      );
      // Only actual native commentary owners can bridge a Tool boundary or
      // join the segment rows behind a whole-message live snapshot.
      if (candidates.length && sources.size === 1 && discriminators.size === candidates.length) {
        match = candidates[candidates.length - 1];
        nativeCommentary = true;
        if (item.commentaryItemIds || candidates.length > 1)
          commentaryGroups.set(index, candidates);
      }
    }
    if (match < 0 && item.type !== 'toolCall' && !unanchoredTool) {
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
    if ((!nativeCommentary && match <= previousMatch) || matchedPositions.has(match)) match = -1;
    // Until this Tool is persisted, following text belongs beyond the known
    // historical boundary, even if it repeats the preceding response exactly.
    if (item.type === 'toolCall') unanchoredTool = match < 0;
    matches.push(match);
    if (match >= 0) {
      previousMatch = Math.max(previousMatch, match);
      matchedPositions.add(match);
    }
  }
  const replacements = new Map<number, Item | null>();
  const insertions = new Map<number, Item[]>();
  let covered = true;
  for (let index = 0; index < live.length; index += 1) {
    const match = matches[index];
    const item = live[index];
    const group = commentaryGroups.get(index);
    const candidate = history[match];
    const historicalText = group
      ? group.map(position => itemText(history[position])).join('\n')
      : candidate
        ? itemText(candidate)
        : '';
    covered &&=
      Boolean(candidate) &&
      (group
        ? historicalText.startsWith(itemText(item))
        : sameItem(candidate, item) &&
          (item.type === 'toolCall'
            ? candidate.status !== 'inProgress' && Boolean(candidate.output || !item.output)
            : historicalText.includes(itemText(item))));
    if (match >= 0) {
      if (group) {
        const prefix = group
          .slice(0, -1)
          .map(position => itemText(history[position]))
          .join('\n');
        const boundary = prefix ? `${prefix}\n` : '';
        // Preserve native segment rows, including rich content. Append only
        // the unpersisted suffix instead of repeating the entire snapshot.
        let merged: Item;
        if (historicalText.startsWith(itemText(item))) {
          merged = candidate;
        } else if (itemText(item).startsWith(boundary)) {
          merged = mergeItem(candidate, { ...item, text: itemText(item).slice(boundary.length) });
        } else {
          // A replacement can revise the earlier paragraphs as well. Keep
          // their media while the current native snapshot owns the whole text.
          for (const position of group.slice(0, -1)) {
            replacements.set(position, withoutItemText(history[position]));
          }
          merged = mergeItem(candidate, item);
        }
        replacements.set(match, merged);
      } else {
        replacements.set(match, mergeItem(candidate, item));
      }
    } else {
      const followingMatch = matches.slice(index + 1).find(value => value >= 0);
      const position = followingMatch ?? history.length;
      insertions.set(position, [...(insertions.get(position) ?? []), item]);
    }
  }
  // Public history can put split commentary before its Thinking sibling even
  // when the live cumulative update followed Thinking. Native anchors retain
  // that order without moving the history cursor backwards and duplicating rows.
  const items = history.flatMap((item, index) => {
    const retained = replacements.has(index) ? replacements.get(index) : item;
    return [...(insertions.get(index) ?? []), ...(retained ? [retained] : [])];
  });
  items.push(...(insertions.get(history.length) ?? []));
  return { items, matches, covered };
}

/** Browser-only projection. Durable history remains owned by Gateway. */
export class ChromeExtensionStream {
  private history: ChromeDisplayView;
  private state = createChatTranscriptState();
  private nextId = 0;
  private agentTextRun: string | null = null;
  private activity: RunActivity | null = null;
  private boundRunId: string | null = null;
  private retryAttempt = 0;
  private pendingRunEvents: ChromeStreamEvent[] | null = null;
  private pendingRunChars = 0;
  private historyOnly = false;
  private anchor: number | null = null;
  private completedRuns = new Set<string>();
  private failedLiveRunId: string | null = null;
  private settled = false;
  private activeInput: OptimisticInput | null = null;
  private readonly optimisticInputs = new Map<string, OptimisticInput>();
  private readonly displayTurnIds = new Map<string, string>();
  private readonly displayItemKeys = new Map<string, string>();
  private readonly dependencies = {
    now: () => Date.now(),
    createId: (prefix: string) => `live-${prefix}-${++this.nextId}`,
  };

  constructor(private readonly threadId: string) {
    this.history = { id: threadId, turns: [] };
  }

  /** Retain only IDs for uniquely identified rows already joined by display reconciliation. */
  private retainDisplayKeys(
    turn: ChromeDisplayView['turns'][number],
  ): ChromeDisplayView['turns'][number] {
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
  bindRun(runId: string, startedAt = Date.now(), retryAttempt = 0): boolean {
    if (
      !runId.trim() ||
      this.completedRuns.has(runId) ||
      !Number.isSafeInteger(retryAttempt) ||
      retryAttempt < this.retryAttempt
    )
      return false;
    const previous = this.boundRunId ?? this.state.activeTurn?.runId;
    if (retryAttempt > this.retryAttempt && previous) {
      if (previous === runId) return false;
      const index = this.anchor;
      const input = this.activeInput;
      const sessionKey = this.state.sessionKey;
      const sessionId = this.state.sessionId ?? this.state.activeTurn?.sessionId ?? null;
      this.finish();
      this.anchor = index;
      this.activeInput = input;
      this.state.sessionKey = sessionKey;
      this.state.sessionId = sessionId;
    }
    if (
      (this.boundRunId !== null && this.boundRunId !== runId) ||
      (this.state.activeTurn && this.state.activeTurn.runId !== runId)
    )
      return false;
    this.boundRunId = runId;
    this.retryAttempt = retryAttempt;
    if (!this.historyOnly) this.activity ??= createRunActivity(runId, startedAt);
    const pending = this.pendingRunEvents;
    this.pendingRunEvents = null;
    this.pendingRunChars = 0;
    for (const value of pending ?? []) {
      if (value.event.runId === runId) this.accept(value);
    }
    return true;
  }

  start(message: string, rawMessage?: Record<string, unknown>, submissionId?: string): void {
    if (
      submissionId &&
      (this.optimisticInputs.has(submissionId) || this.activeInput?.submissionId === submissionId)
    )
      return;
    this.finish();
    this.pendingRunEvents = [];
    this.pendingRunChars = 0;
    const displayId = `pending-${this.nextId++}`;
    const input = {
      submissionId: submissionId ?? displayId,
      displayId,
      inputRunId: submissionId,
      item: {
        type: 'userMessage',
        content: [{ type: 'text', text: message }],
        ...(rawMessage ? { rawMessage } : {}),
      },
      turnIndex: this.history.turns.length,
    };
    this.optimisticInputs.set(input.submissionId, input);
    if (this.optimisticInputs.size > MAX_OPTIMISTIC_INPUTS)
      this.optimisticInputs.delete(this.optimisticInputs.keys().next().value!);
    this.activeInput = input;
    this.anchor = input.turnIndex;
  }

  identifyInput(submissionId: string, runId: string): boolean {
    const input = this.optimisticInputs.get(submissionId);
    if (!input || !runId || input.inputRunId === runId || input.inputRunId !== submissionId)
      return false;
    input.inputRunId = runId;
    this.setHistory(this.history);
    return true;
  }

  setHistory(thread: ChromeDisplayView, authoritative = false): void {
    if (thread.id !== this.threadId) return;
    const active = this.activeInput;
    const activeIndex = active?.inputRunId
      ? thread.turns.findIndex(turn =>
          turn.items.some(item => readInputRunId(item) === active.inputRunId),
        )
      : -1;
    if (active && activeIndex >= 0) {
      this.anchor = activeIndex;
      active.turnIndex = activeIndex;
    } else if (this.anchor !== null && thread.turns.length <= this.anchor) {
      // A read from before admission must not attach live output to an older turn.
      if (!authoritative) return;
      this.anchor = thread.turns.length;
    }
    const pendingByRunId = new Map<string, OptimisticInput>();
    for (const input of this.optimisticInputs.values())
      if (input.inputRunId) pendingByRunId.set(input.inputRunId, input);
    this.history = {
      ...thread,
      turns: thread.turns.map(turn => {
        const user = turn.items.find(item => readInputRunId(item));
        const runId = user && readInputRunId(user);
        if (!runId) return this.retainDisplayKeys(turn);
        const input = pendingByRunId.get(runId);
        if (input) {
          this.displayTurnIds.set(runId, input.displayId);
          if (this.displayTurnIds.size > MAX_DISPLAY_ITEM_KEYS)
            this.displayTurnIds.delete(this.displayTurnIds.keys().next().value!);
          // Native pending rows can disappear while the durable user message is
          // being written. Keep a local fallback until the exact persisted row.
          if (!user.pendingInput) this.optimisticInputs.delete(input.submissionId);
        }
        return this.retainDisplayKeys({
          ...turn,
          id: this.displayTurnIds.get(runId) ?? turn.id,
        });
      }),
    };
    if (this.settled) this.finish(true);
  }

  cancelStart(submissionId = this.activeInput?.submissionId): void {
    if (!submissionId) return;
    this.optimisticInputs.delete(submissionId);
    if (submissionId === this.activeInput?.submissionId) this.finish();
  }

  finishSubmission(submissionId: string, nativeRunId?: string): boolean {
    if (this.activeInput?.submissionId !== submissionId) return false;
    if (nativeRunId && this.pendingRunEvents !== null) this.bindRun(nativeRunId);
    this.finish(true);
    return true;
  }

  private projectOptimisticInputs(turns: ChromeDisplayView['turns']): ChromeDisplayView['turns'] {
    if (!this.optimisticInputs.size) return turns;
    const nativeRunIds = new Set<string>();
    for (const turn of turns)
      for (const item of turn.items) {
        const id = readInputRunId(item);
        if (id) nativeRunIds.add(id);
      }
    const result = turns.slice();
    const inputs = [...this.optimisticInputs.values()].reverse();
    inputs.sort((a, b) => b.turnIndex - a.turnIndex);
    for (const input of inputs) {
      if (input.inputRunId && nativeRunIds.has(input.inputRunId)) continue;
      const slot = Math.min(input.turnIndex, result.length);
      const next = result[slot];
      if (next && !next.items.some(item => item.type === 'userMessage')) {
        result[slot] = { ...next, id: input.displayId, items: [input.item, ...next.items] };
      } else {
        result.splice(slot, 0, { id: input.displayId, items: [input.item] });
      }
    }
    return result;
  }

  /** Close the live process at a confirmed failure of its exact native run. */
  markFailed(nativeRunId?: string): void {
    if (nativeRunId && this.state.activeTurn?.runId === nativeRunId) {
      this.failedLiveRunId = nativeRunId;
      this.activity = null;
    }
  }

  accept(value: ChromeStreamEvent): boolean {
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
    const attempt = value.retryAttempt;
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < this.retryAttempt))
      return false;
    if (attempt !== undefined && attempt > this.retryAttempt) {
      const { sessionKey, sessionId, runId } = value.event;
      const expectedSessionId = this.state.sessionId ?? this.state.activeTurn?.sessionId;
      if (
        !sessionKey ||
        (this.state.sessionKey && sessionKey !== this.state.sessionKey) ||
        (sessionId && expectedSessionId && sessionId !== expectedSessionId) ||
        !runId ||
        !this.bindRun(runId, value.startedAt, attempt)
      )
        return false;
    }
    // Missing deltas cannot be repaired by appending later fragments, even
    // after one history page arrives. Keep this run on authoritative history.
    if (this.historyOnly) return false;
    const prepared = prepareChromeExtensionStreamEvent(value);
    if (!prepared) return false;
    value = prepared;
    const event = value.event;
    if (!event.sessionKey || (event.runId && (
      this.completedRuns.has(event.runId) || event.runId === this.failedLiveRunId
    ))) return false;
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
    this.activity = projectChromeExtensionActivity(
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

  project(): ChromeDisplayView & { activity?: RunActivity } {
    const history = {
      ...this.history,
      ...(this.activity ? { activity: this.activity } : {}),
    };
    const turn = this.state.activeTurn;
    if (!turn?.items.length)
      return { ...history, turns: this.projectOptimisticInputs(history.turns) };
    const turns = history.turns.slice();
    const index = this.anchor ?? Math.max(0, turns.length - 1);
    const historical = turns[index] ?? { id: turn.id, items: [] };
    const failed = this.failedLiveRunId === turn.runId;
    const live = projectLiveItems(turn);
    const { items } = reconcileItems(historical.items, live);
    const liveKeys = failed ? new Set(live.map(item => item.displayKey)) : null;
    turns[index] = this.retainDisplayKeys({
      ...historical,
      items: liveKeys ? items.map(item =>
        liveKeys.has(item.displayKey) && (
          (item.type === 'reasoning' && item.status === 'running') ||
          (item.type === 'toolCall' && item.status === 'inProgress') ||
          (item.type === 'agentMessage' && item.status === 'streaming')
        ) ? { ...item, status: 'interrupted' } : item,
      ) : items,
      processMode: failed ? 'failed' : 'live',
    });
    return { ...history, turns: this.projectOptimisticInputs(turns) };
  }

  finish(preserveUnpersisted = false): void {
    this.pendingRunEvents = null;
    this.pendingRunChars = 0;
    this.historyOnly = false;
    if (this.boundRunId) this.completedRuns.add(this.boundRunId);
    this.activity = null;
    this.boundRunId = null;
    this.retryAttempt = 0;
    if (this.state.activeTurn) {
      this.completedRuns.add(this.state.activeTurn.runId);
    }
    if (this.completedRuns.size > 24)
      this.completedRuns.delete(this.completedRuns.values().next().value!);
    if (preserveUnpersisted && this.state.activeTurn?.items.length) {
      const historical =
        this.history.turns[this.anchor ?? Math.max(0, this.history.turns.length - 1)]?.items ?? [];
      const live = projectLiveItems(this.state.activeTurn, false);
      const { covered } = reconcileItems(historical, live);
      if (!covered) {
        this.settled = true;
        if (this.failedLiveRunId !== this.state.activeTurn.runId) {
          for (const item of this.state.activeTurn.items) {
            if (item.type === 'tool' && item.status === 'running') item.status = 'interrupted';
            if (item.type === 'thinking' && item.status === 'running') item.status = 'interrupted';
            if (item.type === 'content' && item.status === 'streaming') item.status = 'interrupted';
          }
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
        const live = projectLiveItems(this.state.activeTurn, false);
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
    this.failedLiveRunId = null;
    this.activeInput = null;
  }
}
