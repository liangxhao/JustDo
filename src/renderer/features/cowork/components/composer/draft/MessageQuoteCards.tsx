import { i18nService } from '@/services/i18n';

import { MESSAGE_QUOTE_KIND, type MessageQuote } from './messageQuote';

function quoteLabel(quote: MessageQuote): string {
  const key =
    quote.kind === MESSAGE_QUOTE_KIND.EXTENSION
      ? quote.labelKey
      : quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION
        ? 'extensionDiscussionReference'
        : quote.kind === MESSAGE_QUOTE_KIND.COLLABORATION
          ? 'extensionCollaborationReference'
          : undefined;
  if (key) {
    const label = i18nService.t(key);
    if (label !== key) return label;
  }
  return i18nService.t('messageQuoteLabel');
}

export default function MessageQuoteCards({
  quotes,
  onRemove,
}: {
  quotes: readonly MessageQuote[];
  onRemove: (id: string) => void;
}) {
  if (!quotes.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {quotes.map(quote => (
        <div
          key={quote.id}
          className="max-w-full rounded-lg border border-border px-3 py-2 text-sm"
        >
          <div className="flex items-center gap-2">
            <span>{quoteLabel(quote)}</span>
            <button
              type="button"
              aria-label={i18nService.t('messageQuoteRemove')}
              onClick={() => onRemove(quote.id)}
            >
              ×
            </button>
          </div>
          <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap">
            {quote.text}
          </blockquote>
        </div>
      ))}
    </div>
  );
}
