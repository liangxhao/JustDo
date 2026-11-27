import {
  readArtifactImageMime,
  readTranscriptImageArtifactId,
  type TranscriptImageArtifact,
} from '@shared/openclaw/artifacts';

import {
  type QuestionResult,
  readQuestionResult,
} from '../../../../../../plugins/extensions/ask-user-question/contracts/result';
import { getTranscriptMedia, type TranscriptMedia } from '../../attachments';
import type { ThinkingItem, ToolItem } from '../chat-transcript-state';
import { isToolResultType, readToolCallId, readToolOutput } from './tool-message-adapter';

export interface ToolPresentation {
  questionResult?: QuestionResult;
  title?: string;
  media?: TranscriptMedia[];
  imageArtifacts?: readonly TranscriptImageArtifact[];
  fileDiff?: string;
  fileRead?: { kind: 'text' | 'truncated' | 'image' | 'not_found'; content?: string };
  parentToolCallId?: string;
  exitCode?: number;
  outcome?: string;
  commandBearing?: boolean;
  hideFromChannelProgress?: boolean;
  suppressChannelProgress?: boolean;
  resultMessageId?: string;
  partial?: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Display-safe projection of native tool/item fields; never changes execution status. */
export function readToolPresentation(source: Record<string, unknown>): ToolPresentation {
  const result = record(source.result);
  const details = record(source.details ?? result.details);
  const marker = record(source.__openclaw);
  const args = record(source.args ?? source.arguments ?? source.input ?? source.toolInput);
  const projection: ToolPresentation = {};
  const questionResult = readQuestionResult(source.result) ?? readQuestionResult(source);
  if (questionResult) projection.questionResult = questionResult;
  if (['text', 'truncated', 'image', 'not_found'].includes(String(details.kind))) {
    projection.fileRead = {
      kind: details.kind as NonNullable<ToolPresentation['fileRead']>['kind'],
      ...(typeof details.content === 'string' ? { content: details.content } : {}),
    };
  }
  if (details.changed !== false && typeof details.diff === 'string')
    projection.fileDiff = details.diff;
  const media = [...getTranscriptMedia(source), ...getTranscriptMedia(result)];
  const content = source.content ?? result.content;
  if (Array.isArray(content)) {
    const images = new Map<string, TranscriptImageArtifact>();
    const messageSeq = typeof marker.seq === 'number' &&
      Number.isSafeInteger(marker.seq) && marker.seq > 0 ? marker.seq : undefined;
    for (const item of content) {
      const part = record(item);
      if (
        ['image', 'audio', 'video'].includes(String(part.type)) &&
        typeof part.data === 'string' &&
        typeof part.mimeType === 'string' &&
        /^(image|audio|video)\/[a-z0-9.+-]+$/i.test(part.mimeType)
      ) {
        media.push({
          path: `data:${part.mimeType};base64,${part.data}`,
          mimeType: part.mimeType,
          kind: String(part.type),
        });
        continue;
      }
      const artifactId = part.type === 'image' ? readTranscriptImageArtifactId(part.artifactId) : undefined;
      if (!artifactId || images.has(artifactId)) continue;
      const imageSource = record(part.source);
      const mimeType = readArtifactImageMime(
        part.mimeType ?? part.media_type ?? imageSource.media_type ?? imageSource.mimeType,
      );
      const label = [part.title, part.fileName, part.alt]
        .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
      images.set(artifactId, {
        id: artifactId,
        ...(messageSeq !== undefined ? { messageSeq } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(label ? { label: label.trim().slice(0, 160) } : {}),
      });
    }
    if (images.size) projection.imageArtifacts = [...images.values()];
  }
  if (media.length)
    projection.media = media.filter(
      (item, index) => media.findIndex(other => other.path === item.path) === index,
    );

  const callId = source.toolCallId ?? source.id;
  const activity = Array.isArray(source.activity)
    ? source.activity.map(record).find(item => item.toolCallId === callId)
    : undefined;
  if (activity) Object.assign(projection, readToolPresentation(activity));
  const title = source.title ?? args.title;
  if (typeof title === 'string' && title.trim()) projection.title = title.trim().slice(0, 240);
  if (typeof source.parentToolCallId === 'string')
    projection.parentToolCallId = source.parentToolCallId;
  const exit =
    source.exitCode ??
    source.exit_code ??
    details.exitCode ??
    details.exit_code ??
    result.exitCode ??
    result.exit_code;
  if (typeof exit === 'number' && Number.isInteger(exit)) projection.exitCode = exit;
  if (source.kind === 'tool' && typeof source.status === 'string')
    projection.outcome = source.status;
  if (details.status === 'skipped') projection.outcome = 'skipped';
  if (details.exitReason === 'manual-cancel') projection.outcome = 'cancelled';
  // Native activity items are complete snapshots. A failed routine operation
  // omits the visibility flag that hid its running/completed predecessors.
  if (typeof source.itemId === 'string' && typeof source.phase === 'string') {
    projection.hideFromChannelProgress = source.hideFromChannelProgress === true;
    projection.suppressChannelProgress = source.suppressChannelProgress === true;
  }
  for (const key of [
    'commandBearing',
    'hideFromChannelProgress',
    'suppressChannelProgress',
  ] as const) {
    if (typeof source[key] === 'boolean') projection[key] = source[key];
  }
  if (typeof marker.id === 'string') projection.resultMessageId = marker.id;
  const outputMetadata = record(marker.toolOutput);
  if (typeof marker.truncated === 'boolean') projection.partial = marker.truncated;
  if (outputMetadata.captureTruncated === true) projection.partial = true;
  if (outputMetadata.outcome === 'unknown') projection.outcome = 'unknown';
  return projection;
}

export const OPERATION_NAMES = {
  commands: ['exec', 'bash', 'shell', 'run_command', 'run_terminal_cmd'],
  reads: ['read', 'read_file', 'readfile', 'notebookread', 'notebook_read'],
  edits: [
    'edit',
    'edit_file',
    'multiedit',
    'multi_edit',
    'apply_patch',
    'applypatch',
    'patch',
    'notebookedit',
    'notebook_edit',
  ],
  writes: ['write', 'write_file', 'create_file'],
  searches: ['grep', 'glob', 'find', 'ls', 'list', 'codebase_search', 'web_search'],
  fetches: ['web_fetch', 'webfetch', 'fetch'],
} as const;
export type ToolOperation = keyof typeof OPERATION_NAMES | 'other';
export function toolOperation(tool: ToolItem): ToolOperation {
  if (tool.presentation?.commandBearing) return 'commands';
  const name = tool.name.toLowerCase();
  return (
    (Object.entries(OPERATION_NAMES).find(([, names]) =>
      (names as readonly string[]).includes(name),
    )?.[0] as ToolOperation) ?? 'other'
  );
}
export function toolOutcome(tool: ToolItem): string {
  const prepared = tool.presentation;
  if (tool.status === 'cancelled' || tool.status === 'interrupted') return tool.status;
  if (prepared?.outcome === 'cancelled') return 'cancelled';
  if (prepared?.exitCode !== undefined && prepared.exitCode !== 0) return 'failed';
  if (
    prepared?.outcome === 'failed' ||
    prepared?.outcome === 'blocked' ||
    prepared?.outcome === 'skipped' ||
    prepared?.outcome === 'unknown'
  )
    return prepared.outcome;
  if (tool.status === 'completed' && tool.output === undefined && tool.error === undefined)
    return 'unknown';
  return tool.status;
}
export function toolTarget(tool: ToolItem): string {
  const input = record(tool.input);
  // Native titles often repeat the tool name and must not hide its arguments.
  // Only select a concrete target; otherwise the timeline previews the full input.
  const preview = (value: string) => {
    const compact = value.trim().replace(/\s+/g, ' ');
    return compact.length <= 160 ? compact : `${compact.slice(0, 159)}…`;
  };
  const name = tool.name.toLowerCase();
  if (name === 'browser') {
    const request = Object.keys(record(input.request)).length ? record(input.request) : input;
    const parts = [
      request.kind ?? input.action,
      request.ref,
      request.text,
      request.url ?? input.targetUrl ?? input.url,
    ];
    const values = parts.filter(
      (value): value is string => typeof value === 'string' && Boolean(value.trim()),
    );
    if (values.length > 1) return preview(values.join(' · '));
  }
  if (name === 'tool_call') {
    const target = input.tool ?? input.name ?? input.toolName;
    const args = input.arguments ?? input.args ?? input.input;
    if (typeof target === 'string' && target !== 'tool_call' && args !== undefined) {
      const nested = toolTarget({ ...tool, name: target, input: args });
      return preview(`${target} · ${nested || JSON.stringify(args)}`);
    }
  }
  const candidates = [
    input.command,
    input.cmd,
    input.path,
    input.file_path,
    input.filePath,
    patchOperations(tool.input)[0]?.path,
    input.query,
    input.pattern,
    input.url,
    input.code,
  ];
  const value = candidates.find(value => typeof value === 'string' && value.trim());
  if (typeof value !== 'string') return '';
  const range = ['read', 'read_file'].includes(name)
    ? ['offset', 'limit'].flatMap(key =>
        typeof input[key] === 'number' ? [`${key} ${input[key]}`] : [],
      )
    : [];
  return preview([value, ...range].join(' · '));
}
export function summarizeTools(tools: readonly ToolItem[]): Record<string, number> {
  const unique = new Map(tools.map(tool => [JSON.stringify([tool.runId, tool.toolCallId]), tool]));
  const counts: Record<string, number> = {};
  for (const tool of unique.values()) {
    if (tool.presentation?.suppressChannelProgress || tool.presentation?.hideFromChannelProgress)
      continue;
    const category = toolOperation(tool);
    counts[category] = (counts[category] ?? 0) + 1;
    const outcome = toolOutcome(tool);
    if (['failed', 'blocked', 'skipped', 'unknown', 'cancelled', 'interrupted'].includes(outcome))
      counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

const MAX_TOOL_NESTING_DEPTH = 32;

/** Keep each tool family together at its root's position within a display segment. */
export function projectProcessNesting<T extends ThinkingItem | ToolItem>(
  items: readonly T[],
): {
  items: readonly T[];
  depths: ReadonlyMap<ToolItem, number>;
  roots: ReadonlyMap<ToolItem, ToolItem>;
} {
  const depths = new Map<ToolItem, number>();
  const roots = new Map<ToolItem, ToolItem>();
  const tools = items.filter((item): item is T & ToolItem => item.type === 'tool');
  if (!tools.some(tool => tool.presentation?.parentToolCallId)) return { items, depths, roots };

  const identities = new Map<string, ToolItem | null>();
  const key = (tool: ToolItem, id = tool.toolCallId) => JSON.stringify([tool.runId, id]);
  for (const tool of tools) {
    if (!tool.runId || !tool.toolCallId) continue;
    const identity = key(tool);
    identities.set(identity, identities.has(identity) ? null : tool);
  }
  const parents = new Map<ToolItem, ToolItem>();
  for (const tool of tools) {
    const parentId = tool.presentation?.parentToolCallId;
    const parent = parentId ? identities.get(key(tool, parentId)) : null;
    if (parent && parent !== tool && identities.get(key(tool)) === tool) parents.set(tool, parent);
  }
  const children = new Map<ToolItem, T[]>();
  for (const tool of tools) {
    const parent = parents.get(tool);
    if (!parent) continue;
    let root = parent;
    let ancestor = parents.get(root);
    let depth = 1;
    while (ancestor && depth < MAX_TOOL_NESTING_DEPTH) {
      root = ancestor;
      ancestor = parents.get(root);
      depth += 1;
    }
    // A path that never reaches a root is cyclic or too deep to display.
    if (ancestor) continue;
    depths.set(tool, depth);
    roots.set(tool, root);
    const siblings = children.get(parent) ?? [];
    siblings.push(tool);
    children.set(parent, siblings);
  }
  if (roots.size === 0) return { items, depths, roots };

  const ordered: T[] = [];
  const append = (item: T) => {
    ordered.push(item);
    if (item.type !== 'tool') return;
    for (const child of children.get(item) ?? []) append(child);
  };
  for (const item of items) {
    if (item.type !== 'tool' || !roots.has(item)) append(item);
  }
  return { items: ordered, depths, roots };
}

/** Select one authorized result, never unrelated text from the containing entry. */
export function resolveFullToolOutput(
  value: unknown,
  identity: { runId: string; toolCallId: string; messageId: string },
): string | null {
  const message = record(value);
  const marker = record(message.__openclaw);
  if (
    marker.truncated === true ||
    record(marker.toolOutput).captureTruncated === true ||
    (marker.id && marker.id !== identity.messageId) ||
    (message.runId && message.runId !== identity.runId) ||
    (marker.runId && marker.runId !== identity.runId)
  )
    return null;
  const candidates = ['tool', 'toolresult', 'tool_result'].includes(
    String(message.role).toLowerCase(),
  )
    ? [message]
    : Array.isArray(message.content)
      ? message.content.map(record).filter(item => isToolResultType(item.type))
      : [];
  const matches = candidates.filter(
    item =>
      readToolCallId(item) === identity.toolCallId &&
      (!item.runId || item.runId === identity.runId),
  );
  if (matches.length !== 1 || readToolPresentation(matches[0]).partial === true) return null;
  return readToolOutput(matches[0]);
}

export function patchOperations(
  input: unknown,
): Array<{ path: string; added: number; removed: number }> {
  const args = record(input);
  const patch = typeof input === 'string' ? input : (args.patch ?? args.input);
  if (typeof patch !== 'string' || patch.length > 120_000 || !patch.startsWith('*** Begin Patch'))
    return [];
  const operations: Array<{ path: string; added: number; removed: number }> = [];
  let current: (typeof operations)[number] | undefined;
  for (const line of patch.split('\n')) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (match) {
      current = { path: match[1], added: 0, removed: 0 };
      operations.push(current);
    } else if (current && line.startsWith('+')) current.added++;
    else if (current && line.startsWith('-')) current.removed++;
  }
  return operations;
}

export function toolSources(
  tool: ToolItem,
): Array<{ title: string; url: string; description: string }> {
  if (
    !['web_search', 'web_fetch'].includes(tool.name.toLowerCase()) ||
    !tool.output ||
    tool.output.length > 500_000
  )
    return [];
  try {
    let response = record(JSON.parse(tool.output));
    const content = Array.isArray(response.content) ? record(response.content[0]).text : undefined;
    if (typeof content === 'string') response = record(JSON.parse(content));
    const sources = response.results ?? response.sources;
    if (!Array.isArray(sources)) return [];
    return sources.slice(0, 30).flatMap(value => {
      const item = record(value);
      if (typeof item.url !== 'string') return [];
      const url = new URL(item.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
      return [
        {
          url: url.href,
          title: typeof item.title === 'string' ? item.title.slice(0, 240) : url.hostname,
          description: typeof item.description === 'string' ? item.description.slice(0, 1000) : '',
        },
      ];
    });
  } catch {
    return [];
  }
}
