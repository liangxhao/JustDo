import { html, nothing } from 'lit';
import { AsyncDirective, directive } from 'lit/async-directive.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '@/services/i18n';

import type { ThinkingItem } from '../../model/chat-transcript-state';
import {
  findStableStreamingMarkdownBoundary,
  toSanitizedMarkdownHtml,
} from '../markdown/markdown';

const NATURAL_TEXT_LIMIT = 40_000;
const SECTION_CHARS = 16_000;
const READING_STATE_LIMIT = 1000;
const COPY_FEEDBACK_MS = 1300;
const OPEN_FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)\n/;
const READER_MODE = { LATEST: 'latest', MANUAL: 'manual' } as const;

type SourceRange = { start: number; end: number };
type ReaderState = {
  mode: (typeof READER_MODE)[keyof typeof READER_MODE];
  ranges: SourceRange[];
  start: number;
  end: number;
  sourceLength: number;
  fingerprintFirst: number;
  fingerprintSecond: number;
  seenLength: number;
  natural: boolean;
  frozen: boolean;
  initialized: boolean;
  streaming: boolean;
};

type ThinkingContentContext = {
  requestUpdate: () => void;
  preserve: (element: HTMLElement) => void;
  following: () => boolean;
  latest: (element: HTMLElement, streaming: boolean) => void;
};

export type ThinkingContentRenderer = (item: ThinkingItem) => unknown;

function emptyReaderState(): ReaderState {
  return {
    mode: READER_MODE.LATEST,
    ranges: [],
    start: 0,
    end: 0,
    sourceLength: 0,
    fingerprintFirst: 0x811c9dc5,
    fingerprintSecond: 5381,
    seenLength: 0,
    natural: true,
    frozen: false,
    initialized: false,
    streaming: false,
  };
}

/** Non-authoritative reading metadata; never used to establish native ownership. */
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

function isSourceBoundary(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return true;
  const before = source.charCodeAt(offset - 1);
  const after = source.charCodeAt(offset);
  return !(
    (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) ||
    (before === 13 && after === 10)
  );
}

function alignVisibleRange(state: ReaderState, source: string): void {
  state.start = Math.min(state.start, source.length);
  state.end = Math.min(state.end, source.length);
  // A later delta can complete a pair just beyond an earlier frozen range.
  // Move inward so keeping that range also keeps the visible DOM budget.
  if (!isSourceBoundary(source, state.start)) state.start++;
  if (!isSourceBoundary(source, state.end)) state.end--;
  state.end = Math.max(state.start, state.end);
}

/** Completed boundaries never move when a later native snapshot appends text. */
function sectionRanges(source: string, previous: SourceRange[], append: boolean): SourceRange[] {
  const ranges = append ? previous.slice(0, -1) : [];
  let start = ranges[ranges.length - 1]?.end ?? 0;
  while (source.length - start > SECTION_CHARS) {
    let end = start + SECTION_CHARS;
    const newline = source.lastIndexOf('\n', end - 1);
    if (newline >= start + SECTION_CHARS / 2) end = newline + 1;
    else if (/^[\uD800-\uDBFF]$/.test(source[end - 1])) end--;
    if (source[end - 1] === '\r' && source[end] === '\n') end--;
    ranges.push({ start, end });
    start = end;
  }
  ranges.push({ start, end: source.length });
  return ranges;
}

