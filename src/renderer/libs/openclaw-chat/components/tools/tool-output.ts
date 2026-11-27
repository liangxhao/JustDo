import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '@/services/i18n';
import { highlightCode } from '@/shared/editor/code-highlighting';

import { THINKING_PREVIEW_LINES } from '../message/thinking-content';
import { renderTerminalPage, terminalSegments } from './terminal-output';
import type { ToolResultScope } from './tool-result-scope';

export const TOOL_OUTPUT_REQUEST = 'tool-output-request';
export const OUTPUT_PAGE_CHARS = 16_000;
let nextPreviewId = 0;

type SearchBounds = { page: number; start: number; end: number };

type ToolOutputIdentity = { runId: string; toolCallId: string; messageId?: string };

function sameToolOutputIdentity(
  left: ToolOutputIdentity | undefined,
  right: ToolOutputIdentity | undefined,
): boolean {
  return left === right || (
    left !== undefined && right !== undefined &&
    left.runId === right.runId && left.toolCallId === right.toolCallId && left.messageId === right.messageId
  );
}

/** Prefer complete lines while keeping every source character and bounded pages. */
export function outputPageRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + OUTPUT_PAGE_CHARS, text.length);
    if (end < text.length) {
      const midpoint = start + OUTPUT_PAGE_CHARS / 2;
      const newline = text.slice(midpoint, end).lastIndexOf('\n');
      if (newline >= 0) end = midpoint + newline + 1;
      else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      if (text[end - 1] === '\r' && text[end] === '\n') end--;
    }
    ranges.push([start, end]);
    start = end;
  }
  return ranges.length ? ranges : [[0, 0]];
}

function countLineBreaks(text: string, start: number, end: number): number {
  let lines = 0;
  for (let index = start; index < end; index++) {
    const char = text.charCodeAt(index);
    if (char === 10 || (char === 13 && text.charCodeAt(index + 1) !== 10)) lines++;
  }
  return lines;
}

function codeLineNumbers(text: string, start: number, end: number, expanded: boolean): string {
  const firstLine = countLineBreaks(text, 0, start) + 1;
  const endsWithBreak = text[end - 1] === '\n' || text[end - 1] === '\r';
  const lines = Math.max(1, countLineBreaks(text, start, end) + (endsWithBreak ? 0 : 1));
  const count = expanded ? lines : Math.min(lines, THINKING_PREVIEW_LINES);
  return Array.from({ length: count }, (_, index) => firstLine + index).join('\n');
}

export function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function findOutputMatch(text: string, query: string, caseSensitive: boolean, occurrence: number, paginate: boolean) {
  const needle = query.trim();
  if (!needle) return { count: 0 };
  const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  let count = 0;
  let selected: RegExpExecArray | undefined;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text))) {
    if (count === occurrence) selected = match;
    count += 1;
  }
  if (!selected) return { count };
  if (!paginate) return { count, selection: { occurrence } };
  const ranges = outputPageRanges(text);
  const selectedStart = selected.index;
  const page = ranges.findIndex(([start, end]) => start <= selectedStart && selectedStart < end);
  const pageStart = ranges[page][0];
  let start = pageStart;
  let localOccurrence = 0;
  matcher.lastIndex = 0;
  while ((match = matcher.exec(text)) && match.index < selectedStart) {
    if (match.index >= pageStart) localOccurrence += 1;
    else if (match.index + match[0].length > pageStart) start = match.index + match[0].length;
  }
  // Skip overlapping suffixes of consumed matches and include a hit that spans pages.
  return { count, selection: { bounds: { page, start, end: selectedStart + selected[0].length }, occurrence: localOccurrence } };
}

function renderPagination(page: number, pages: number, changePage: (page: number) => void) {
  if (pages <= 1) return nothing;
  return html`<button type="button" ?disabled=${page === 0} @click=${() => changePage(page - 1)}>
    ${i18nService.t('messagePrevious')}
  </button><span>${page + 1} / ${pages}</span><button
    type="button" ?disabled=${page + 1 === pages} @click=${() => changePage(page + 1)}
  >${i18nService.t('messageNext')}</button>`;
}

