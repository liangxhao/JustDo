import type {
  CompletedProcessTimelineItem,
  SourceTimelineItem,
} from '../../model/timeline/timeline-avatar-state';
import { materializeDisclosureContent } from './disclosure-content';

const AUTO_FOLD_ATTRIBUTE = 'data-process-auto-fold';
const AUTO_FOLD_SIZE = '--process-auto-fold-size';
const AUTO_FOLD_DURATION = '--process-auto-fold-duration';
const AUTO_FOLD_OPACITY = '--process-auto-fold-opacity';
const AUTO_FOLD_TRANSFORM = '--process-auto-fold-transform';
const COLLAPSE_DURATION_MS = 320;
const SOURCE_SELECTOR = [
  '[data-history-key]',
  '[data-process-summary-key]',
  '[data-message-disclosure-owner]',
  '[data-live-process-id]',
  '[data-inline-process-id]',
].join(',');

interface SourceBounds {
  top: number;
  bottom: number;
  visible: boolean;
}

interface PendingFold {
  extent: number;
  element: HTMLDetailsElement | null;
  window: Window;
  frame: number | null;
  deadline: number | null;
  size: number | null;
  opacity: string | null;
  transform: string | null;
  timer: number | null;
  transitionEnd: ((event: Event) => void) | null;
}

interface ProcessGroup {
  sources: ReadonlySet<string>;
  element: HTMLDetailsElement | null;
  expanded: boolean;
  pending: PendingFold | null;
  ref: (element?: Element) => void;
}

function processIdentity(type: string, id: string): string {
  return JSON.stringify(['process', type, id]);
}

function rowIdentity(key: string): string {
  return JSON.stringify(['row', key]);
}

function sourceIdentities(items: readonly SourceTimelineItem[]): Set<string> {
  const identities = new Set<string>();
  for (const item of items) {
    identities.add(rowIdentity(item.key));
    if (item.kind === 'process-summary') {
      for (const process of item.items)
        identities.add(processIdentity(process.type, process.id));
    } else if ('item' in item &&
      (item.item.type === 'thinking' || item.item.type === 'tool')) {
      identities.add(processIdentity(item.item.type, item.item.id));
    }
  }
  return identities;
}

function elementIdentities(element: HTMLElement): string[] {
  const identities: string[] = [];
  const key = element.dataset.historyKey ?? element.dataset.processSummaryKey;
  if (key) identities.push(rowIdentity(key));
  if (element.dataset.processSummaryTail) {
    try {
      const tail: unknown = JSON.parse(element.dataset.processSummaryTail);
      if (Array.isArray(tail) && (tail[0] === 'thinking' || tail[0] === 'tool') &&
        typeof tail[1] === 'string')
        identities.push(processIdentity(tail[0], tail[1]));
    } catch {
      // Only the exact typed native tail can bridge a renamed summary.
    }
  }
  if (element.dataset.messageDisclosureOwner) {
    try {
      const owner: unknown = JSON.parse(element.dataset.messageDisclosureOwner);
      if (Array.isArray(owner) && typeof owner[0] === 'string')
        identities.push(rowIdentity(owner[0]));
    } catch {
      // Unknown presentation markers cannot establish a source identity.
    }
  }
  const processId = element.dataset.liveProcessId ?? element.dataset.inlineProcessId;
  if (processId) {
    const type = element.closest('.chat-group--streaming-thinking, .process-summary__item--thinking')
      ? 'thinking'
      : element.closest('.process-live--tool, .process-summary__item--tool')
        ? 'tool'
        : null;
    if (type) identities.push(processIdentity(type, processId));
  }
  return identities;
}

function insideHiddenDisclosure(element: HTMLElement): boolean {
  let closed = element.closest('details:not([open])');
  while (closed) {
    // A closed details still displays its own summary, including its descendants.
    const summary = closed.firstElementChild;
    if (summary?.tagName !== 'SUMMARY' || !summary.contains(element)) return true;
    closed = closed.parentElement?.closest('details:not([open])') ?? null;
  }
  return false;
}

/** Animates only an already visible flat process becoming a new disclosure. */
export class CompletedProcessMotion {
  private scope: string | null = null;
  private readonly groups = new Map<string, ProcessGroup>();
  private readonly seenGroups = new Set<string>();
  private readonly consumedSources = new Set<string>();
  private sources = new Map<string, SourceBounds>();

