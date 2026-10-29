import { html, noChange, type TemplateResult } from 'lit';
import { AsyncDirective, type ChildPart, directive } from 'lit/async-directive.js';
import { keyed } from 'lit/directives/keyed.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  type HistoryViewportRange,
  HistoryViewportWindow,
} from '../../controllers/history-viewport-window';

export interface HistoryViewportHandle {
  /** Materialize a known presentation row before the chat's explicit navigation. */
  reveal(key: string): boolean;
  offsetFor(key: string): number | null;
  refresh(): void;
}

export interface HistoryViewportOptions<T> {
  items: readonly T[];
  key: (item: T) => string;
  render: (item: T, index: number) => unknown;
  host: HTMLElement;
  scope: string;
  follow?: boolean | (() => boolean);
  rowTag?: 'div' | 'li';
  defer?: () => boolean;
  beforeCommit?: () => void;
  afterCommit?: () => void;
  ref?: (handle: HistoryViewportHandle | null) => void;
}

let viewportId = 0;

interface ViewportInterval {
  start: number;
  end: number;
}

type ViewportEntry =
  | { kind: 'row'; key: string; index: number }
  | { kind: 'spacer'; key: string; edge: 'before' | 'after' | 'gap'; height: number };

/** Retains only layout measurements; message and process data remain with the caller. */
class HistoryViewportDirective extends AsyncDirective implements HistoryViewportHandle {
  private readonly id = `history-viewport-${++viewportId}`;
  private readonly window = new HistoryViewportWindow();
  private options: HistoryViewportOptions<unknown> | null = null;
  private parent: Element | null = null;
  private keys: readonly string[] = [];
  private indices = new Map<string, number>();
  private range: HistoryViewportRange | null = null;
  private ownerWindow: (Window & typeof globalThis) | null = null;
  private observer: ResizeObserver | null = null;
  private observed = new Set<Element>();
  private frame: number | null = null;
  private subscribedHost: HTMLElement | null = null;
  private disclosures = new Set<HTMLDetailsElement>();
  private requestedKey: string | null = null;
  private interactionIntervals: ViewportInterval[] = [];
  private renderedLayout = '';

  render(_options: HistoryViewportOptions<unknown>): unknown {
    return noChange;
  }

  update(part: ChildPart, [options]: [HistoryViewportOptions<unknown>]): unknown {
    const previous = this.options;
    const changedScope = previous?.scope !== options.scope || previous.host !== options.host;
    const readingAnchor = changedScope || this.hasClosedDisclosure() ? null : this.readingAnchor();
    const retainedKey = this.range ? this.keys[this.range.start] : undefined;
    const retainedCount = this.range ? this.range.end - this.range.start : 0;
    if (changedScope) {
      this.unsubscribe();
      previous?.ref?.(null);
      this.requestedKey = null;
      this.range = null;
      this.interactionIntervals = [];
    } else if (previous.ref !== options.ref) {
      previous.ref?.(null);
    }
    this.options = options;
    this.parent = part.parentNode.nodeType === 1 ? (part.parentNode as Element) : null;
    if (changedScope || previous?.items !== options.items) {
      this.keys = options.items.map(options.key);
      this.indices = new Map(this.keys.map((key, index) => [key, index]));
    }
    const changedRows = this.window.setRows(this.keys, options.scope);
    if (this.isConnected) this.subscribe();
    if (changedScope || previous?.ref !== options.ref) options.ref?.(this);
    const retainedStart = retainedKey === undefined ? undefined : this.indices.get(retainedKey);
    const retainedEnd = retainedStart === undefined
      ? 0
      : Math.min(this.keys.length, retainedStart + retainedCount);
    // Explicit materialization may refresh a closed disclosure before a search
    // reveals its target. Its zero layout must not replace existing editors.
    const next = !changedScope && this.hasClosedDisclosure() &&
      retainedStart !== undefined && !this.requestedKey
      ? this.preserveInteractions({
          start: retainedStart,
          end: retainedEnd,
          before: this.window.offsetAt(retainedStart),
          after: this.window.totalHeight - this.window.offsetAt(retainedEnd),
          totalHeight: this.window.totalHeight,
        })
      : this.select(changedRows ? readingAnchor : null);
    const changedRange = this.rangeChanged(next);
    this.range = next;
    if (changedScope || changedRows || changedRange || previous?.items !== options.items)
      this.refresh();
    return this.template(this.range);
  }