function renderCopyButton(className: string, label: string, onCopy: () => void) {
  return html`<button class=${className} type="button" title=${label} aria-label=${label} @click=${onCopy}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2"></rect>
      <path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"></path>
    </svg>
  </button>`;
}

export class ToolOutput extends LitElement {
  static properties = {
    text: { attribute: false },
    language: {},
    terminal: { type: Boolean },
    terminalCommand: { attribute: false },
    terminalCommandLanguage: { attribute: false },
    paginate: { attribute: false },
    showEmptyResult: { type: Boolean },
    collapsible: { type: Boolean },
    editorStyle: { attribute: false },
    partial: { type: Boolean },
    identity: {
      attribute: false,
      hasChanged: (next: ToolOutputIdentity | undefined, previous: ToolOutputIdentity | undefined) =>
        !sameToolOutputIdentity(next, previous),
    },
    resultScope: { attribute: false },
    page: { state: true },
    commandFeedback: { state: true },
    feedback: { state: true },
    busy: { state: true },
    previewExpanded: { state: true },
    previewOverflow: { state: true },
  };
  declare text: string;
  declare language: string;
  declare terminal: boolean;
  declare terminalCommand: string | undefined;
  declare terminalCommandLanguage: string;
  declare paginate: boolean;
  declare showEmptyResult: boolean;
  declare collapsible: boolean;
  declare editorStyle: boolean;
  declare partial: boolean;
  declare identity: ToolOutputIdentity | undefined;
  declare resultScope: ToolResultScope | undefined;
  declare private page: number;
  declare private commandFeedback: string;
  declare private feedback: string;
  declare private busy: boolean;
  declare private previewExpanded: boolean;
  declare private previewOverflow: boolean;
  private readonly previewId = `tool-output-preview-${++nextPreviewId}`;
  private preview: HTMLElement | undefined;
  private previewObserver: ResizeObserver | undefined;
  private generation = 0;
  private searchBounds: SearchBounds | null = null;
  private observedResultScope: ToolResultScope | undefined;
  private unsubscribeResult: (() => void) | undefined;
  constructor() {
    super();
    this.text = '';
    this.language = '';
    this.terminal = false;
    this.terminalCommand = undefined;
    this.terminalCommandLanguage = '';
    this.paginate = true;
    this.showEmptyResult = false;
    this.collapsible = false;
    this.editorStyle = false;
    this.partial = false;
    this.page = 0;
    this.commandFeedback = '';
    this.feedback = '';
    this.busy = false;
    this.previewExpanded = false;
    this.previewOverflow = false;
  }
  createRenderRoot() {
    return this;
  }

  get resultText(): string {
    return this.partial ? this.resultScope?.text ?? this.text : this.text;
  }

  private get resultPartial(): boolean {
    return this.partial && this.resultScope?.text === undefined;
  }
  cancelLoad() {
    this.generation++;
    this.busy = false;
  }
  clearSearch(): void {
    if (!this.searchBounds) return;
    this.unwrapSearchMarks();
    this.searchBounds = null;
    this.requestUpdate();
    this.performUpdate();
  }
  private unwrapSearchMarks(): void {
    this.querySelectorAll<HTMLElement>('[data-justdo-search-mark="true"]').forEach(mark => {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent?.normalize();
    });
  }

  /** History navigation can mount the row and reveal its command in one commit. */
  prepareCommandSearch(query: string, caseSensitive: boolean, occurrence: number) {
    this.performUpdate();
    if (this.terminalCommand === undefined) return null;
    const { selection } = findOutputMatch(this.terminalCommand, query, caseSensitive, occurrence, false);
    if (!selection) return null;
    const element = this.querySelector<HTMLElement>('[data-tool-search-source="exec-command"]');
    return element ? { element, occurrence: selection.occurrence } : null;
  }

