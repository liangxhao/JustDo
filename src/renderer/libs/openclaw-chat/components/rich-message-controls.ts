import type { MessageQuoteHandler } from '@/features/cowork/components/composer/messageQuote';
import { i18nService } from '@/services/i18n';

import { type JsonSourceNode, parseJsonSource, tableToTsv } from './json-source-tree';
import { downloadText, type ToolOutput } from './tool-output';

type Preference = { wrap?: boolean; expanded?: boolean; tree?: boolean };
export class RichMessageControls {
  private preferences = new Map<string, Preference>();
  onQuote: MessageQuoteHandler | undefined;
  private selectionBar: HTMLElement | null = null;
  private scope = '';
  private toolOpen = new Set<string>();
  rememberTool(details: HTMLDetailsElement) {
    const key = details.dataset.toolIdentity;
    if (key) {
      if (details.open) this.toolOpen.add(key);
      else this.toolOpen.delete(key);
    }
  }
  private dialog: HTMLDialogElement | null = null;
  private dialogTrigger: HTMLElement | null = null;
  constructor(
    private root: ShadowRoot | HTMLElement,
    private preserve: (element: HTMLElement) => void,
  ) {
    this.root.addEventListener('contextmenu', this.selectQuote);
    this.root.addEventListener('pointerdown', this.preserveContextSelection);
    document.addEventListener('pointerdown', this.dismissSelection, true);
    document.addEventListener('keydown', this.selectionKey, true);
    document.addEventListener('scroll', this.dismissSelection, true);
  }
  dispose() {
    this.close();
    this.dismissSelection();
    this.root.removeEventListener('contextmenu', this.selectQuote);
    this.root.removeEventListener('pointerdown', this.preserveContextSelection);
    document.removeEventListener('pointerdown', this.dismissSelection, true);
    document.removeEventListener('keydown', this.selectionKey, true);
    document.removeEventListener('scroll', this.dismissSelection, true);
  }
  private selectedRange(): Range | null {
    const selection =
      (this.root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ??
      window.getSelection();
    if (!selection || selection.isCollapsed) return null;
    // Chromium can re-scope getRangeAt() to the custom-element host.
    const composed = selection as Selection & {
      getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
    };
    if (this.root instanceof ShadowRoot && composed.getComposedRanges) {
      const selected = composed.getComposedRanges({ shadowRoots: [this.root] })[0];
      if (selected) {
        const range = document.createRange();
        range.setStart(selected.startContainer, selected.startOffset);
        range.setEnd(selected.endContainer, selected.endOffset);
        return range;
      }
    }
    return selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  }
  private readonly preserveContextSelection = (event: Event) => {
    if ((event as PointerEvent).button !== 2) return;
    const range = this.selectedRange();
    if (range && this.root.contains(range.commonAncestorContainer)) event.preventDefault();
  };
  private readonly selectQuote = (event: Event) => {
    if ((event.target as Element)?.closest?.('.message-selection-actions')) return;
    this.selectionBar?.remove();
    this.selectionBar = null;
    if (!this.scope) return;
    const selectionRange = this.selectedRange();
    if (!selectionRange) return;
    // Selection endpoints can be in the parent after the final paragraph, even
    // when the selected text belongs entirely to one historical message.
    const candidates = Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-assistant-entry], [data-quote-source]'),
    ).flatMap(source => {
      if (!selectionRange.intersectsNode(source)) return [];
      const bounds = document.createRange();
      bounds.selectNodeContents(source);
      const range = selectionRange.cloneRange();
      if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0)
        range.setStart(bounds.startContainer, bounds.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0)
        range.setEnd(bounds.endContainer, bounds.endOffset);
      return range.toString().trim() ? [{ source, range }] : [];
    });
    if (candidates.length !== 1) return;
    const { source, range } = candidates[0];
    const body = source;
    const selectedText = range.toString();
    const text = selectedText.slice(0, 12_000);
    if (!text.trim()) return;
    const before = document.createRange();
    before.selectNodeContents(source);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const quote = {
      id: crypto.randomUUID(),
      sessionKey: this.scope,
      entryId: source.dataset.assistantEntry ?? '',
      text,
      start,
      end: start + text.length,
    };
    const bar = document.createElement('div');
    bar.className = 'message-selection-actions';
    bar.setAttribute('role', 'menu');
    bar.addEventListener('pointerdown', event => event.preventDefault());
    event.preventDefault();
    event.stopPropagation();
    const copy = this.button('copy', () => {
      void navigator.clipboard
        .writeText(selectedText)
        .then(() => {
          if (this.selectionBar === bar) this.dismissSelection();
        })
        .catch(() => {
          copy.textContent = i18nService.t('messageCopyFailed');
        });
    });
    bar.append(copy);
    if (this.onQuote)
      for (const target of ['composer', 'side-chat'] as const)
        bar.append(
          this.button(
            target === 'composer' ? 'messageQuoteComposer' : 'messageQuoteSideChat',
            () => {
              this.onQuote?.(quote, target);
              this.dismissSelection();
            },
          ),
        );
    const iconPaths = [
      'M9 9h11v11H9z M15 9V4H4v11h5',
      'M12 5v14 M5 12h14',
      'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 0 1 10.5 4H13 M17 3h5v5 M22 3l-8 8',
    ];
    bar.querySelectorAll('button').forEach((button, index) => {
      button.setAttribute('role', 'menuitem');
      const label = document.createElement('span');
      label.textContent = button.textContent;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', iconPaths[index]);
      icon.append(path);
      button.replaceChildren(icon, label);
      if (index === 1) button.classList.add('message-selection-actions__group-start');
    });
    this.root.append(bar);
    this.selectionBar = bar;
    const mouse = event as MouseEvent;
    const rect =
      typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : body.getBoundingClientRect();
    const x = mouse.clientX || rect.left;
    const y = mouse.clientY || rect.bottom;
    bar.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bar.offsetWidth - 8))}px`;
    bar.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bar.offsetHeight - 8))}px`;
    copy.focus({ preventScroll: true });
  };
  private readonly dismissSelection = (event?: Event) => {
    if (event && this.selectionBar && event.composedPath().includes(this.selectionBar)) return;
    this.selectionBar?.remove();
    this.selectionBar = null;
  };
  private readonly selectionKey = (event: KeyboardEvent) => {
    if (!this.selectionBar) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      this.dismissSelection();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(this.selectionBar.querySelectorAll('button'));
    const current = items.findIndex(item => event.composedPath().includes(item));
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  reset(scope: string) {
    if (scope !== this.scope) {
      this.scope = scope;
      this.preferences.clear();
      this.toolOpen.clear();
      this.dismissSelection();
      this.close();
    }
  }
  close(): boolean {
    if (!this.dialog) return false;
    this.dialog.remove();
    this.dialog = null;
    if (this.dialogTrigger?.isConnected) this.dialogTrigger.focus();
    this.dialogTrigger = null;
    return true;
  }
  private button(key: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = i18nService.t(key);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  }
  private iconButton(key: string, pathData: string, action: () => void) {
    const button = this.button(key, action);
    button.classList.add('message-icon-button');
    button.dataset.iconOnly = 'true';
    button.title = i18nService.t(key);
    button.setAttribute('aria-label', button.title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
    button.replaceChildren(svg);
    return button;
  }
  private copyFeedback(button: HTMLButtonElement, key: string) {
    if (!button.isConnected) return;
    if (button.dataset.iconOnly) {
      button.title = i18nService.t(key);
      button.setAttribute('aria-label', button.title);
    } else button.textContent = i18nService.t(key);
  }
  private copy(button: HTMLButtonElement, text: string) {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        this.copyFeedback(button, 'copied');
      })
      .catch(() => {
        this.copyFeedback(button, 'messageCopyFailed');
      });
  }
  private expand(source: HTMLElement) {
    this.close();
    this.dialogTrigger = (
      this.root instanceof ShadowRoot ? this.root.activeElement : document.activeElement
    ) as HTMLElement | null;
    const dialog = document.createElement('dialog');
    dialog.className = 'message-reader-dialog markdown-content';
    const mermaid = source.classList.contains('mermaid-block');
    const closeAction = () => {
      this.close();
      source.focus();
    };
    const close = mermaid
      ? this.iconButton('messageClose', 'M6 6l12 12 M18 6L6 18', closeAction)
      : this.button('messageClose', closeAction);
    const content = source.cloneNode(true) as HTMLElement;
    content.querySelectorAll('button').forEach(button => button.remove());
    content.classList.add('is-expanded');
    dialog.append(close, content);
    dialog.addEventListener('click', event => {
      const anchor = (event.target as Element).closest('a');
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const href = anchor.getAttribute('href');
      this.close();
      const original = Array.from(source.querySelectorAll('a')).find(
        link => link.getAttribute('href') === href,
      );
      original?.click();
    });
    dialog.addEventListener('cancel', () => this.close());
    if (mermaid) {
      dialog.classList.add('message-mermaid-dialog');
      close.classList.add('message-mermaid-close');
      const svg = content.querySelector('svg');
      content.replaceChildren(...(svg ? [svg] : []));
      content.className = 'message-mermaid-viewport';
      let scale = 1,
        x = 0,
        y = 0;
      let drag: { id: number; x: number; y: number } | null = null;
      const apply = () => {
        if (svg) {
          svg.style.transformOrigin = '0 0';
          svg.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
        }
      };
      content.addEventListener(
        'wheel',
        event => {
          event.preventDefault();
          const next = Math.min(
            5,
            Math.max(0.2, scale * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.04 : 0.002))),
          );
          const rect = content.getBoundingClientRect();
          const px = event.clientX - rect.left,
            py = event.clientY - rect.top;
          x = px - ((px - x) * next) / scale;
          y = py - ((py - y) * next) / scale;
          scale = next;
          apply();
        },
        { passive: false },
      );
      content.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
        content.setPointerCapture(event.pointerId);
        content.classList.add('is-dragging');
      });
      content.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        x += event.clientX - drag.x;
        y += event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        apply();
      });
      const stop = () => {
        drag = null;
        content.classList.remove('is-dragging');
      };
      content.addEventListener('pointerup', stop);
      content.addEventListener('pointercancel', stop);
      content.addEventListener('lostpointercapture', stop);
    }
    this.root.append(dialog);
    this.dialog = dialog;
    dialog.showModal();
  }
  private tree(source: string, node: JsonSourceNode): HTMLElement {
    if (!node.children) {
      const row = document.createElement('div');
      row.textContent = `${node.label}: ${source.slice(node.start, node.end)}`;
      return row;
    }
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${node.label} ${source[node.start]}…${source[node.end - 1]} (${node.children.length})`;
    details.append(summary);
    let loaded = false;
    details.addEventListener('toggle', () => {
      if (!details.open || loaded) return;
      loaded = true;
      const children = document.createElement('div');
      children.className = 'message-json-children';
      let offset = 0;
      const more = this.button('messageNext', () => append());
      const append = () => {
        for (const child of node.children!.slice(offset, offset + 100))
          children.insertBefore(this.tree(source, child), more);
        offset += 100;
        more.hidden = offset >= node.children!.length;
      };
      children.append(more);
      append();
      details.append(children);
    });
    return details;
  }
  sync() {
    if (!this.onQuote) this.dismissSelection();
    this.root
      .querySelectorAll<HTMLDetailsElement>('details[data-tool-identity]')
      .forEach(details => {
        const open = this.toolOpen.has(details.dataset.toolIdentity!);
        if (details.open !== open) details.open = open;
      });
    this.root.querySelectorAll<HTMLElement>('.markdown-plain-text-fallback').forEach(block => {
      if (block.dataset.readerReady || (block.textContent?.length ?? 0) <= 40_000) return;
      const reader = document.createElement('justdo-tool-output') as ToolOutput;
      reader.text = block.textContent ?? '';
      block.replaceChildren(reader);
      block.dataset.readerReady = 'true';
    });
    const blocks = this.root.querySelectorAll<HTMLElement>(
      '.code-block-wrapper, .markdown-table-scroll',
    );
    blocks.forEach((block, index) => {
      if (block.dataset.readerReady) return;
      block.dataset.readerReady = 'true';
      const group = block.closest<HTMLElement>('[data-group-key], [data-inline-process-id]');
      const siblings = group
        ? Array.from(group.querySelectorAll('.code-block-wrapper, .markdown-table-scroll'))
        : [];
      const key = `${group?.dataset.groupKey ?? group?.dataset.inlineProcessId ?? 'message'}:${group ? siblings.indexOf(block) : index}`;
      const preference = this.preferences.get(key) ?? {};
      const save = () => {
        this.preferences.set(key, preference);
        if (this.preferences.size > 1000)
          this.preferences.delete(this.preferences.keys().next().value!);
      };
      const actions = document.createElement('div');
      actions.className = 'message-reader-actions';
      const table = block.querySelector('table');
      if (table) {
        const copy = this.button('messageCopyTsv', () => this.copy(copy, tableToTsv(table)));
        actions.append(
          copy,
          this.button('messageExpand', () => this.expand(block)),
        );
        block.prepend(actions);
        return;
      }
      const code = block.querySelector('code');
      const raw =
        block.querySelector<HTMLElement>('.code-block-copy')?.dataset.code ??
        code?.textContent ??
        '';
      const mermaid = block.classList.contains('mermaid-block');
      block.querySelector('.code-block-copy')?.remove();
      const copy = this.iconButton('copy', 'M9 9h11v11H9z M15 9V4H4v11h5', () =>
        this.copy(copy, raw),
      );
      actions.append(copy);
      if (mermaid) {
        actions.append(
          this.iconButton('messageExpand', 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5', () =>
            this.expand(block),
          ),
        );
      } else {
        const apply = () => {
          block.classList.toggle('is-wrapped', preference.wrap === true);
          block.classList.toggle('is-expanded', preference.expanded === true);
        };
        actions.append(
          this.iconButton(
            'messageWrap',
            'M3 6h18 M3 11h14a4 4 0 0 1 0 8h-5 M15 16l-3 3 3 3 M3 16h4',
            () => {
              this.preserve(block);
              preference.wrap = !preference.wrap;
              save();
              apply();
            },
          ),
          this.iconButton('messageToggleExpand', 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5', () => {
            this.preserve(block);
            preference.expanded = !preference.expanded;
            save();
            apply();
          }),
        );
        apply();
        const parsed = parseJsonSource(raw);
        if (parsed) {
          const tree = this.tree(raw, parsed);
          tree.classList.add('message-json-tree');
          const pre = code?.closest('pre');
          const applyTree = () => {
            tree.hidden = !preference.tree;
            if (pre) pre.hidden = preference.tree === true;
          };
          actions.append(
            this.iconButton(
              'messageJsonView',
              'M9 3H5v18h4 M15 3h4v18h-4 M9 8h6 M9 12h6 M9 16h6',
              () => {
                this.preserve(block);
                preference.tree = !preference.tree;
                save();
                applyTree();
              },
            ),
          );
          block.append(tree);
          applyTree();
        }
      }
      actions.append(
        mermaid
          ? this.iconButton('messageDownload', 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5', () =>
              downloadText(raw, 'diagram.mmd'),
            )
          : this.iconButton('messageDownload', 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5', () =>
              downloadText(raw, 'code.txt'),
            ),
      );
      block.querySelector('.code-block-header')?.append(actions);
    });
  }
}