  reveal(key: string): boolean {
    const index = this.indices.get(key) ?? -1;
    if (index < 0 || !this.options || !this.isConnected) return false;
    this.requestedKey = key;
    this.commit(this.preserveInteractions(this.window.ensureIndex(index, this.viewportHeight())));
    return true;
  }

  offsetFor(key: string): number | null {
    const index = this.indices.get(key) ?? -1;
    const host = this.options?.host;
    const origin = this.spacer();
    if (index < 0 || !host || !origin) return null;
    return (
      host.scrollTop +
      origin.getBoundingClientRect().top -
      host.getBoundingClientRect().top -
      host.clientTop +
      this.window.offsetAt(index)
    );
  }

  refresh(): void {
    if (!this.isConnected || this.frame !== null || !this.ownerWindow || this.hasClosedDisclosure()) return;
    this.frame = this.ownerWindow.requestAnimationFrame(() => {
      this.frame = null;
      if (!this.isConnected || this.options?.defer?.() || this.hasClosedDisclosure()) return;
      const anchor = this.readingAnchor();
      const changedMeasurements = this.measure();
      const next = this.select(changedMeasurements ? anchor : null);
      if (this.rangeChanged(next)) this.commit(next);
    });
  }

  private commit(range: HistoryViewportRange): void {
    if (!this.isConnected || !this.options) return;
    this.options.beforeCommit?.();
    this.range = range;
    this.setValue(this.template(range));
    const measured = this.measure();
    this.options.afterCommit?.();
    this.observe();
    if (measured) this.refresh();
  }

  private template(range: HistoryViewportRange): TemplateResult {
    const options = this.options!;
    const entries = this.layout(range);
    this.renderedLayout = JSON.stringify(entries);
    return html`${keyed(
      options.scope,
      repeat(
        entries,
        entry => entry.key,
        entry =>
          entry.kind === 'row'
            ? this.renderRow(options.items[entry.index], entry.index)
            : this.renderSpacer(entry.edge, entry.height),
      ),
    )}`;
  }

  private layout(range: HistoryViewportRange): ViewportEntry[] {
    const intervals = [range, ...this.interactionIntervals]
      .filter(interval => interval.end > interval.start)
      .sort((left, right) => left.start - right.start);
    const merged: ViewportInterval[] = [];
    for (const interval of intervals) {
      const previous = merged[merged.length - 1];
      if (previous && interval.start <= previous.end)
        previous.end = Math.max(previous.end, interval.end);
      else merged.push({ start: interval.start, end: interval.end });
    }
    const entries: ViewportEntry[] = [
      {
        kind: 'spacer',
        key: 'before',
        edge: 'before',
        height: this.window.offsetAt(merged[0]?.start ?? 0),
      },
    ];
    for (let position = 0; position < merged.length; position += 1) {
      const interval = merged[position];
      if (position > 0) {
        const previous = merged[position - 1];
        entries.push({
          kind: 'spacer',
          edge: 'gap',
          key: JSON.stringify(['gap', this.keys[previous.end - 1], this.keys[interval.start]]),
          height: this.window.offsetAt(interval.start) - this.window.offsetAt(previous.end),
        });
      }
      for (let index = interval.start; index < interval.end; index += 1) {
        entries.push({ kind: 'row', key: JSON.stringify(['row', this.keys[index]]), index });
      }
    }
    entries.push({
      kind: 'spacer',
      key: 'after',
      edge: 'after',
      height: this.window.totalHeight - this.window.offsetAt(merged[merged.length - 1]?.end ?? 0),
    });
    return entries;
  }

