import DOMPurify from 'dompurify';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown/markdown';
import { i18nService } from '@/services/i18n';

function renderStaticSummary(content: string): string {
  const document = new DOMParser().parseFromString(
    toSanitizedMarkdownHtml(content, { fileLinks: false }),
    'text/html',
  );
  // A receipt preview shows formatted content without chat controls or media.
  document
    .querySelectorAll('.code-block-header, .mermaid-preview, button, input, img')
    .forEach(node => node.remove());
  return DOMPurify.sanitize(document.body.innerHTML, {
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
}

export default function ResultSummary({
  content,
  className = '',
}: {
  content: string;
  className?: string;
}) {
  const html = useMemo(() => renderStaticSummary(content), [content]);
  const previewRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview || expanded) return;
    const measure = () => setCanExpand(preview.scrollHeight > preview.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [html, expanded]);

  if (!html) return null;
  return (
    <div className={className}>
      <div
        ref={previewRef}
        className={`prose prose-sm min-w-0 max-w-none text-sm leading-6 text-foreground/85 [overflow-wrap:anywhere] dark:prose-invert prose-headings:my-2 prose-headings:text-sm prose-headings:font-semibold prose-headings:leading-6 prose-headings:text-foreground prose-p:my-1.5 prose-strong:text-foreground prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-surface-raised prose-pre:p-3 prose-pre:text-xs [&>_:first-child]:mt-0 [&>_:last-child]:mb-0 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto ${expanded ? '' : 'max-h-32 overflow-hidden'}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {canExpand && (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-primary hover:text-primary-hover"
          aria-expanded={expanded}
          onClick={event => {
            event.stopPropagation();
            setExpanded(value => !value);
          }}
        >
          {i18nService.t(
            expanded
              ? 'scheduledTasksResultsCollapseSummary'
              : 'scheduledTasksResultsExpandSummary',
          )}
        </button>
      )}
    </div>
  );
}
