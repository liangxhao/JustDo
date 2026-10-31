import { html, nothing } from 'lit';
import { AsyncDirective, directive } from 'lit/async-directive.js';
import { ref } from 'lit/directives/ref.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '@/services/i18n';

import type { ThinkingItem } from '../../model/chat-transcript-state';
import {
  findStableStreamingMarkdownBoundary,
  toSanitizedMarkdownHtml,
} from '../markdown/markdown';

export const THINKING_PREVIEW_LINES = 10;
const PREVIEW_STATE_LIMIT = 1000;
const OPEN_FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)\n/;
const REVEAL_THINKING_EVENT = 'thinking-content-reveal';
let nextBodyId = 0;

type PreviewState = {
  expanded: boolean;
  tailPreview: boolean;
  offset: number;
  wasStreaming: boolean;
  sourceLength: number;
  fingerprintFirst: number;
  fingerprintSecond: number;
};

type ThinkingContentContext = {
  requestUpdate: () => void;
  preserve: (element: HTMLElement) => void;
  isFollowing?: () => boolean;
  subscribeScrollMode?: (refresh: () => void) => () => void;
};

export type ThinkingContentRenderer = (item: ThinkingItem) => unknown;

function emptyPreviewState(): PreviewState {
  return {
    expanded: false, tailPreview: false, offset: 0, wasStreaming: false,
    sourceLength: -1, fingerprintFirst: 0x811c9dc5, fingerprintSecond: 5381,
  };
}

/** Non-authoritative display metadata; never used to establish native ownership. */
function sourceFingerprint(
  source: string,
  start: number,
  end: number,
  first = 0x811c9dc5,
  second = 5381,
): { first: number; second: number } {
  for (let index = start; index < end; index++) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = (Math.imul(second, 33) ^ code) >>> 0;
  }
  return { first, second };
}

function renderNaturalSource(source: string, streaming: boolean): unknown {
  const normalized = source.replace(/\r\n?/g, '\n');
  const boundary = streaming ? findStableStreamingMarkdownBoundary(normalized) : normalized.length;
  const stable = normalized.slice(0, boundary);
  const tail = normalized.slice(boundary);
  const fence = OPEN_FENCE_LINE.exec(tail);
  const info = fence?.[2].trim() ?? '';
  const language = info.split(/\s+/)[0] ?? '';
  const ordinaryFence =
    fence &&
    language.toLowerCase() !== 'mermaid' &&
    !(fence[1][0] === '`' && info.includes('`'));

  return html`${unsafeHTML(toSanitizedMarkdownHtml(stable))}${
    !tail
      ? nothing
      : ordinaryFence
        ? html`<div class="code-block-wrapper thinking-content__live-code">
            <div class="code-block-header">
              <span class="code-block-lang">${language || i18nService.t('messageCode')}</span>
              <button
                type="button"
                class="code-block-copy"
                data-code=${tail.slice(fence[0].length)}
                aria-label=${i18nService.t('copyToClipboard')}
              >${i18nService.t('copy')}</button>
            </div>
            <pre><code>${tail.slice(fence[0].length)}</code></pre>
          </div>`
        : html`<div class="markdown-plain-text-fallback thinking-content__tail">${tail}</div>`
  }`;
}

/** Only local display metadata survives a process moving between timeline locations. */
export class ThinkingContentPresentation {
  private scope: string | null = null;
  private states = new Map<string, PreviewState>();
  private readonly previews = new Set<() => void>();
  private readonly previewContext: ThinkingContentContext;
  private following: boolean | undefined;

  constructor(context: ThinkingContentContext) {
    this.previewContext = {
      ...context,
      subscribeScrollMode: refresh => {
        this.previews.add(refresh);
        return () => { this.previews.delete(refresh); };
      },
    };
  }

  syncScrollMode(): void {
    const following = this.previewContext.isFollowing?.() ?? true;
    if (following === this.following) return;
    this.following = following;
    for (const refresh of this.previews) refresh();
  }

  reset(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.states.clear();
  }

  readonly render: ThinkingContentRenderer = item => {
    let state = this.states.get(item.id);
    if (!state) {
      state = emptyPreviewState();
      this.states.set(item.id, state);
      if (this.states.size > PREVIEW_STATE_LIMIT) this.states.delete(this.states.keys().next().value!);
    }
    return thinkingContent(state, item.text, item.status === 'running', this.previewContext);
  };
}

/** The directive commits inside the parent's render, before chat scroll restoration. */
class ThinkingContentDirective extends AsyncDirective {
  private state: PreviewState | undefined;
  private source: string | undefined;
  private streaming = false;
  private context: ThinkingContentContext | undefined;
  private readonly bodyId = `thinking-body-${++nextBodyId}`;
  private content: HTMLElement | undefined;
  private observer: ResizeObserver | undefined;
  private hasOverflow = false;
  private unsubscribeScrollMode: (() => void) | undefined;
  private measurementQueued = false;
  private settleTail = false;