  private renderRow(item: unknown, index: number): TemplateResult {
    const options = this.options!;
    const content = options.render(item, index);
    return options.rowTag === 'li'
      ? html`<li
          class="history-viewport-row"
          data-history-viewport=${this.id}
          data-history-key=${options.key(item)}
          data-history-row-index=${index}
        >
          ${content}
        </li>`
      : html`<div
          class="history-viewport-row"
          data-history-viewport=${this.id}
          data-history-key=${options.key(item)}
          data-history-row-index=${index}
        >
          ${content}
        </div>`;
  }

  private renderSpacer(edge: 'before' | 'after' | 'gap', height: number): TemplateResult {
    return this.options?.rowTag === 'li'
      ? html`<li
          class="history-viewport-spacer"
          data-history-viewport=${this.id}
          data-viewport-edge=${edge}
          role="presentation"
          aria-hidden="true"
          style=${`height:${height}px;list-style:none`}
        ></li>`
      : html`<div
          class="history-viewport-spacer"
          data-history-viewport=${this.id}
          data-viewport-edge=${edge}
          aria-hidden="true"
          style=${`height:${height}px`}
        ></div>`;
  }

  private select(anchor: { key: string; offset: number } | null): HistoryViewportRange {
    const options = this.options!;
    const height = this.viewportHeight();
    if (this.requestedKey) {
      const requestedIndex = this.indices.get(this.requestedKey) ?? -1;
      if (requestedIndex >= 0)
        return this.preserveInteractions(this.window.ensureIndex(requestedIndex, height));
      this.requestedKey = null;
    }
    const following = typeof options.follow === 'function' ? options.follow() : options.follow;
    if (following) return this.preserveInteractions(this.window.select(null, height));
    const anchoredIndex = anchor ? (this.indices.get(anchor.key) ?? -1) : -1;
    if (anchor && anchoredIndex >= 0) {
      return this.preserveInteractions(
        this.window.select(this.window.offsetAt(anchoredIndex) - anchor.offset, height),
      );
    }
    const origin = this.spacer() ?? this.parent;
    const top = origin
      ? options.host.getBoundingClientRect().top +
        options.host.clientTop -
        origin.getBoundingClientRect().top
      : 0;
    return this.preserveInteractions(this.window.select(top, height));
  }

  private preserveInteractions(range: HistoryViewportRange): HistoryViewportRange {
    this.interactionIntervals = [];
    if (!this.range) return range;
    const document = this.options?.host.ownerDocument;
    if (!document) return range;
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const selection = document.getSelection();
    const selected =
      selection && !selection.isCollapsed && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null;
    const selectedIntervals: ViewportInterval[] = [];
    for (const row of this.rows()) {
      const index = this.indices.get(row.dataset.historyKey!) ?? -1;
      if (index < 0) continue;
      if (focused && row.contains(focused))
        this.interactionIntervals.push({ start: index, end: index + 1 });
      if (!selected?.intersectsNode(row)) continue;
      const previous = selectedIntervals[selectedIntervals.length - 1];
      if (previous?.end === index) previous.end = index + 1;
      else selectedIntervals.push({ start: index, end: index + 1 });
    }
    // A native selection can span two mounted regions and their empty spacer.
    // Preserve its actual text without materializing that unselected history gap.
    this.interactionIntervals.push(...selectedIntervals);
    return range;
  }

  private rangeChanged(next: HistoryViewportRange): boolean {
    return (
      !this.range ||
      JSON.stringify(this.layout(next)) !== this.renderedLayout ||
      next.start !== this.range.start ||
      next.end !== this.range.end ||
      Math.abs(next.before - this.range.before) > 0.5 ||
      Math.abs(next.after - this.range.after) > 0.5
    );
  }

  private viewportHeight(): number {
    return this.options?.host.clientHeight || 800;
  }

  private spacer(): HTMLElement | null {
    return (
      this.parent?.querySelector<HTMLElement>(
        `[data-history-viewport="${this.id}"][data-viewport-edge="before"]`,
      ) ?? null
    );
  }

  private rows(): HTMLElement[] {
    if (!this.parent) return [];
    return [
      ...this.parent.querySelectorAll<HTMLElement>(
        `.history-viewport-row[data-history-viewport="${this.id}"]`,
      ),
    ];
  }

