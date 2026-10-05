import { Bars3BottomLeftIcon, ChevronUpIcon, EyeIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useId, useState } from 'react';

import type { QueuedInputCard, QueuedInputDetail } from '@/libs/openclaw-chat/gateway/chat-pending-inputs';
import { i18nService } from '@/services/i18n';

import { QueuedInputMessage } from './QueuedInputMessage';

export function QueuedInputCards({
  items,
  onWithdraw,
  getDetail,
  workingDirectory,
}: {
  items: QueuedInputCard[];
  onWithdraw: (id: string) => Promise<void>;
  workingDirectory?: string;
  getDetail?: (id: string) => QueuedInputDetail | null;
}) {
  const [withdrawing, setWithdrawing] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const detailId = useId();
  const expanded = items.find(item => item.id === expandedId);
  const detail = expanded && getDetail ? getDetail(expanded.id) : null;
  if (!items.length) return null;

  const withdraw = async (id: string) => {
    if (withdrawing.has(id)) return;
    setWithdrawing(current => new Set(current).add(id));
    try {
      await onWithdraw(id);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setWithdrawing(current => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <section
      aria-label={i18nService.t('coworkQueuedInputs')}
      className="relative mx-3 -mb-3 overflow-hidden rounded-t-2xl border border-b-0 border-border bg-surface-raised pb-3"
    >
      <div className="sr-only" role="status">
        {i18nService.t('coworkQueuedInputsCount').replace('{count}', String(items.length))}
      </div>
      <ul className="max-h-36 divide-y divide-border/50 overflow-y-auto px-2">
        {items.map(item => (
          <li key={item.id} className="flex min-h-9 min-w-0 items-center gap-2 px-1.5">
            <Bars3BottomLeftIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded py-1.5 text-left text-[13px] font-medium text-foreground focus-visible:outline-primary"
              title={i18nService.t('coworkQueueView')}
              aria-expanded={expandedId === item.id}
              aria-controls={expandedId === item.id ? detailId : undefined}
              onClick={() => setExpandedId(current => current === item.id ? null : item.id)}
            >
              {item.text || i18nService.t('coworkQueuedAttachment')}
            </button>
            <button
              type="button"
              aria-label={i18nService.t(expandedId === item.id ? 'coworkQueueCollapse' : 'coworkQueueView')}
              title={i18nService.t(expandedId === item.id ? 'coworkQueueCollapse' : 'coworkQueueView')}
              aria-expanded={expandedId === item.id}
              aria-controls={expandedId === item.id ? detailId : undefined}
              onClick={() => setExpandedId(current => current === item.id ? null : item.id)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-primary"
            >
              {expandedId === item.id
                ? <ChevronUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
                : <EyeIcon className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            {item.canWithdraw && (
              <button
                type="button"
                onClick={() => void withdraw(item.id)}
                disabled={withdrawing.has(item.id)}
                aria-label={i18nService.t('coworkQueueWithdraw')}
                title={i18nService.t('coworkQueueWithdraw')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-primary disabled:opacity-40"
              >
                <TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {expanded && (
        <div
          id={detailId}
          role="region"
          aria-label={i18nService.t('coworkQueueView')}
          tabIndex={0}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              const section = event.currentTarget.closest('section');
              setExpandedId(null);
              section?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
            }
          }}
          className="max-h-64 overflow-y-auto border-t border-border px-3 py-3 text-sm text-foreground focus-visible:outline-primary"
        >
          {!detail ? (
            <p className="text-xs text-secondary">{i18nService.t('coworkQueueDetailUnavailable')}</p>
          ) : (
            <>
              {detail.truncated && <p role="status" className="mb-2 text-xs text-secondary">{i18nService.t('coworkQueueDetailTruncated')}</p>}
              <QueuedInputMessage key={expanded.id} message={detail.message} workingDirectory={workingDirectory} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