  async revealSearchPreview(): Promise<void> {
    if (this.collapsible && !this.previewExpanded) {
      this.previewExpanded = true;
      await this.updateComplete;
    }
  }

  /** Select only the source page containing an explicitly requested search hit. */
  prepareSearch(query: string, caseSensitive: boolean, occurrence: number): {
    count: number;
    occurrence: number | null;
  } {
    // A newly materialized reader must first consume its current identity.
    this.performUpdate();
    const text = this.terminal
      ? terminalSegments(this.resultText).map(segment => segment.text).join('')
      : this.resultText;
    const { count, selection } = findOutputMatch(text, query, caseSensitive, occurrence, this.paginate);
    if (!selection?.bounds) return { count, occurrence: selection?.occurrence ?? null };
    this.searchBounds = selection.bounds;
    this.page = selection.bounds.page;
    if (this.collapsible) this.previewExpanded = true;
    this.requestUpdate();
    this.performUpdate();
    return { count, occurrence: selection.occurrence };
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.collapsible || this.resultScope) this.requestUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.generation += 1;
    this.busy = false;
    this.unsubscribeResult?.();
    this.unsubscribeResult = undefined;
    this.observedResultScope = undefined;
    this.stopObservingPreview();
  }

  protected updated(): void {
    if (this.isConnected && this.resultScope !== this.observedResultScope) {
      this.unsubscribeResult?.();
      this.observedResultScope = this.resultScope;
      this.unsubscribeResult = this.resultScope?.subscribe(() => {
        this.unwrapSearchMarks();
        this.searchBounds = null;
        this.feedback = '';
        this.requestUpdate();
      });
    }
    const preview = this.collapsible
      ? this.querySelector<HTMLElement>('.tool-output-preview-text') ?? undefined
      : undefined;
    if (preview !== this.preview) {
      this.stopObservingPreview();
      this.preview = preview;
      const Observer = preview?.ownerDocument.defaultView?.ResizeObserver;
      if (preview && Observer) {
        this.previewObserver = new Observer(this.measurePreview);
        this.previewObserver.observe(preview);
      }
    }
    this.measurePreview();
  }

  private stopObservingPreview(): void {
    this.previewObserver?.disconnect();
    this.previewObserver = undefined;
    this.preview = undefined;
  }

  private readonly measurePreview = (): void => {
    const preview = this.preview;
    const owner = preview?.ownerDocument.defaultView;
    if (!preview || !owner || !preview.getBoundingClientRect().width) return;
    const style = owner.getComputedStyle(preview);
    const lineHeight = Number.parseFloat(style.lineHeight);
    if (!(lineHeight > 0)) return;
    const padding = (Number.parseFloat(style.paddingBlockStart) || 0) +
      (Number.parseFloat(style.paddingBlockEnd) || 0);
    const scrollbarHeight = this.editorStyle ? Math.max(0, preview.offsetHeight - preview.clientHeight) : 0;
    const visibleHeight = lineHeight * THINKING_PREVIEW_LINES + padding - scrollbarHeight;
    this.previewOverflow = preview.scrollHeight > visibleHeight + 1;
  };

  private async copy(source: 'command' | 'result' = 'result') {
    const command = source === 'command';
    const value = command ? this.terminalCommand ?? '' : this.resultText;
    let feedback: string;
    try {
      await (this.ownerDocument.defaultView ?? window).navigator.clipboard.writeText(value);
      feedback = i18nService.t('copied');
    } catch {
      feedback = i18nService.t('messageCopyFailed');
    }
    if (command) this.commandFeedback = feedback;
    else this.feedback = feedback;
  }
  protected willUpdate(changed: PropertyValues) {
    const previous = changed.get('identity') as ToolOutputIdentity | undefined;
    const replaced = Boolean(
      changed.has('identity') &&
      previous &&
      !sameToolOutputIdentity(previous, this.identity),
    );
    const commandChanged = changed.has('terminalCommand') || changed.has('terminalCommandLanguage');
    if (replaced || commandChanged || ['text', 'terminal', 'language', 'page', 'paginate', 'resultScope'].some(key => changed.has(key)))
      this.unwrapSearchMarks();
    if (changed.has('text') || changed.has('terminal') || changed.has('paginate')) this.searchBounds = null;
    if (replaced || commandChanged) this.commandFeedback = '';
    const previousText = changed.get('text');
    if (
      replaced ||
      changed.has('collapsible') ||
      (this.collapsible && typeof previousText === 'string' && !this.text.startsWith(previousText))
    ) {
      this.previewExpanded = false;
      this.previewOverflow = false;
      this.page = 0;
    }
    if (replaced) {
      this.generation++;
      this.busy = false;
      this.searchBounds = null;
      this.feedback = '';
    }
  }
  private recover() {
    if (this.busy || !this.resultPartial || !this.identity?.messageId) return;
    this.busy = true;
    this.feedback = '';
    const generation = ++this.generation;
    const resultScope = this.resultScope;
    this.dispatchEvent(
      new CustomEvent(TOOL_OUTPUT_REQUEST, {
        bubbles: true,
        composed: true,
        detail: {
          ...this.identity,
          isCurrent: () =>
            this.isConnected &&
            this.generation === generation &&
            !this.closest('details:not([open])'),
          complete: (text: string | null) => {
            if (!this.isConnected || this.generation !== generation) return;
            this.busy = false;
            if (this.resultScope !== resultScope || !this.resultPartial || this.closest('details:not([open])'))
              return;
            if (text === null) this.feedback = i18nService.t('messageOutputRetry');
            else if (resultScope) resultScope.complete(text);
            else {
              this.text = text;
              this.language = '';
              this.partial = false;
            }
          },
        },
      }),
    );
  }
  render() {
    const command = this.terminal ? this.terminalCommand : undefined;
    const text = this.resultText;
    const partial = this.resultPartial;
    const emptyResult = this.showEmptyResult && !text && !partial;
    const hasResult = command === undefined || text.length > 0 || partial || emptyResult;
    const copyCommand = Boolean(this.terminalCommandLanguage && command?.length);
    const preview = this.collapsible && !this.terminal;
    const editor = preview && this.editorStyle;
    const segments = this.terminal ? terminalSegments(text) : null;
    const displayText = segments ? segments.map(segment => segment.text).join('') : text;
    const ranges = this.paginate ? outputPageRanges(displayText) : [[0, displayText.length]];
    const pages = ranges.length;
    const page = Math.min(this.page, pages - 1);
    const [pageStart, pageEnd] = ranges[page];
    const start = this.searchBounds?.page === page ? this.searchBounds.start : pageStart;
    const end = this.searchBounds?.page === page ? Math.max(pageEnd, this.searchBounds.end) : pageEnd;
    const disclosureLabel = preview
      ? i18nService.t(this.previewExpanded ? 'thinkingCollapse' : 'thinkingExpand')
      : '';
    return html`<div
        class=${this.terminal
          ? 'tool-output-bubble tool-output-bubble--terminal'
          : preview
            ? `tool-output-bubble tool-output-bubble--preview${editor ? ' tool-output-bubble--editor monokai-code' : ''}`
            : this.language ? 'tool-output-bubble tool-output-bubble--code' : 'tool-output-bubble'}
      >
        ${this.terminal ? html`<div class="tool-output-terminal-chrome" aria-hidden="true"><span></span><span></span><span></span></div>` : nothing}
        ${hasResult && !emptyResult ? renderCopyButton(
          'tool-output-copy', this.feedback || i18nService.t('copy'), () => void this.copy(),
        ) : nothing}
        <span class="tool-output-feedback" role="status">${this.feedback}</span>
        ${command === undefined ? nothing : html`
          <div class="tool-output-terminal-input" ?data-copyable=${copyCommand}>
          ${copyCommand ? html`
            ${renderCopyButton(
              'tool-output-copy tool-output-command-copy',
              this.commandFeedback || `${i18nService.t('copy')} · ${i18nService.t('coworkCodeModeSource')}`,
              () => void this.copy('command'),
            )}
            <span class="tool-output-feedback" role="status">${this.commandFeedback}</span>
          ` : nothing}
          <pre
            class="tool-output-terminal-command"
            data-tool-search-source="exec-command"
            data-tool-search-start="0"
          ><svg
            class="tool-output-terminal-marker"
            viewBox="0 0 16 16"
            aria-hidden="true"
          ><path d="m3 4 4 4-4 4m6 0h4" /></svg><code>${
            this.terminalCommandLanguage && command.length <= OUTPUT_PAGE_CHARS
              ? unsafeHTML(highlightCode(command, this.terminalCommandLanguage))
              : command
          }</code></pre>
          </div>
        `}
        ${hasResult ? html`<pre
          id=${preview ? this.previewId : nothing}
          class=${this.terminal ? 'tool-output-terminal' : preview
            ? `tool-output-preview-text${editor ? ' monokai-code__source' : ''}`
            : ''}
          style=${preview ? `--tool-output-preview-lines: ${THINKING_PREVIEW_LINES}` : nothing}
          data-tool-search-start=${start}
          ?data-tool-search-placeholder=${emptyResult}
          ?data-preview-collapsed=${preview && !this.previewExpanded}
        >${command === undefined ? nothing : html`<svg
          class="tool-output-terminal-marker"
          viewBox="0 0 16 16"
          aria-hidden="true"
        ><path d="M3.5 3.5v4a3 3 0 0 0 3 3H13m-3-3 3 3-3 3" /></svg>`}${editor ? html`<span
          class="tool-output-code-gutter"
          data-line-numbers=${codeLineNumbers(displayText, start, end, this.previewExpanded)}
          aria-hidden="true"
        ></span>` : nothing}${
          emptyResult ? i18nService.t('coworkToolNoOutput')
            : segments ? renderTerminalPage(segments, start, end)
              : this.language ? unsafeHTML(highlightCode(displayText.slice(start, end), this.language))
                : displayText.slice(start, end)
        }</pre>` : nothing}
        ${preview && (this.previewOverflow || pages > 1) ? html`
          <div class="thinking-content__disclosure tool-output-preview-disclosure">
            <button
              type="button"
              class="thinking-content__toggle tool-output-preview-toggle"
              aria-expanded=${String(this.previewExpanded)}
              aria-controls=${this.previewId}
              aria-label=${disclosureLabel}
              title=${disclosureLabel}
              @click=${() => {
                this.previewExpanded = !this.previewExpanded;
                if (!this.previewExpanded) {
                  this.page = 0;
                  this.searchBounds = null;
                }
              }}
            ><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
          </div>
        ` : nothing}
      </div>
      ${
        (pages > 1 || partial) && (!preview || this.previewExpanded)
          ? html`<div class="message-reader-actions">
              ${this.paginate ? html`<button
                type="button"
                ?disabled=${partial}
                @click=${() => downloadText(this.resultText, 'tool-output.txt')}
              >${i18nService.t('messageDownload')}</button>` : nothing}
              ${
                partial
                  ? html`<span>${i18nService.t('messagePartialOutput')}</span>
                      ${this.identity?.messageId ? html`<button type="button" ?disabled=${this.busy} @click=${() => this.recover()}>${i18nService.t('messageFullOutput')}</button>` : nothing}`
                  : nothing
              }
              ${renderPagination(page, pages, nextPage => {
                this.searchBounds = null;
                this.page = nextPage;
              })}
            </div>`
          : nothing
      }`;
  }
}
if (!customElements.get('justdo-tool-output'))
  customElements.define('justdo-tool-output', ToolOutput);