  private readingAnchor(): { key: string; offset: number } | null {
    const host = this.options?.host;
    if (!host) return null;
    const viewportTop = host.getBoundingClientRect().top + host.clientTop;
    const row = this.rows().find(element => element.getBoundingClientRect().bottom > viewportTop);
    const key = row?.dataset.historyKey;
    return row && key ? { key, offset: row.getBoundingClientRect().top - viewportTop } : null;
  }

  private measure(): boolean {
    const rows = this.rows();
    const changed = this.window.measure(
      rows.map(row => ({
        key: row.dataset.historyKey!,
        height: row.getBoundingClientRect().height,
      })),
    );
    this.observe(rows);
    return changed;
  }

  private observe(rows = this.rows()): void {
    if (!this.observer) return;
    const next = new Set<Element>([...rows, ...(this.options ? [this.options.host] : [])]);
    for (const element of this.observed) if (!next.has(element)) this.observer.unobserve(element);
    for (const element of next) if (!this.observed.has(element)) this.observer.observe(element);
    this.observed = next;
  }

  private readonly onScroll = (): void => this.refresh();
  private readonly onScrollEnd = (): void => {
    this.requestedKey = null;
    this.refresh();
  };
  private readonly onUserInput = (): void => {
    this.requestedKey = null;
    this.refresh();
  };

  private hasClosedDisclosure(): boolean {
    return [...this.disclosures].some(details => !details.open);
  }

  private syncDisclosures(): void {
    const next = new Set<HTMLDetailsElement>();
    for (let element: Element | null = this.parent; element;) {
      if (element.tagName === 'DETAILS') next.add(element as HTMLDetailsElement);
      const root = element.getRootNode();
      element = element.parentElement ??
        (root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host : null);
    }
    for (const details of this.disclosures)
      if (!next.has(details)) details.removeEventListener('toggle', this.onDisclosureToggle);
    for (const details of next)
      if (!this.disclosures.has(details)) details.addEventListener('toggle', this.onDisclosureToggle);
    this.disclosures = next;
  }

  private readonly onDisclosureToggle = (): void => {
    if (this.hasClosedDisclosure()) {
      if (this.frame !== null) this.ownerWindow?.cancelAnimationFrame(this.frame);
      this.frame = null;
      return;
    }
    this.refresh();
  };

  private subscribe(): void {
    this.syncDisclosures();
    const host = this.options?.host;
    if (!host || this.subscribedHost === host) return;
    this.subscribedHost = host;
    this.ownerWindow = host.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    host.addEventListener('scroll', this.onScroll, { passive: true });
    host.addEventListener('scrollend', this.onScrollEnd, { passive: true });
    host.addEventListener('wheel', this.onUserInput, { passive: true });
    host.addEventListener('keydown', this.onUserInput);
    host.addEventListener('touchstart', this.onUserInput, { passive: true });
    if (this.ownerWindow?.ResizeObserver) {
      this.observer = new this.ownerWindow.ResizeObserver(() => this.refresh());
      this.observe();
    }
  }

  private unsubscribe(): void {
    for (const details of this.disclosures)
      details.removeEventListener('toggle', this.onDisclosureToggle);
    this.disclosures.clear();
    const host = this.subscribedHost;
    host?.removeEventListener('scroll', this.onScroll);
    host?.removeEventListener('scrollend', this.onScrollEnd);
    host?.removeEventListener('wheel', this.onUserInput);
    host?.removeEventListener('keydown', this.onUserInput);
    host?.removeEventListener('touchstart', this.onUserInput);
    this.subscribedHost = null;
    this.observer?.disconnect();
    this.observer = null;
    this.observed.clear();
    if (this.frame !== null) this.ownerWindow?.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.ownerWindow = null;
  }

  protected disconnected(): void {
    this.unsubscribe();
    this.options?.ref?.(null);
  }

  protected reconnected(): void {
    this.subscribe();
    this.options?.ref?.(this);
    this.refresh();
  }
}

const historyViewportDirective = directive(HistoryViewportDirective);

export function historyViewport<T>(options: HistoryViewportOptions<T>) {
  return historyViewportDirective(options as HistoryViewportOptions<unknown>);
}
