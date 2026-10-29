import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

import { questionPresentationResponse } from '../../../../../plugins/extensions/ask-user-question/browser/presentation';
import { parseQuestions } from '../../../../../plugins/extensions/ask-user-question/contracts/result';
import { getCodeModeSource } from '../components/tools/code-mode-presentation';
import { terminalSegments } from '../components/tools/terminal-output';
import type { ThinkingItem, ToolItem } from '../model/chat-transcript-state';
import type { VisibleTimelineItem, VisibleTimelineRow } from '../model/timeline/timeline-avatar-state';
import { buildEditDiffView, parseEditToolDiff } from '../model/tools/edit-tool-diff';
import { fileToolCode, fileToolPatch } from '../model/tools/file-tool-presentation';
import { projectProgressReceipt } from '../model/tools/progress-receipt';
import { toolOperation } from '../model/tools/tool-presentation';
import { normalizeMessage } from '../pipeline/message-normalizer';

export interface HistorySearchMatch {
  path: readonly string[];
  processId?: string;
  editDiff?: true;
  occurrence: number;
  text: string;
  start: number;
  end: number;
}

interface SearchSource {
  path: readonly string[];
  processId?: string;
  editDiff?: true;
  text: string;
}

const markdown = new MarkdownIt({ html: true });
const MARKDOWN_PARSE_LIMIT = 40_000;

function tokenText(tokens: readonly Token[]): string {
  let result = '';
  for (const token of tokens) {
    if (token.type === 'image') continue;
    if (token.children) result += tokenText(token.children);
    // Chat renders raw HTML as escaped source. Its tags, attributes and payload
    // are visible text, unlike HTML admitted through a native preview item.
    else if (['text', 'code_inline', 'code_block', 'fence', 'html_inline', 'html_block'].includes(token.type))
      result += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak' || token.block)
      result += '\n';
  }
  return result;
}

function markdownText(source: string): string {
  // Ordinary rendering falls back to the full escaped source at the same budget.
  if (source.length > MARKDOWN_PARSE_LIMIT) return source;
  return tokenText(markdown.parse(source, {})).trim();
}

function readableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

function processText(process: ThinkingItem | ToolItem): string {
  if (process.type === 'thinking') return markdownText(process.text);
  // Match the ordered reader sources in renderToolDetail. File/code-mode tools
  // display their actual code instead of the full input envelope; raw metadata
  // and native diff editors must not create unreachable reader hits.
  const patch = fileToolPatch(process);
  const input = process.input;
  const hasInput = input !== undefined && input !== null &&
    !(typeof input === 'object' && Object.keys(input).length === 0);
  const inputs = patch.length
    ? patch.map(file => file.text)
    : parseEditToolDiff(process.name, input) || !hasInput
      ? []
      : [getCodeModeSource(process.name, input) ?? fileToolCode(process, false)?.text ?? readableValue(input)];
  const output = fileToolCode(process, true)?.text ?? readableValue(
    process.status === 'running' && process.progressText
      ? process.progressText
      : process.output ?? process.error,
  );
  const displayedOutput = toolOperation(process) === 'commands'
    ? terminalSegments(output).map(segment => segment.text).join('')
    : output;
  return [...inputs, displayedOutput]
    .filter(Boolean)
    .join('\n');
}

function historyMessageText(message: unknown): string {
  return normalizeMessage(message).content
    .flatMap(block => block.type === 'text' ? [markdownText(block.text ?? '')] : [])
    .join('\n');
}

