import type { BrowserExtensionMessageDisplay } from '@shared/browser/browserExtensionDisplay';

import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseQuestionResult,
  parseQuestions,
  type QuestionResult,
} from '../../../../../../plugins/extensions/ask-user-question/contracts/result';
import type { GatewayMessage } from '../../types';
import type { ProcessStatus, ThinkingItem, ToolItem } from '../chat-transcript-state';
import { foldCompletedProcessRows, type ProcessFoldOptions } from '../timeline/completed-process';
import type { SourceTimelineItem } from '../timeline/timeline-avatar-state';
import { prepareVisibleTimelineRows } from '../timeline/timeline-avatar-state';
import { FAILED_RUN_MESSAGE_FLAG } from '../turn/failed-run-message';

export interface BrowserExtensionProcessItem {
  questionResult?: QuestionResult;
  key: string;
  id?: string;
  type: 'thinking' | 'tool';
  title: string;
  name?: string;
  status?: string;
  text?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  progressText?: string;
  rawMessage?: Record<string, unknown>;
  display?: BrowserExtensionMessageDisplay;
}

export type BrowserExtensionAtomicEntry =
  | {
      role: 'user' | 'assistant' | 'system';
      key: string;
      text: string;
      id?: string;
      status?: string;
      rawMessage?: Record<string, unknown>;
      display?: BrowserExtensionMessageDisplay;
      pendingInput?: unknown;
    }
  | {
      role: 'process';
      key: string;
      title: string;
      running: boolean;
      items: BrowserExtensionProcessItem[];
      thinkingCount: number;
      toolCount: number;
      errorCount: number;
      interruptedCount: number;
    }
  | {
      role: 'live-process';
      key: string;
      item: BrowserExtensionProcessItem;
    }
  | {
      role: 'progress-receipt';
      key: string;
      item: BrowserExtensionProcessItem;
    }
  | {
      role: 'question-presentation';
      key: string;
      item: BrowserExtensionProcessItem;
    }
  | {
      role: 'compaction';
      key: string;
      status?: string;
      rawMessage: Record<string, unknown>;
      display?: BrowserExtensionMessageDisplay;
    }
  | { role: 'phase-boundary'; key: string; text: string };

export interface BrowserExtensionCompletedProcessEntry {
  role: 'completed-process';
  key: string;
  items: BrowserExtensionAtomicEntry[];
}

export type BrowserExtensionDisplayEntry =
  BrowserExtensionAtomicEntry | BrowserExtensionCompletedProcessEntry;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isBrowserQuestionTool(item: Record<string, unknown>): boolean {
  if (item.toolName !== ASK_USER_QUESTION_TOOL_NAME) return false;
  if (item.status === 'completed') return item.isError !== true && parseQuestionResult(item.questionResult) !== null;
  return ['running', 'inProgress', 'cancelled', 'interrupted', 'failed'].includes(String(item.status)) && parseQuestions(record(item.input)?.questions) !== null;
}

/** Display categorization only. Unrecognized process states stay outside folded history. */
function processStatus(value: string | undefined): ProcessStatus {
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'cancelled' || value === 'aborted') return 'cancelled';
  if (value === 'interrupted') return 'interrupted';
  return 'running';
}

function asProcessItem(item: BrowserExtensionProcessItem): ThinkingItem | ToolItem {
  const identity = {
    id: item.key,
    // This identifier is local presentation structure, never a native run binding.
    runId: item.key,
    firstSeq: 0,
    lastSeq: 0,
    startedAt: 0,
    updatedAt: 0,
    status:
      item.type === 'thinking' && item.status === undefined
        ? ('completed' as const)
        : processStatus(item.status),
  };
  return item.type === 'thinking'
    ? { ...identity, type: 'thinking', text: item.text ?? '' }
    : {
        ...identity,
        type: 'tool',
        toolCallId: item.id ?? item.key,
        name: item.name ?? item.title,
        input: item.input,
        ...(item.questionResult ? { presentation: { questionResult: item.questionResult } } : {}),
        ...(typeof item.output === 'string' ? { output: item.output } : {}),
      };
}