  constructor(private readonly host: HTMLElement) {}

  reset(scope: string | null): void {
    if (this.scope === scope) return;
    for (const group of this.groups.values()) this.stop(group, true);
    this.groups.clear();
    this.seenGroups.clear();
    this.consumedSources.clear();
    this.sources.clear();
    this.scope = scope;
  }

  capture(root: ParentNode): void {
    this.sources = new Map();
    if (this.scope === null || !this.host.isConnected) return;
    for (const group of this.groups.values()) {
      if (group.pending) this.measurePending(group.pending);
    }
    const viewport = this.host.getBoundingClientRect();
    for (const element of root.querySelectorAll<HTMLElement>(SOURCE_SELECTOR)) {
      if (element.closest('.completed-process') || insideHiddenDisclosure(element)) continue;
      const row = element.closest<HTMLElement>('.history-viewport-row, .chat-group') ?? element;
      const bounds = row.getBoundingClientRect();
      if (bounds.height <= 0) continue;
      for (const identity of elementIdentities(element))
        this.sources.set(identity, {
          top: bounds.top,
          bottom: bounds.bottom,
          visible: bounds.bottom > viewport.top && bounds.top < viewport.bottom,
        });
    }
  }

  ref(item: CompletedProcessTimelineItem, expanded: boolean): (element?: Element) => void {
    const key = item.key;
    const sources = sourceIdentities(item.items);
    let group = this.groups.get(key);
    if (!group) {
      const registration: ProcessGroup = {
        sources: new Set(),
        element: null,
        expanded,
        pending: null,
        ref: element => {
          if (this.groups.get(key) !== registration) return;
          const next = element?.tagName === 'DETAILS' ? element as HTMLDetailsElement : null;
          if (registration.element === next) return;
          if (registration.pending) {
            this.suspend(registration.pending);
            this.clearTransient(registration.element, true);
            registration.pending.element = null;
          }
          registration.element = next;
        },
      };
      group = registration;
      this.groups.set(key, group);
    }
    group.sources = sources;
    // Native history can change the outer key while retaining the exact sources.
    if (!group.pending && !expanded) {
      for (const previous of this.groups.values()) {
        const pending = previous.pending;
        if (previous === group || !pending ||
          ![...sources].some(source => previous.sources.has(source))) continue;
        if (pending.deadline !== null && pending.deadline <= pending.window.performance.now()) {
          this.stop(previous, true);
          continue;
        }
        this.suspend(pending);
        this.clearTransient(pending.element, true);
        pending.element = null;
        group.pending = pending;
        previous.pending = null;
        break;
      }
    }
    group.expanded = expanded;
    if (expanded) this.stop(group, false);
    return group.ref;
  }

  afterRender(): void {
    for (const [key, group] of this.groups) {
      const details = group.element;
      if (!details?.isConnected) {
        this.stop(group, true);
        this.groups.delete(key);
        continue;
      }
      if (group.expanded || details.open && !group.pending) {
        this.stop(group, false);
        this.remember(key, group);
        continue;
      }
      if (group.pending) {
        this.remember(key, group);
        if (group.pending.element !== details)
          this.stage(group, group.pending.extent, group.pending);
        continue;
      }
      if (this.seenGroups.has(key)) continue;
      const bounds = [...group.sources]
        .filter(identity => !this.consumedSources.has(identity))
        .flatMap(identity => this.sources.get(identity) ?? []);
      this.remember(key, group);
      if (!bounds.some(bound => bound.visible) ||
        details.parentElement?.closest('details:not([open])')) continue;
      const extent = Math.max(...bounds.map(bound => bound.bottom)) -
        Math.min(...bounds.map(bound => bound.top));
      this.stage(group, extent);
    }
    this.sources.clear();
  }

  cancel(details: HTMLDetailsElement): void {
    for (const [key, group] of this.groups) {
      if (group.element !== details) continue;
      this.stop(group, false);
      this.remember(key, group);
      break;
    }
  }

  private remember(key: string, group: ProcessGroup): void {
    this.seenGroups.add(key);
    for (const source of group.sources) this.consumedSources.add(source);
  }

