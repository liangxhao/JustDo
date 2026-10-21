import mermaid from 'mermaid';
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';

import { renderMermaidSvg } from '@/libs/openclaw-chat/components/markdown/mermaidRenderer';
import { i18nService } from '@/services/i18n';
import { useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

interface PreviewMarkdownProps {
  html: string;
  mermaidIdPrefix: string;
}

const COPY_FEEDBACK_DURATION_MS = 1300;

const PreviewMarkdown = ({ html, mermaidIdPrefix }: PreviewMarkdownProps) => {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const rootRef = useRef<HTMLElement>(null);
  const copyFeedbackTimersRef = useRef(new WeakMap<HTMLButtonElement, number>());
  const [isDark, setIsDark] = useState(() =>
    ownerDocument.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(ownerDocument.documentElement.classList.contains('dark'));
    });
    observer.observe(ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, [ownerDocument]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    root.querySelectorAll<HTMLButtonElement>('.code-block-copy').forEach(button => {
      const label = i18nService.t('copyToClipboard');
      button.setAttribute('aria-label', label);
      button.title = label;
    });

    let cancelled = false;
    const renderDiagrams = async () => {
      const blocks = root.querySelectorAll<HTMLElement>('.mermaid-block');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDark ? 'dark' : 'default',
      });

      for (const block of blocks) {
        const target = block.querySelector<HTMLElement>('.mermaid-preview');
        const source = block.querySelector<HTMLElement>('.mermaid-source code')?.textContent;
        if (!target || !source) continue;
        try {
          const id = `${mermaidIdPrefix}-${crypto.randomUUID()}`;
          const svg = await renderMermaidSvg(id, source, target);
          if (!cancelled) target.innerHTML = svg;
        } catch (error) {
          if (cancelled) return;
          target.classList.add('mermaid-error');
          target.textContent =
            error instanceof Error ? error.message : i18nService.t('mermaidRenderFailed');
        }
      }
    };

    void renderDiagrams();
    return () => {
      cancelled = true;
    };
  }, [html, isDark, mermaidIdPrefix]);

  const handleClick = useCallback(
    async (event: MouseEvent<HTMLElement>) => {
      const copyButton = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '.code-block-copy',
      );
      if (copyButton) {
        const code = copyButton.dataset.code;
        if (code === undefined) return;
        await ownerWindow.navigator.clipboard.writeText(code);
        const activeTimer = copyFeedbackTimersRef.current.get(copyButton);
        if (activeTimer !== undefined) window.clearTimeout(activeTimer);
        const copiedLabel = i18nService.t('copied');
        const copyLabel = i18nService.t('copyToClipboard');
        copyButton.classList.add('copied');
        copyButton.setAttribute('aria-label', copiedLabel);
        copyButton.title = copiedLabel;
        const timer = window.setTimeout(() => {
          copyButton.classList.remove('copied');
          copyButton.setAttribute('aria-label', copyLabel);
          copyButton.title = copyLabel;
          copyFeedbackTimersRef.current.delete(copyButton);
        }, COPY_FEEDBACK_DURATION_MS);
        copyFeedbackTimersRef.current.set(copyButton, timer);
        return;
      }

      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.mermaid-toggle');
      if (!target) return;
      const block = target.closest<HTMLElement>('.mermaid-block');
      if (!block) return;
      const showSource = !block.classList.contains('is-source');
      block.classList.toggle('is-source', showSource);
      const diagram = block.querySelector<HTMLElement>('.mermaid-preview');
      const source = block.querySelector<HTMLElement>('.mermaid-source');
      const label = block.querySelector<HTMLElement>('.code-block-lang');
      if (diagram) diagram.hidden = showSource;
      if (source) source.hidden = !showSource;
      if (label) label.textContent = showSource ? 'mermaid' : 'mermaid (rendered)';
      const buttonLabel = i18nService.t(showSource ? 'renderDiagram' : 'showCode');
      target.setAttribute('aria-label', buttonLabel);
      target.title = buttonLabel;
    },
    [ownerWindow],
  );

  return (
    <article
      ref={rootRef}
      className="file-preview-markdown"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default PreviewMarkdown;
