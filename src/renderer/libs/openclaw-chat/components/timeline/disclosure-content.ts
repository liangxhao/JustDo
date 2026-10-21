import { noChange } from 'lit';
import { AsyncDirective, type ChildPart, directive } from 'lit/async-directive.js';

const MATERIALIZE_DISCLOSURE = 'disclosure-materialize';

/** Closed history does not parse Markdown or build tool editors until requested. */
class DisclosureContentDirective extends AsyncDirective {
  private details: HTMLDetailsElement | null = null;
  private content: (() => unknown) | null = null;

  render(content: () => unknown): unknown {
    return this.details?.open ? content() : noChange;
  }

  update(part: ChildPart, [content]: [() => unknown]): unknown {
    const parent = part.parentNode;
    const details =
      parent.nodeType === 1 ? (parent as Element).closest<HTMLDetailsElement>('details') : null;
    if (details !== this.details) {
      this.disconnected();
      this.details = details;
      if (this.isConnected) this.subscribe();
    }
    this.content = content;
    return this.render(content);
  }

  private readonly materialize = (): void => {
    if (this.isConnected && this.content) this.setValue(this.content());
  };

  private readonly toggle = (): void => {
    if (this.details?.open) this.materialize();
    // Retain mounted content during close so the native height transition and
    // editor/selection state survive. Later closed updates remain deferred.
  };

  private readonly prepareOpen = (event: Event): void => {
    const summary = event.composedPath().find(node => (node as Element).tagName === 'SUMMARY') as
      Element | undefined;
    if (summary?.parentElement === this.details && !this.details?.open) this.materialize();
  };

  private subscribe(): void {
    this.details?.addEventListener('click', this.prepareOpen, true);
    this.details?.addEventListener('toggle', this.toggle);
    this.details?.addEventListener(MATERIALIZE_DISCLOSURE, this.materialize);
  }

  protected disconnected(): void {
    this.details?.removeEventListener('click', this.prepareOpen, true);
    this.details?.removeEventListener('toggle', this.toggle);
    this.details?.removeEventListener(MATERIALIZE_DISCLOSURE, this.materialize);
  }

  protected reconnected(): void {
    this.subscribe();
    if (this.details?.open) this.materialize();
  }
}

export const disclosureContent = directive(DisclosureContentDirective);

/** Search/reveal explicitly request hidden text before walking the local DOM. */
export function materializeDisclosureContents(root: ParentNode): void {
  const visited = new Set<HTMLDetailsElement>();
  for (;;) {
    const pending = [...root.querySelectorAll<HTMLDetailsElement>('details')].filter(
      details => !visited.has(details),
    );
    if (!pending.length) return;
    for (const details of pending) {
      visited.add(details);
      details.dispatchEvent(new Event(MATERIALIZE_DISCLOSURE));
    }
  }
}