  private stage(group: ProcessGroup, extent: number, retained?: PendingFold): void {
    const details = group.element;
    const ownerWindow = this.host.ownerDocument.defaultView;
    const css = (ownerWindow as (Window & typeof globalThis) | null)?.CSS;
    if (this.scope === null || !details?.isConnected || !this.host.isConnected ||
      !ownerWindow || !css?.supports('interpolate-size', 'allow-keywords') ||
      !css.supports('selector(details::details-content)')) {
      this.stop(group, true);
      return;
    }
    const header = details.firstElementChild?.getBoundingClientRect().height ?? 0;
    const size = retained?.size ?? Math.max(0, extent - header);
    const duration = retained?.deadline === null || retained?.deadline === undefined
      ? COLLAPSE_DURATION_MS
      : Math.max(0, retained.deadline - ownerWindow.performance.now());
    if (size <= 0 || duration <= 0) {
      this.stop(group, true);
      return;
    }
    const pending: PendingFold = {
      extent, element: details, window: ownerWindow, frame: null,
      deadline: retained?.deadline ?? null,
      size: retained?.size ?? null,
      opacity: retained?.opacity ?? null,
      transform: retained?.transform ?? null,
      timer: null,
      transitionEnd: null,
    };
    group.pending = pending;
    details.setAttribute(AUTO_FOLD_ATTRIBUTE, '');
    details.style.setProperty(AUTO_FOLD_SIZE, `${size}px`);
    details.style.setProperty(AUTO_FOLD_DURATION, `${duration}ms`);
    if (pending.opacity) details.style.setProperty(AUTO_FOLD_OPACITY, pending.opacity);
    if (pending.transform) details.style.setProperty(AUTO_FOLD_TRANSFORM, pending.transform);
    details.open = true;
    materializeDisclosureContent(details);
    // Establish the open size before the next frame changes native details state.
    details.getBoundingClientRect();
    pending.frame = ownerWindow.requestAnimationFrame(() => {
      pending.frame = null;
      if (group.pending !== pending) return;
      if (!this.host.isConnected || !details.isConnected || group.element !== details) {
        this.stop(group, true);
        return;
      }
      const now = ownerWindow.performance.now();
      pending.deadline ??= now + COLLAPSE_DURATION_MS;
      const remaining = Math.max(0, pending.deadline - now);
      details.style.setProperty(AUTO_FOLD_DURATION, `${remaining}ms`);
      pending.transitionEnd = event => {
        if (event.target !== details ||
          !['block-size', 'height'].includes((event as TransitionEvent).propertyName)) return;
        if (group.pending === pending) this.stop(group, false);
      };
      details.addEventListener('transitionend', pending.transitionEnd);
      details.open = false;
      this.clearOpeningState(details);
      pending.timer = ownerWindow.setTimeout(() => {
        if (group.pending === pending) this.stop(group, false);
      }, remaining + 80);
    });
  }

  private stop(group: ProcessGroup, close: boolean): void {
    if (!group.pending) return;
    this.suspend(group.pending);
    this.clearTransient(group.pending.element, close);
    group.pending = null;
  }

  private measurePending(pending: PendingFold): void {
    const details = pending.element;
    if (pending.deadline === null || !details?.isConnected) return;
    const header = details.firstElementChild?.getBoundingClientRect().height ?? 0;
    pending.size = Math.max(0, details.getBoundingClientRect().height - header);
    const style = pending.window.getComputedStyle(details, '::details-content');
    pending.opacity = style.opacity;
    pending.transform = style.transform;
  }

  private suspend(pending: PendingFold): void {
    this.measurePending(pending);
    if (pending.frame !== null) pending.window.cancelAnimationFrame(pending.frame);
    pending.frame = null;
    if (pending.timer !== null) pending.window.clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.transitionEnd)
      pending.element?.removeEventListener('transitionend', pending.transitionEnd);
    pending.transitionEnd = null;
  }

  private clearTransient(details: HTMLDetailsElement | null, close: boolean): void {
    if (!details) return;
    if (close) details.open = false;
    this.clearOpeningState(details);
    details.style.removeProperty(AUTO_FOLD_DURATION);
  }

  private clearOpeningState(details: HTMLDetailsElement): void {
    details.removeAttribute(AUTO_FOLD_ATTRIBUTE);
    details.style.removeProperty(AUTO_FOLD_SIZE);
    details.style.removeProperty(AUTO_FOLD_OPACITY);
    details.style.removeProperty(AUTO_FOLD_TRANSFORM);
  }
}
