import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

import { questionPresentationResponse } from '../../../../../plugins/extensions/ask-user-question/browser/presentation';
import { parseQuestions } from '../../../../../plugins/extensions/ask-user-question/contracts/result';
import { isRawOnlyTerminalMatch, terminalSegments, terminalSourceOmissions } from '../components/tools/terminal-output';
import {
  projectToolInlinePreview,
  toolEditInputBodyRanges,
  type ToolInputMirrorRange,
  toolInputMirrorRange,
  toolInputText,
  toolResultText,
} from '../components/tools/tool-inline-preview';
import type { ThinkingItem, ToolItem } from '../model/chat-transcript-state';
import type { VisibleTimelineItem, VisibleTimelineRow } from '../model/timeline/timeline-avatar-state';
import { buildEditDiffView } from '../model/tools/edit-tool-diff';
import { fileToolCode, fileToolPatch } from '../model/tools/file-tool-presentation';
import { projectProgressReceipt } from '../model/tools/progress-receipt';
import { projectProcessNesting, toolOperation } from '../model/tools/tool-presentation';
import { normalizeMessage } from '../pipeline/message-normalizer';

export interface HistorySearchMatch {
  path: readonly string[];
  processId?: string;
  editDiff?: true;
  toolSource?: ToolSearchSource;
  occurrence: number;
  text: string;
  start: number;
  end: number;
}

type ToolSearchSource = 'edit-path' | 'exec-command' | 'exec-result' | 'write' | 'raw-input' | 'raw-result';

interface SearchSource {
  path: readonly string[];
  processId?: string;
  editDiff?: true;
  toolSource?: ToolSearchSource;
  mirror?: { text: string; range: ToolInputMirrorRange };
  ignored?: readonly ToolInputMirrorRange[];
  terminalOmissions?: ReturnType<typeof terminalSourceOmissions>;
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

function terminalText(text: string): string {
  return terminalSegments(text).map(segment => segment.text).join('');
}

function standardToolText(process: ToolItem): string {
  // Ordinary tools use the readers in the detail body in display order.
  const patch = fileToolPatch(process);
  const inputs = patch.length
    ? patch.map(file => file.text)
    : [toolInputText(process.input)];
  const output = fileToolCode(process, true)?.text ?? toolResultText(process) ?? '';
  const displayedOutput = toolOperation(process) === 'commands'
    ? terminalText(output)
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
    for (const { mirror, ignored, terminalOmissions, ...source } of this.sources) {
      matcher.lastIndex = 0;
      const ignoredRange = mirror && matcher.test(mirror.text) ? mirror.range : undefined;
      matcher.lastIndex = 0;
      let occurrence = 0;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(source.text))) {
        const start = match.index;
        const end = start + match[0].length;
        // Keep the reader's absolute occurrence index even for skipped mirrors.
        const position = occurrence++;
        if (ignoredRange && start >= ignoredRange.start && end <= ignoredRange.end) continue;
        if (ignored?.some(range => start < range.end && end > range.start)) continue;
        if (terminalOmissions && !isRawOnlyTerminalMatch(terminalOmissions, start, end)) continue;
        matches.push({
          ...source,
          occurrence: position,
          start,
          end,
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
      for (const process of projectProcessNesting(item.items).items) this.collectProcess(process, path);
    } else if (item.kind === 'live-process') {
      this.collectProcess(item.item, path);
    } else if (item.kind === 'question-presentation') {
      add(questionText(item.item), item.item.id);
    } else if (item.kind === 'progress-receipt') {
      const receipt = projectProgressReceipt(item.item);
      if (receipt?.key === 'coworkProgressReceiptUpdated') add(receipt.values.current);
      this.collectProcess(item.item, path);
    } else if (item.kind === 'terminal') {
      add(item.item.message);
    } else if (item.kind === 'phase-boundary') {
      add(item.label);
    }
  }

  private collectProcess(process: ThinkingItem | ToolItem, path: readonly string[]): void {
    const add = (
      text?: string | null,
      toolSource?: ToolSearchSource,
      mirror?: SearchSource['mirror'],
      ignored?: SearchSource['ignored'],
    ) => {
      if (text) this.sources.push({ path, processId: process.id, text, toolSource, mirror, ignored });
    };
    if (process.type === 'thinking') {
      add(markdownText(process.text));
      return;
    }

    const preview = projectToolInlinePreview(process);
    if (!preview) {
      add(standardToolText(process));
      return;
    }

    const rawResult = process.output ?? process.error;
    const input = toolInputText(process.input);
    const displayedInput = preview.kind === 'edit' ? preview.diff.path
      : preview.kind === 'exec' ? preview.command : preview.text;
    const range = input && preview.rawInputPath ? toolInputMirrorRange(input, preview.rawInputPath) : undefined;
    const mirror = displayedInput && range ? { text: displayedInput, range } : undefined;
    if (preview.kind === 'edit') {
      add(displayedInput, 'edit-path');
      const text = buildEditDiffView(preview.diff).hunks
        .flatMap(hunk => hunk.lines.filter(line => line.kind !== 'omitted').map(line => line.text))
        .join('\n');
      if (text) this.sources.push({ path, processId: process.id, editDiff: true, text });
      add(input, 'raw-input', mirror, input ? toolEditInputBodyRanges(input, preview.rawInputRoot) : undefined);
      add(rawResult, 'raw-result');
    } else {
      add(displayedInput, preview.kind === 'exec' ? 'exec-command' : 'write');
      const result = preview.kind === 'exec' ? toolResultText(process) : undefined;
      if (result) add(terminalText(result), 'exec-result');
      add(input, 'raw-input', mirror);
      if (preview.kind === 'write' || rawResult !== result) {
        add(rawResult, 'raw-result');
      } else if (rawResult) {
        const terminalOmissions = terminalSourceOmissions(rawResult);
        if (terminalOmissions.length) {
          this.sources.push({
            path, processId: process.id, toolSource: 'raw-result', text: rawResult, terminalOmissions,
          });
        }
      }
    }
  }
}
