import { html, LitElement, type PropertyValues } from 'lit';

import { i18nService } from '@/services/i18n';

export const TERMINAL_ERROR_PREVIEW_LINES = 3;
const NATIVE_REJECTION_PREFIX = 'LLM request rejected: ';
let nextTextId = 0;

/** Undo only the native formatter's complete, once-escaped Markdown payload. */
export function formatTerminalErrorText(message: string): string {
  const [firstLine = '', ...remainingLines] = message.trim().split(/\r?\n/);
  let summary = firstLine;
  if (summary.startsWith(NATIVE_REJECTION_PREFIX)) {
    const payload = summary.slice(NATIVE_REJECTION_PREFIX.length);
    const decoded = payload.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    if (decoded.replace(/[!-/:-@[-`{-~]/g, '\\$&') === payload) {
      summary = `${NATIVE_REJECTION_PREFIX}${decoded}`;
    }
  }
  const detail = remainingLines.join('\n').trim();
  if (!detail) return summary;
  return `${summary}${/[:：]$/u.test(summary) ? ' ' : ': '}${detail}`;
}

/** Keep failure disclosure local to the rendered row and its actual text layout. */
export class TerminalErrorMessage extends LitElement {
  static properties = {
    message: { attribute: false },
    expanded: { state: true },
    hasOverflow: { state: true },
  };

  declare message: string;
  declare private expanded: boolean;
  declare private hasOverflow: boolean;
  private readonly textId = `terminal-error-text-${++nextTextId}`;
  private observer?: ResizeObserver;
  private unsubscribeLanguage?: () => void;

  constructor() {
    super();
    this.message = '';
    this.expanded = false;
    this.hasOverflow = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeLanguage = i18nService.subscribe(() => this.requestUpdate());
    this.requestUpdate();
    const owner = this.ownerDocument.defaultView;
    if (owner?.ResizeObserver) {
      this.observer = new owner.ResizeObserver(this.measureOverflow);
      this.observer.observe(this);
    }
    void this.updateComplete.then(this.measureOverflow);
  }

  disconnectedCallback(): void {
    this.unsubscribeLanguage?.();
    this.unsubscribeLanguage = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('message')) {
      this.expanded = false;
      this.hasOverflow = false;
    }
  }

  protected updated(): void {
    this.measureOverflow();
  }

  /** Search scrolls immediately after revealing a match, so remove the clamp now. */
  public revealText(): void {
    this.expanded = true;
    this.performUpdate();
  }

  private readonly measureOverflow = (): void => {
    const text = this.querySelector<HTMLElement>('.process-terminal__error-text');
    const owner = this.ownerDocument.defaultView;
    if (!this.isConnected || !text || !owner || !text.getBoundingClientRect().width) return;
    const lineHeight = Number.parseFloat(owner.getComputedStyle(text).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
    const hasOverflow = text.scrollHeight > lineHeight * TERMINAL_ERROR_PREVIEW_LINES + 1;
    if (this.hasOverflow !== hasOverflow) this.hasOverflow = hasOverflow;
    if (!hasOverflow && this.expanded) this.expanded = false;
  };

  render() {
    return html`
      <div
        id=${this.textId}
        class=${`process-terminal__error-text${this.expanded ? ' is-expanded' : ''}`}
        style=${`--terminal-error-preview-lines: ${TERMINAL_ERROR_PREVIEW_LINES}`}
        .textContent=${formatTerminalErrorText(this.message)}
      ></div>
      <button
        type="button"
        class="process-terminal__details-label"
        ?hidden=${!this.hasOverflow}
        aria-expanded=${this.expanded}
        aria-controls=${this.textId}
        @click=${() => {
          this.expanded = !this.expanded;
        }}
      >
        ${i18nService.t(this.expanded ? 'coworkErrorCollapse' : 'coworkErrorDetails')}
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
        </svg>
      </button>
    `;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('chat-terminal-error')) {
  customElements.define('chat-terminal-error', TerminalErrorMessage);
}
