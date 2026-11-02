import DOMPurify from 'dompurify';
import { useId, useMemo, useState } from 'react';

import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown/markdown';
import { i18nService } from '@/services/i18n';

const SUMMARY_PREVIEW_LENGTH = 240;

function renderStaticSummary(content: string): { html: string; preview: string } {
  const document = new DOMParser().parseFromString(
    toSanitizedMarkdownHtml(content, { fileLinks: false }),
    'text/html',
  );
  // A receipt preview shows formatted content without chat controls or media.
  document
    .querySelectorAll('.code-block-header, .mermaid-preview, button, input, img')
    .forEach(node => node.remove());
  const html = DOMPurify.sanitize(document.body.innerHTML, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      's',
      'del',
      'blockquote',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'hr',
    ],
    ALLOWED_ATTR: [],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  });
  const previewDocument = new DOMParser().parseFromString(html, 'text/html');
  previewDocument.querySelectorAll('br, hr').forEach(node => node.replaceWith(' '));
  previewDocument
    .querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, th, td, tr, pre, blockquote')
    .forEach(node => node.append(' '));
  const characters = Array.from(
    (previewDocument.body.textContent ?? '').replace(/\s+/gu, ' ').trim(),
  );
  const preview =
    characters.length > SUMMARY_PREVIEW_LENGTH
      ? `${characters.slice(0, SUMMARY_PREVIEW_LENGTH).join('').trimEnd()}…`
      : characters.join('');
  return { html, preview };
}

export default function ResultSummary({
  content,
  className = '',
}: {
  content: string;
  className?: string;
}) {
  const summary = useMemo(() => renderStaticSummary(content), [content]);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);

  if (!summary.preview) return null;
  return (
    <div className={className}>
      <div id={contentId}>
        {expanded ? (
          <div
            className="prose prose-sm min-w-0 max-w-none text-[13px] leading-6 text-foreground/85 [overflow-wrap:anywhere] dark:prose-invert prose-headings:my-2 prose-headings:text-sm prose-headings:font-semibold prose-headings:leading-6 prose-headings:text-foreground prose-p:my-1.5 prose-strong:text-foreground prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-surface-raised prose-pre:p-3 prose-pre:text-xs [&>_:first-child]:mt-0 [&>_:last-child]:mb-0 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:[overflow-wrap:normal] [&_th]:min-w-24 [&_td]:min-w-24"
            dangerouslySetInnerHTML={{ __html: summary.html }}
          />
        ) : (
          <p className="line-clamp-3 text-[13px] leading-6 text-foreground/85 [overflow-wrap:anywhere]">
            {summary.preview}
          </p>
        )}
      </div>
      <button
        type="button"
        className="mt-3 text-xs text-secondary transition-colors hover:text-primary"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={event => {
          event.stopPropagation();
          setExpanded(value => !value);
        }}
      >
        {i18nService.t(
          expanded ? 'scheduledTasksResultsCollapseSummary' : 'scheduledTasksResultsExpandSummary',
        )}
      </button>
    </div>
  );
}