function showRecent(state: ReaderState, sourceLength: number): void {
  state.natural = false;
  state.start = state.ranges[Math.max(0, state.ranges.length - 2)].start;
  state.end = sourceLength;
  state.seenLength = sourceLength;
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

/** Only local reading metadata survives a process moving between timeline locations. */
export class ThinkingContentPresentation {
  private scope: string | null = null;
  private states = new Map<string, ReaderState>();

  constructor(private readonly context: ThinkingContentContext) {}

  reset(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.states.clear();
  }

  readonly render: ThinkingContentRenderer = item => {
    let state = this.states.get(item.id);
    if (!state) {
      state = emptyReaderState();
      this.states.set(item.id, state);
      if (this.states.size > READING_STATE_LIMIT) this.states.delete(this.states.keys().next().value!);
    }
    return thinkingContent(state, item.text, item.status === 'running', this.context);
  };
}

/** The directive commits inside the parent's render, before chat scroll restoration. */
class ThinkingContentDirective extends AsyncDirective {
  private state: ReaderState | undefined;
  private source: string | undefined;
  private context: ThinkingContentContext | undefined;
  private feedback = '';
  private copyGeneration = 0;
  private feedbackTimer: number | null = null;
  private feedbackWindow: Window | null = null;

  render(
    suppliedState: ReaderState | undefined,
    source: string,
    streaming: boolean,
    context?: ThinkingContentContext,
  ): unknown {
    if (suppliedState && suppliedState !== this.state) {
      this.state = suppliedState;
      this.source = undefined;
      this.clearFeedback();
    }
    this.state ??= emptyReaderState();
    this.context = context;
    const state = this.state;
    const previousSource = this.source;
    let append = previousSource !== undefined && source.startsWith(previousSource);
    const changed = previousSource !== source;
    if (changed && previousSource !== undefined) this.clearFeedback();
    let remountedReplacement = false;
    if (previousSource === undefined && state.initialized) {
      const prefix = sourceFingerprint(source, 0, Math.min(source.length, state.sourceLength));
      append =
        source.length >= state.sourceLength &&
        prefix.first === state.fingerprintFirst &&
        prefix.second === state.fingerprintSecond;
      remountedReplacement = !append;
    }
    const replaced =
      (previousSource !== undefined && changed && !append) ||
      remountedReplacement;
    if (replaced) {
      Object.assign(state, emptyReaderState());
      this.feedback = '';
      this.copyGeneration++;
    }
    if (changed || !state.ranges.length) {
      state.ranges = sectionRanges(source, state.ranges, append && !replaced);
      const fingerprint = sourceFingerprint(
        source,
        append && !replaced ? state.sourceLength : 0,
        source.length,
        append && !replaced ? state.fingerprintFirst : undefined,
        append && !replaced ? state.fingerprintSecond : undefined,
      );
      state.fingerprintFirst = fingerprint.first;
      state.fingerprintSecond = fingerprint.second;
    }
    const following = context?.following() ?? true;
    const justCompleted = state.streaming && !streaming;
    if (!state.initialized) {
      state.mode = streaming ? READER_MODE.LATEST : READER_MODE.MANUAL;
      state.natural = source.length <= NATURAL_TEXT_LIMIT;
      state.start = 0;
      state.end = state.natural ? source.length : state.ranges[0].end;
      state.seenLength = source.length;
      if (!state.natural && streaming) showRecent(state, source.length);
      state.frozen = streaming && !following && !state.natural;
      state.initialized = true;
    } else if (state.mode === READER_MODE.LATEST && streaming && !following) {
      // Natural text can grow below the reader budget without removing earlier lines.
      if (state.natural && source.length <= NATURAL_TEXT_LIMIT && !state.frozen) {
        state.end = source.length;
        state.seenLength = source.length;
      } else state.frozen = true;
    } else if (
      state.mode === READER_MODE.LATEST &&
      following &&
      (streaming || (justCompleted && !state.frozen))
    ) {
      state.frozen = false;
      if (source.length <= NATURAL_TEXT_LIMIT) {
        state.natural = true;
        state.start = 0;
        state.end = source.length;
        state.seenLength = source.length;
      } else showRecent(state, source.length);
    } else if (state.natural && !state.frozen && source.length <= NATURAL_TEXT_LIMIT) {
      state.end = source.length;
      state.seenLength = source.length;
    }
    alignVisibleRange(state, source);
    state.sourceLength = source.length;
    state.streaming = streaming;
    this.source = source;

    const reader = source.length > NATURAL_TEXT_LIMIT || !state.natural;
    const first = Math.max(0, state.ranges.findIndex(range => range.end > state.start));
    const last = Math.max(first, state.ranges.findIndex(range => range.end >= state.end));
    const previous = [...state.ranges].reverse().find(range => range.start < state.start);
    const next = state.ranges.find(range => range.end > state.end);
    const label = i18nService
      .t('thinkingReaderRange')
      .replace('{first}', String(first + 1))
      .replace('{last}', String(last + 1))
      .replace('{total}', String(state.ranges.length));
    const sections = state.ranges
      .filter(range => range.end > state.start && range.start < state.end)
      .map(range => ({ start: Math.max(state.start, range.start), end: Math.min(state.end, range.end) }));

    const toolbar = reader
      ? html`<div class="thinking-content__toolbar" role="group" aria-label=${i18nService.t('thinkingReaderLabel')}>
            <button type="button" data-thinking-action="first" ?disabled=${!state.natural && state.start === 0 && state.end === state.ranges[0].end} @click=${(event: Event) => this.select(state.ranges[0], event)}>${i18nService.t('thinkingReaderFirst')}</button>
            <button type="button" data-thinking-action="previous" ?disabled=${!previous} @click=${(event: Event) => previous && this.select(previous, event)}>${i18nService.t('messagePrevious')}</button>
            <span class="thinking-content__range">${label}</span>
            <button type="button" data-thinking-action="next" ?disabled=${!next} @click=${(event: Event) => next && this.select(next, event)}>${i18nService.t('messageNext')}</button>
            <button type="button" data-thinking-action="latest" @click=${(event: Event) => this.latest(event)}>${i18nService.t(streaming ? 'thinkingReaderLatest' : 'thinkingReaderEnd')}</button>
            <button type="button" data-thinking-action="copy" @click=${(event: Event) => void this.copy(source, event)}>${this.feedback || i18nService.t('thinkingReaderCopyAll')}</button>
            <button type="button" data-thinking-action="download" @click=${(event: Event) => this.download(source, event)}>${i18nService.t('messageDownload')}</button>
          </div>`
      : nothing;

    return html`<div class="thinking-content markdown-content" data-thinking-content>
      ${state.natural ? nothing : toolbar}
      ${!state.natural ? html`<p class="thinking-content__notice">${i18nService.t('thinkingReaderPlainText')}</p>` : nothing}
      <div class="thinking-content__body" data-thinking-body>${state.natural
        ? renderNaturalSource(source.slice(state.start, state.end), streaming)
        : html`<div class="thinking-content__sections">${repeat(
            sections,
            range => range.start,
            range => html`<div class="thinking-content__section" data-thinking-section-start=${range.start}>${source.slice(range.start, range.end)}</div>`,
          )}</div>`}</div>
      ${state.natural
        ? toolbar
        : html`<div class="thinking-content__toolbar thinking-content__toolbar--footer" role="group" aria-label=${i18nService.t('thinkingReaderLabel')}>
            <button type="button" data-thinking-action="previous" ?disabled=${!previous} @click=${(event: Event) => previous && this.select(previous, event)}>${i18nService.t('messagePrevious')}</button>
            <span class="thinking-content__range">${label}</span>
            <button type="button" data-thinking-action="next" ?disabled=${!next} @click=${(event: Event) => next && this.select(next, event)}>${i18nService.t('messageNext')}</button>
            <button type="button" data-thinking-action="latest" @click=${(event: Event) => this.latest(event)}>${i18nService.t(streaming ? 'thinkingReaderLatest' : 'thinkingReaderEnd')}</button>
          </div>`}
      ${reader && source.length > state.seenLength
        ? html`<span class="thinking-content__new-content" role="status">${i18nService.t('thinkingReaderNewContent')}</span>`
        : nothing}
    </div>`;
  }

  private element(event: Event): HTMLElement {
    return (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-thinking-content]')!;
  }

  private refresh(): void {
    if (this.context) this.context.requestUpdate();
    else if (this.state && this.source !== undefined) {
      this.setValue(this.render(this.state, this.source, this.state.streaming));
    }
  }

  private select(range: SourceRange, event: Event): void {
    const state = this.state!;
    this.context?.preserve(this.element(event));
    state.mode = READER_MODE.MANUAL;
    state.natural = false;
    state.frozen = true;
    state.start = range.start;
    state.end = range.end;
    state.seenLength = this.source!.length;
    this.refresh();
  }

  private latest(event: Event): void {
    const state = this.state!;
    state.mode = READER_MODE.LATEST;
    state.frozen = false;
    showRecent(state, this.source!.length);
    this.context?.latest(this.element(event), state.streaming);
    this.refresh();
  }

  private async copy(source: string, event: Event): Promise<void> {
    const element = this.element(event);
    this.clearFeedback();
    const generation = this.copyGeneration;
    try {
      await (element.ownerDocument.defaultView ?? window).navigator.clipboard.writeText(source);
      if (!this.isConnected || generation !== this.copyGeneration) return;
      this.feedback = i18nService.t('copied');
    } catch {
      if (!this.isConnected || generation !== this.copyGeneration) return;
      this.feedback = i18nService.t('messageCopyFailed');
    }
    this.feedbackWindow = element.ownerDocument.defaultView ?? window;
    this.feedbackTimer = this.feedbackWindow.setTimeout(() => {
      this.feedbackTimer = null;
      this.feedback = '';
      this.refresh();
    }, COPY_FEEDBACK_MS);
    this.refresh();
  }

  private clearFeedback(): void {
    if (this.feedbackTimer !== null) this.feedbackWindow?.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
    this.feedbackWindow = null;
    this.feedback = '';
    this.copyGeneration++;
  }

  private download(source: string, event: Event): void {
    const document = this.element(event).ownerDocument;
    const ownerWindow = document.defaultView ?? window;
    const url = ownerWindow.URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'thinking.txt';
    anchor.click();
    ownerWindow.setTimeout(() => ownerWindow.URL.revokeObjectURL(url), 1000);
  }

  protected disconnected(): void {
    this.source = undefined;
    this.clearFeedback();
  }
}

const thinkingContent = directive(ThinkingContentDirective);

/** Standalone render helpers retain their own mounted directive's reading choices. */
export function renderThinkingContent(text: string, streaming: boolean): unknown {
  return thinkingContent(undefined, text, streaming);
}
