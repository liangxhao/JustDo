// Chat copy-as-markdown button component.
// Adapted from OpenClaw ui/src/ui/chat/copy-as-markdown.ts
import { html, type TemplateResult } from 'lit';

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
const COPY_LABEL = 'Copy as markdown';
const COPIED_LABEL = 'Copied';
const ERROR_LABEL = 'Copy failed';

// Clipboard copy helper with fallback for non-secure contexts.
async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand path
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

function setButtonLabel(button: HTMLButtonElement, label: string) {
  button.title = label;
  button.setAttribute('aria-label', label);
}

function createCopyButton(options: { text: () => string; label?: string }): TemplateResult {
  const idleLabel = options.label ?? COPY_LABEL;
  return html`
    <button
      class="btn btn--xs chat-copy-btn"
      type="button"
      title=${idleLabel}
      aria-label=${idleLabel}
      @click=${async (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement | null;
        if (!btn || btn.dataset.copying === '1') return;

        btn.dataset.copying = '1';
        btn.setAttribute('aria-busy', 'true');
        btn.disabled = true;

        const copied = await copyToClipboard(options.text());
        if (!btn.isConnected) return;

        delete btn.dataset.copying;
        btn.removeAttribute('aria-busy');
        btn.disabled = false;

        if (!copied) {
          btn.dataset.error = '1';
          setButtonLabel(btn, ERROR_LABEL);
          window.setTimeout(() => {
            if (!btn.isConnected) return;
            delete btn.dataset.error;
            setButtonLabel(btn, idleLabel);
          }, ERROR_FOR_MS);
          return;
        }

        btn.dataset.copied = '1';
        setButtonLabel(btn, COPIED_LABEL);
        window.setTimeout(() => {
          if (!btn.isConnected) return;
          delete btn.dataset.copied;
          setButtonLabel(btn, idleLabel);
        }, COPIED_FOR_MS);
      }}
    >
      <span class="chat-copy-btn__icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </span>
      <span class="chat-copy-btn__icon-check" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </span>
    </button>
  `;
}

export function renderCopyButton(text: string, label = COPY_LABEL): TemplateResult {
  return createCopyButton({ text: () => text, label });
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return renderCopyButton(markdown, COPY_LABEL);
}
