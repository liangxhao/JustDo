import { i18nService } from '@/services/i18n';

import { MESSAGE_QUOTE_KIND, type MessageQuote } from './messageQuote';

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
            <span>
              {i18nService.t(
                quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION
                  ? 'teamDiscussionReference'
                  : quote.kind === MESSAGE_QUOTE_KIND.COLLABORATION
                    ? 'teamCollaborationReference'
                    : 'messageQuoteLabel',
              )}
            </span>
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