function historyMessage(
  entry: Extract<
    BrowserExtensionAtomicEntry,
    { role: 'user' | 'assistant' | 'system' | 'compaction' }
  >,
): GatewayMessage {
  const outer = entry.rawMessage ?? {};
  const nested = record(outer.message);
  const source = nested ?? outer;
  const display = entry.display;
  const message: Record<string, unknown> = {
    ...source,
    role: source.role ?? (entry.role === 'compaction' ? 'system' : entry.role),
    content: source.content ?? ('text' in entry ? entry.text : ''),
    ...(display?.nativeFailure === true ? { [FAILED_RUN_MESSAGE_FLAG]: true } : {}),
    ...(display?.stopReason === 'error' || display?.stopReason === 'aborted'
      ? { stopReason: display.stopReason }
      : {}),
  };
  if (entry.role === 'compaction' && display?.kind) {
    message.__openclaw = {
      ...record(source.__openclaw),
      kind: display.kind,
      ...(display.phase ? { phase: display.phase } : {}),
    };
  }
  return (nested ? { ...outer, message } : message) as GatewayMessage;
}

function sourceItem(entry: BrowserExtensionAtomicEntry): SourceTimelineItem {
  if (entry.role === 'process') {
    return {
      kind: 'process-summary',
      key: entry.key,
      runId: entry.key,
      items: entry.items.map(asProcessItem),
      thinkingCount: entry.thinkingCount,
      toolCount: entry.toolCount,
      errorCount: entry.errorCount,
      interruptedCount: entry.interruptedCount,
    };
  }
  if (entry.role === 'live-process' || entry.role === 'progress-receipt' || entry.role === 'question-presentation') {
    const item = asProcessItem(entry.item);
    if (entry.role === 'question-presentation' && item.type === 'tool')
      return { kind: 'question-presentation', key: entry.key, item };
    return entry.role === 'progress-receipt' && item.type === 'tool'
      ? { kind: 'progress-receipt', key: entry.key, item }
      : { kind: 'live-process', key: entry.key, item };
  }
  if (entry.role === 'phase-boundary') {
    return { kind: 'phase-boundary', key: entry.key, label: entry.text };
  }
  if (
    entry.role === 'assistant' &&
    entry.status !== undefined &&
    !entry.rawMessage &&
    !entry.display?.nativeFailure &&
    !entry.display?.stopReason
  ) {
    return {
      kind: 'content',
      key: entry.key,
      item: {
        type: 'content',
        id: entry.key,
        runId: entry.key,
        firstSeq: 0,
        lastSeq: 0,
        startedAt: 0,
        updatedAt: 0,
        status:
          entry.status === 'completed'
            ? 'completed'
            : entry.status === 'interrupted'
              ? 'interrupted'
              : 'streaming',
        sourceMode: 'snapshot',
        text: entry.text,
      },
    };
  }
  return {
    kind: 'history-message',
    key: entry.key,
    message: historyMessage(entry),
    ...('status' in entry &&
    ['running', 'inProgress', 'streaming', 'unknown'].includes(entry.status ?? '')
      ? { runState: 'running' as const }
      : {}),
  };
}

/**
 * Reuse the desktop's fold predicate and user/phase/final-content boundaries.
 * Only source rows are adapted: the returned atomic entries, keys and statuses
 * are unchanged, and this function never creates execution evidence.
 */
export function foldBrowserExtensionEntries(
  entries: readonly BrowserExtensionAtomicEntry[],
  options: ProcessFoldOptions = {},
): BrowserExtensionDisplayEntry[] {
  const sources = entries.map(sourceItem);
  const originals = new Map(sources.map((source, index) => [source, entries[index]]));
  const keepVisibleKeys = new Set(options.keepVisibleKeys);
  if (options.protectTrailingTurn) {
    // The host can retain unsupported assistant delivery as a system fallback.
    // Such a visible row must not make an earlier part of the active user turn
    // eligible for folding when the shared fold flushes an ordinary system row.
    let start = 0;
    entries.forEach((entry, index) => {
      if ((entry.role === 'user' && !entry.pendingInput) || entry.role === 'phase-boundary') {
        start = index;
      }
    });
    for (const entry of entries.slice(start)) keepVisibleKeys.add(entry.key);
  }
  for (const entry of entries) {
    if ('display' in entry && entry.display?.keepVisible) keepVisibleKeys.add(entry.key);
    if ('item' in entry && entry.item.display?.keepVisible) keepVisibleKeys.add(entry.key);
  }
  return foldCompletedProcessRows(prepareVisibleTimelineRows(sources), {
    ...options,
    keepVisibleKeys,
  }).map(row => {
    if (row.item.kind === 'completed-process') {
      return {
        role: 'completed-process',
        key: row.item.key,
        items: row.item.items.map(item => originals.get(item)!),
      };
    }
    return originals.get(row.item)!;
  });
}
