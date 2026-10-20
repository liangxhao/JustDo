import './TeamDiscussionMessage.css';

import type { TeamDiscussionMessage as DiscussionMessage } from '../../../contracts/teamDiscussion';

import { toSanitizedMarkdownHtml } from '../ui';
import { i18nService } from '../ui';

import { ChatAvatar } from '../ui';
import { PreviewMarkdown } from '../ui';

export default function TeamDiscussionMessage({
  message,
  name,
  color,
  quoteDisabled,
  onQuote,
  onOpenAgent,
  onReply,
}: {
  message: DiscussionMessage;
  name: string;
  color?: string;
  quoteDisabled: boolean;
  onQuote: () => void;
  onOpenAgent?: () => void;
  onReply?: () => void;
}) {
  const isUser = message.role === 'user';
  return (
    <article
      data-discussion-message={message.id}
      data-message-role={message.role}
      className={`flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}
    >
      <button
        type="button"
        disabled={!onOpenAgent}
        onClick={onOpenAgent}
        aria-label={`${i18nService.t('teamInspectAgent')} · ${name}`}
        className="shrink-0 rounded-full enabled:hover:ring-2 enabled:hover:ring-primary focus-visible:outline focus-visible:outline-2"
      >
        <ChatAvatar
          role={message.role}
          peer={isUser ? undefined : { id: message.agentId ?? name, label: name, color }}
        />
      </button>
      <div className={`min-w-0 flex-1 ${isUser ? 'flex flex-col items-end pl-6' : 'pr-6'}`}>
        <div
          className={`team-discussion-message-content ${
            isUser
              ? 'team-discussion-message-content--user w-fit max-w-full overflow-hidden rounded-xl rounded-br bg-chat-user px-3.5 py-2.5 text-sm text-chat-user-fg dark:rounded-[20px] dark:px-4 [overflow-wrap:anywhere]'
              : 'pt-1 text-sm [overflow-wrap:anywhere]'
          }`}
        >
          <PreviewMarkdown
            html={toSanitizedMarkdownHtml(message.text)}
            mermaidIdPrefix={`team-${message.id}`}
          />
          {message.mediaUrls.map(url => (
            <p key={url} className={`break-all text-xs ${isUser ? 'text-inherit' : 'text-secondary'}`}>
              {url}
            </p>
          ))}
        </div>
        <div
          className={`mt-1 flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary ${isUser ? 'justify-end' : ''}`}
        >
          <span className="max-w-40 truncate font-medium" title={name}>
            {name}
          </span>
          <time dateTime={new Date(message.timestamp).toISOString()}>
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <button
            type="button"
            className="rounded px-1.5 py-1 hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-40"
            disabled={quoteDisabled}
            onClick={onQuote}
          >
            {i18nService.t('teamQuote')}
          </button>
          {!isUser && onReply && (
            <button
              type="button"
              className="rounded px-1.5 py-1 hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-40"
              disabled={quoteDisabled}
              onClick={onReply}
              aria-label={`${i18nService.t('teamReplyToAgent')} · ${name}`}
            >
              {i18nService.t('teamReplyToAgent')}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
