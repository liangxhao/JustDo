import { ChatBubbleBottomCenterTextIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { TeamDiscussionMessage } from '@shared/cowork/agent-team/teamDiscussion';

import { i18nService } from '@/services/i18n';

export default function TeamDiscussionQuoteCard({
  message,
  name,
  disabled,
  onRemove,
}: {
  message?: TeamDiscussionMessage;
  name?: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const preview = message
    ? message.text.trim() ||
      i18nService.t(message.mediaUrls.length ? 'teamQuoteAttachment' : 'teamQuoteNoText')
    : i18nService.t('teamQuoteNotLoaded');
  const removeLabel = `${i18nService.t('messageQuoteRemove')}${name ? ` · ${name}` : ''}`;

  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-border border-l-[3px] border-l-primary bg-surface px-3 py-2.5 text-left shadow-subtle dark:border-[color-mix(in_srgb,var(--justdo-border)_85%,var(--justdo-foreground))] dark:border-l-primary dark:bg-[color-mix(in_srgb,var(--justdo-surface-raised)_92%,var(--justdo-foreground))]">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
        <ChatBubbleBottomCenterTextIcon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
          <span className="shrink-0 text-secondary">{i18nService.t('messageQuoteLabel')}</span>
          {name && (
            <>
              <span className="text-muted" aria-hidden="true">
                ·
              </span>
              <span className="truncate font-medium text-foreground" title={name}>
                {name}
              </span>
            </>
          )}
        </div>
        <blockquote
          className="m-0 mt-1 line-clamp-2 whitespace-pre-line border-0 p-0 text-[13px] not-italic leading-5 text-foreground [overflow-wrap:anywhere]"
          title={preview}
        >
          {preview}
        </blockquote>
      </div>
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        disabled={disabled}
        onClick={onRemove}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
      >
        <XMarkIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