  render(
    suppliedState: PreviewState | undefined,
    source: string,
    streaming: boolean,
    context?: ThinkingContentContext,
  ): unknown {
    if (suppliedState && suppliedState !== this.state) {
      this.state = suppliedState;
      this.source = undefined;
    }
    this.state ??= emptyPreviewState();
    if (this.context !== context) {
      this.unsubscribeScrollMode?.();
      this.unsubscribeScrollMode = context?.subscribeScrollMode?.(this.scheduleMeasurement);
      this.context = context;
    }
    if (this.state.wasStreaming && !streaming && (context?.isFollowing?.() ?? true)) this.settleTail = true;
    this.state.wasStreaming = streaming;
    this.streaming = streaming;
    const state = this.state;
    if (source !== this.source) {
      const prefix = this.source === undefined && state.sourceLength >= 0
        ? sourceFingerprint(source, 0, Math.min(source.length, state.sourceLength))
        : undefined;
      const append = this.source !== undefined
        ? source.startsWith(this.source)
        : source.length >= state.sourceLength &&
          prefix?.first === state.fingerprintFirst && prefix?.second === state.fingerprintSecond;
      if (!append) {
        state.expanded = false;
        state.tailPreview = streaming;
        state.offset = 0;
        this.settleTail = streaming;
      }
      const fingerprint = sourceFingerprint(
        source, append ? state.sourceLength : 0, source.length,
        append ? state.fingerprintFirst : undefined, append ? state.fingerprintSecond : undefined,
      );
      state.sourceLength = source.length;
      state.fingerprintFirst = fingerprint.first;
      state.fingerprintSecond = fingerprint.second;
      this.source = source;
    }

    this.scheduleMeasurement();
    return html`<div class="thinking-content markdown-content" data-thinking-content
      @thinking-content-reveal=${this.reveal}>
      <div class=${`thinking-content__viewport${state.expanded ? ' is-expanded' : ''}`}
        style=${`--thinking-preview-lines: ${THINKING_PREVIEW_LINES}`}
        @focusin=${() => {
          if (!state.expanded && this.hasOverflow) {
            this.context?.preserve(this.content!.closest<HTMLElement>('[data-thinking-content]')!);
            this.reveal();
          }
        }}>
        <div id=${this.bodyId} class="thinking-content__body" data-thinking-body
          ${ref(this.observeContent)}>${renderNaturalSource(source, streaming)}</div>
      </div>
      ${this.hasOverflow || state.expanded ? html`<div class="thinking-content__disclosure">
        <button type="button" class="thinking-content__toggle"
          data-thinking-action="toggle-preview"
          aria-expanded=${state.expanded} aria-controls=${this.bodyId}
          aria-label=${i18nService.t(state.expanded ? 'thinkingCollapse' : 'thinkingExpand')}
          title=${i18nService.t(state.expanded ? 'thinkingCollapse' : 'thinkingExpand')}
          @click=${(event: Event) => {
            const button = event.currentTarget as HTMLElement;
            this.context?.preserve(state.expanded ? button : button.closest<HTMLElement>('[data-thinking-content]')!);
            state.expanded = !state.expanded;
            if (!state.expanded && state.tailPreview) this.settleTail = true;
            this.refresh();
          }}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </button>
      </div>` : nothing}
    </div>`;
  }

  private readonly observeContent = (element: Element | undefined): void => {
    this.observer?.disconnect();
    this.observer = undefined;
    this.content = element as HTMLElement | undefined;
    const owner = this.content?.ownerDocument.defaultView;
    if (!this.content || !owner) return;
    if (owner.ResizeObserver) {
      this.observer = new owner.ResizeObserver(this.measureOverflow);
      this.observer.observe(this.content);
    }
    this.scheduleMeasurement();
  };

  private readonly scheduleMeasurement = (): void => {
    if (this.measurementQueued) return;
    this.measurementQueued = true;
    queueMicrotask(() => {
      this.measurementQueued = false;
      this.measureOverflow();
    });
  };

  private readonly measureOverflow = (): void => {
    const content = this.content;
    const owner = content?.ownerDocument.defaultView;
    if (!this.isConnected || !content || !owner || !content.getBoundingClientRect().width) return;
    const lineHeight = Number.parseFloat(owner.getComputedStyle(content).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
    const hasOverflow = content.scrollHeight > lineHeight * THINKING_PREVIEW_LINES + 1;
    const state = this.state!;
    const viewport = content.parentElement!;
    const maxOffset = Math.max(0, content.scrollHeight - lineHeight * THINKING_PREVIEW_LINES);
    if (state.tailPreview && !state.expanded &&
      (this.settleTail || (this.streaming && (this.context?.isFollowing?.() ?? true)))) {
      state.offset = maxOffset;
    }
    this.settleTail = false;
    state.offset = Math.min(state.offset, maxOffset);
    viewport.scrollTop = state.expanded ? 0 : state.offset;
    viewport.classList.toggle('has-hidden-prefix', !state.expanded && state.offset > 0);
    if (hasOverflow === this.hasOverflow) return;
    this.hasOverflow = hasOverflow;
    this.refresh();
  };

  /** Search needs the complete layout before it scrolls to its existing mark. */
  private readonly reveal = (): void => {
    this.state!.expanded = true;
    this.content?.parentElement?.classList.add('is-expanded');
    if (this.content?.parentElement) {
      this.content.parentElement.scrollTop = 0;
      this.content.parentElement.classList.remove('has-hidden-prefix');
    }
    this.refresh();
  };

  private refresh(): void {
    if (this.context) this.context.requestUpdate();
    else if (this.state && this.source !== undefined) {
      this.setValue(this.render(this.state, this.source, this.streaming));
    }
  }

  protected disconnected(): void {
    this.unsubscribeScrollMode?.();
    this.unsubscribeScrollMode = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.source = undefined;
  }

  protected reconnected(): void {
    this.unsubscribeScrollMode = this.context?.subscribeScrollMode?.(this.scheduleMeasurement);
    this.observeContent(this.content);
  }
}

const thinkingContent = directive(ThinkingContentDirective);

/** Standalone render helpers retain their own mounted directive's expansion choice. */
export function renderThinkingContent(text: string, streaming: boolean): unknown {
  return thinkingContent(undefined, text, streaming);
}

export function revealThinkingContent(element: HTMLElement): void {
  element.closest('[data-thinking-content]')?.dispatchEvent(new Event(REVEAL_THINKING_EVENT));
}