function questionText(tool: ToolItem): string {
  const result = tool.status === 'completed' ? tool.presentation?.questionResult : undefined;
  const questions = result?.questions ?? parseQuestions((tool.input as Record<string, unknown>)?.questions);
  if (!questions) return '';
  const response = questionPresentationResponse(tool.status, result?.response, tool.error ?? tool.output);
  // A waiting card shows only its generated status, not the pending questions.
  if (!response) return '';
  const parts: string[] = [];
  if ((response.status === 'failed' || response.status === 'interrupted') && response.detail)
    parts.push(response.detail);
  for (const question of questions) {
    // The native question view renders these values literally, not as Markdown.
    parts.push(question.question);
    const answer = response.status === 'answered' ? response.answers[question.id] : undefined;
    if (!answer || answer.skipped) continue;
    for (const id of answer.selected) {
      const option = question.options.find(candidate => candidate.id === id);
      if (!option) continue;
      parts.push(option.label);
      const input = answer.optionInputs?.[id];
      if (input) parts.push(`${option.input?.label ?? ''}: ${input}`);
    }
    if (answer.other) parts.push(answer.other);
  }
  return parts.join('\n');
}

/** Search targets from the loaded display projection, independent of mounted DOM. */
export class HistorySearchIndex {
  private rows: readonly VisibleTimelineRow[] | null = null;
  private sources: SearchSource[] = [];
  private query = '';
  private caseSensitive = false;
  private matches: readonly HistorySearchMatch[] = [];

  find(
    rows: readonly VisibleTimelineRow[],
    query: string,
    caseSensitive: boolean,
  ): readonly HistorySearchMatch[] {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      this.query = '';
      this.caseSensitive = caseSensitive;
      this.matches = [];
      return this.matches;
    }
    const changedRows = this.rows !== rows;
    if (changedRows) {
      this.rows = rows;
      this.sources = [];
      for (const row of rows) this.collect(row.item, [row.item.key]);
    }
    if (!changedRows && this.query === normalizedQuery && this.caseSensitive === caseSensitive)
      return this.matches;
    this.query = normalizedQuery;
    this.caseSensitive = caseSensitive;
    const matcher = new RegExp(
      normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      caseSensitive ? 'g' : 'gi',
    );
    const matches: HistorySearchMatch[] = [];
    for (const source of this.sources) {
      matcher.lastIndex = 0;
      let occurrence = 0;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(source.text))) {
        matches.push({
          ...source,
          occurrence: occurrence++,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }
    this.matches = matches;
    return this.matches;
  }

  clear(): void {
    this.rows = null;
    this.sources = [];
    this.query = '';
    this.caseSensitive = false;
    this.matches = [];
  }

  private collect(item: VisibleTimelineItem, path: readonly string[]): void {
    const add = (text: string, processId?: string) => {
      if (text) this.sources.push({ path, ...(processId ? { processId } : {}), text });
    };
    if (item.kind === 'completed-process') {
      for (const child of item.items) this.collect(child, [...path, child.key]);
    } else if (item.kind === 'history-message') {
      add(historyMessageText(item.message));
    } else if (item.kind === 'content') {
      add(historyMessageText({ role: 'assistant', content: item.item.text }));
    } else if (item.kind === 'process-summary') {
      for (const process of item.items) this.collectProcess(process, path);
    } else if (item.kind === 'live-process') {
      this.collectProcess(item.item, path);
    } else if (item.kind === 'question-presentation') {
      add(questionText(item.item), item.item.id);
    } else if (item.kind === 'progress-receipt') {
      const receipt = projectProgressReceipt(item.item);
      if (receipt.key === 'coworkProgressReceiptUpdated') add(receipt.values.current, item.item.id);
    } else if (item.kind === 'terminal') {
      add(item.item.message);
    } else if (item.kind === 'phase-boundary') {
      add(item.label);
    }
  }

  private collectProcess(process: ThinkingItem | ToolItem, path: readonly string[]): void {
    const diff = process.type === 'tool' ? parseEditToolDiff(process.name, process.input) : null;
    if (diff) {
      const text = buildEditDiffView(diff).hunks
        .flatMap(hunk => hunk.lines.filter(line => line.kind !== 'omitted').map(line => line.text))
        .join('\n');
      if (text) this.sources.push({ path, processId: process.id, editDiff: true, text });
    }
    const text = processText(process);
    if (text) this.sources.push({ path, processId: process.id, text });
  }
}
