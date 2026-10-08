import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '@/services/i18n';

import { highlightCode } from './markdown';
import { renderTerminalPage, terminalSegments } from './terminal-output';

export const TOOL_OUTPUT_REQUEST = 'tool-output-request';
export const OUTPUT_PAGE_CHARS = 16_000;
/** Prefer complete lines while keeping every source character and bounded pages. */
export function outputPageRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + OUTPUT_PAGE_CHARS, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start + OUTPUT_PAGE_CHARS / 2) end = newline + 1;
      else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      if (text[end - 1] === '\r' && text[end] === '\n') end--;
    }
    ranges.push([start, end]);
    start = end;
  }
  return ranges.length ? ranges : [[0, 0]];
}

export function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Bounded text reader: the canonical string stays out of the DOM. */
export class ToolOutput extends LitElement {
  static properties = {
    text: { attribute: false },
    language: {},
    terminal: { type: Boolean },
    partial: { type: Boolean },
    identity: { attribute: false },
    page: { state: true },
    feedback: { state: true },
    busy: { state: true },
  };
  declare text: string;
  declare language: string;
  declare terminal: boolean;
  declare partial: boolean;
  declare identity: { runId: string; toolCallId: string; messageId?: string } | undefined;
  declare private page: number;
  declare private feedback: string;
  declare private busy: boolean;
  private generation = 0;
  constructor() {
    super();
    this.text = '';
    this.language = '';
    this.terminal = false;
    this.partial = false;
    this.page = 0;
    this.feedback = '';
    this.busy = false;
  }
  createRenderRoot() {
    return this;
  }
  cancelLoad() {
    this.generation++;
    this.busy = false;
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.generation += 1;
    this.busy = false;
  }
  private async copy() {
    try {
      await (this.ownerDocument.defaultView ?? window).navigator.clipboard.writeText(this.text);
      this.feedback = i18nService.t('copied');
    } catch {
      this.feedback = i18nService.t('messageCopyFailed');
    }
  }
  protected willUpdate(changed: PropertyValues) {
    const previous = changed.get('identity') as typeof this.identity;
    if (
      changed.has('identity') &&
      previous &&
      JSON.stringify(previous) !== JSON.stringify(this.identity)
    ) {
      this.generation++;
      this.busy = false;
      this.page = 0;
      this.feedback = '';
    }
  }
  private recover() {
    if (this.busy || !this.identity?.messageId) return;
    this.busy = true;
    this.feedback = '';
    const generation = ++this.generation;
    this.dispatchEvent(
      new CustomEvent(TOOL_OUTPUT_REQUEST, {
        bubbles: true,
        composed: true,
        detail: {
          ...this.identity,
          isCurrent: () =>
            this.isConnected &&
            this.generation === generation &&
            (this.closest('details')?.open ?? true),
          complete: (text: string | null) => {
            if (!this.isConnected || this.generation !== generation) return;
            if (this.closest('details')?.open === false) {
              this.busy = false;
              return;
            }
            this.busy = false;
            if (text === null) this.feedback = i18nService.t('messageOutputRetry');
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
    const segments = this.terminal ? terminalSegments(this.text) : null;
    const displayText = segments ? segments.map(segment => segment.text).join('') : this.text;
    const ranges = outputPageRanges(displayText);
    const pages = ranges.length;
    const page = Math.min(this.page, pages - 1);
    return html`<div
        class=${this.terminal ? 'tool-output-bubble tool-output-bubble--terminal' : this.language ? 'tool-output-bubble tool-output-bubble--code' : 'tool-output-bubble'}
      >
        ${this.terminal ? html`<div class="tool-output-terminal-chrome" aria-hidden="true"><span></span><span></span><span></span></div>` : nothing}
        <button
          class="tool-output-copy"
          type="button"
          title=${this.feedback || i18nService.t('copy')}
          aria-label=${this.feedback || i18nService.t('copy')}
          @click=${() => void this.copy()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="11" height="11" rx="2"></rect>
            <path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"></path>
          </svg>
        </button>
        <span class="tool-output-feedback" role="status">${this.feedback}</span>
        <pre class=${this.terminal ? 'tool-output-terminal' : ''}>
${segments ? renderTerminalPage(segments, ...ranges[page]) : this.language ? unsafeHTML(highlightCode(displayText.slice(...ranges[page]), this.language)) : displayText.slice(...ranges[page])}</pre>
      </div>
      ${
        pages > 1 || this.partial
          ? html`<div class="message-reader-actions">
              ${
                pages > 1 || this.partial
                  ? html`<button
                      type="button"
                      ?disabled=${this.partial}
                      @click=${() => downloadText(this.text, 'tool-output.txt')}
                    >
                      ${i18nService.t('messageDownload')}
                    </button>`
                  : nothing
              }
              ${
                this.partial
                  ? html`<span>${i18nService.t('messagePartialOutput')}</span>
                      ${this.identity?.messageId ? html`<button type="button" ?disabled=${this.busy} @click=${() => this.recover()}>${i18nService.t('messageFullOutput')}</button>` : nothing}`
                  : nothing
              }
              ${
                pages > 1
                  ? html`<button
                        type="button"
                        ?disabled=${page === 0}
                        @click=${() => (this.page = page - 1)}
                      >
                        ${i18nService.t('messagePrevious')}
                      </button>
                      <span>${page + 1} / ${pages}</span
                      ><button
                        type="button"
                        ?disabled=${page + 1 === pages}
                        @click=${() => (this.page = page + 1)}
                      >
                        ${i18nService.t('messageNext')}
                      </button>`
                  : nothing
              }
            </div>`
          : nothing
      }`;
  }
}
if (!customElements.get('justdo-tool-output'))
  customElements.define('justdo-tool-output', ToolOutput);
